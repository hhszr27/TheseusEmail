import { Worker } from 'node:worker_threads';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db/open';
import type { SecretStore } from '../mail/auth/token-store';
import type {
  CalendarAccountInput,
  CalendarAccountView,
  CalendarEventDeleteRequest,
  CalendarEventInput,
  CalendarEventKind,
  CalendarEventPatch,
  CalendarEventView,
  CalendarRecurrence,
  CalendarSyncResult,
} from '../../shared/ipc';
import { buildIcs, expandRecurrence, type IcsEvent, type RecurrenceRule } from './ics';
import { log } from '../observability/logger';
import { recordMetric } from '../observability/metrics';
import type {
  CalendarWorkerCommand,
  CalendarWorkerEvent,
  CalendarWorkerResponse,
  CalendarWriteCommand,
} from './protocol';

/**
 * 日历账户与事件持久化（§16.2 / §16.3）。
 * 网络与 ICS 解析在独立 worker 中完成；主进程只写库。
 */

/**
 * 本地新建事件的归属日历：不对应任何账户，也不参与同步，
 * 所以 `events()` 必须用 LEFT JOIN 才读得到（见下方查询）。
 */
export const LOCAL_CALENDAR_ID = 'local';

interface AccountRow {
  id: string;
  kind: 'caldav' | 'ics';
  name: string;
  url: string;
  username: string | null;
  secret_ref: string | null;
  color: string | null;
  read_only: number;
  ctag: string | null;
  sync_token: string | null;
  last_sync_at: number;
  last_error: string | null;
  enabled: number;
}

interface EventRow {
  id: string;
  calendar_id: string;
  uid: string | null;
  etag: string | null;
  summary: string | null;
  starts_at: number | null;
  ends_at: number | null;
  all_day: number;
  data_json: string;
}

/** `calendar_events.data_json` 的内容（本地事件才有 kind/rrule/local）。 */
interface EventData {
  kind?: CalendarEventKind;
  location?: string | null;
  description?: string | null;
  rrule?: CalendarRecurrence;
  /** 被单独排除的实例开始时间（对应 ICS 的 EXDATE）。 */
  exdates?: number[];
  href?: string;
  local?: boolean;
}

function workerScriptPath(): string {
  return path.join(__dirname, 'calendar-worker.js');
}

function toView(row: AccountRow): CalendarAccountView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: row.url,
    username: row.username,
    color: row.color,
    readOnly: row.read_only === 1,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    enabled: row.enabled === 1,
  };
}

export class CalendarService {
  private readonly running = new Map<string, Promise<CalendarSyncResult>>();

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly onChange: () => void = () => undefined,
  ) {}

  list(): CalendarAccountView[] {
    const rows = this.db
      .prepare('SELECT * FROM calendar_accounts ORDER BY created_at ASC')
      .all() as AccountRow[];
    return rows.map(toView);
  }

  get(id: string): AccountRow | null {
    const row = this.db.prepare('SELECT * FROM calendar_accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined;
    return row ?? null;
  }

  async add(input: CalendarAccountInput): Promise<CalendarAccountView> {
    const id = `cal-${crypto.randomBytes(6).toString('hex')}`;
    // CalDAV 可写（本地事件要写回服务器）；ICS 订阅只是一个 .ics 文件，永远只读
    const readOnly = input.kind === 'ics' ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO calendar_accounts
           (id, kind, name, url, username, secret_ref, color, read_only, last_sync_at, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
      )
      .run(
        id,
        input.kind,
        input.name.slice(0, 80),
        input.url,
        input.username ?? null,
        input.kind === 'caldav' && input.password ? `calendar:${id}` : null,
        input.color ?? null,
        readOnly,
        Date.now(),
      );

    if (input.kind === 'caldav' && input.password) {
      await this.secrets.set(`calendar:${id}`, input.password);
    }

    const row = this.get(id)!;
    this.onChange();
    return toView(row);
  }

  async remove(id: string): Promise<boolean> {
    const row = this.get(id);
    if (!row) return false;
    this.db.prepare('DELETE FROM calendar_events WHERE calendar_id = ?').run(id);
    this.db.prepare('DELETE FROM calendar_outbox WHERE account_id = ?').run(id);
    this.db.prepare('DELETE FROM calendar_accounts WHERE id = ?').run(id);
    if (row.secret_ref) await this.secrets.delete(row.secret_ref);
    this.onChange();
    return true;
  }

  /** 第一个可写的 CalDAV 账户；没有就只能存本机。ICS 订阅永远不可写。 */
  private writableAccount(): AccountRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM calendar_accounts
          WHERE enabled = 1 AND kind = 'caldav' AND read_only = 0
          ORDER BY created_at ASC
          LIMIT 1`,
      )
      .get() as AccountRow | undefined;
    return row ?? null;
  }

  private hrefFor(account: AccountRow, uid: string): string {
    return `${account.url.replace(/\/+$/, '')}/${uid}.ics`;
  }

  private parseData(raw: string): EventData {
    try {
      return JSON.parse(raw) as EventData;
    } catch {
      return {};
    }
  }

  /** 把系列行展开成实例开始时间（用于找「下一次」）。 */
  private occurrences(row: EventRow, data: EventData, windowEnd: number): number[] {
    const rrule = data.rrule;
    if (!rrule) return [];
    return expandRecurrence(
      {
        uid: row.uid ?? '',
        summary: row.summary ?? '',
        startsAt: row.starts_at ?? 0,
        endsAt: row.ends_at ?? row.starts_at ?? 0,
        allDay: row.all_day === 1,
        exdates: data.exdates ?? [],
        rrule: {
          freq: rrule.freq,
          interval: Math.max(1, rrule.interval ?? 1),
          ...(rrule.until !== undefined ? { until: rrule.until } : {}),
        },
      },
      windowEnd,
      500,
    ).map((instance) => instance.startsAt);
  }

  private nextOccurrenceAfter(row: EventRow, data: EventData, after: number): number | null {
    const starts = this.occurrences(row, data, after + 366 * 24 * 60 * 60 * 1000);
    return starts.find((start) => start > after) ?? null;
  }

  /** 写回用的 ICS 事件：rrule 必须带上，否则服务器上只剩单次。 */
  private toIcsEvent(input: {
    uid: string;
    summary: string;
    startsAt: number;
    endsAt: number;
    allDay: boolean;
    rrule?: CalendarRecurrence;
    location?: string;
    description?: string;
    exdates?: number[];
  }): IcsEvent {
    return {
      uid: input.uid,
      summary: input.summary,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay,
      ...(input.location ? { location: input.location } : {}),
      ...(input.description ? { description: input.description } : {}),
      ...(input.rrule
        ? {
            rrule: {
              freq: input.rrule.freq,
              interval: Math.max(1, input.rrule.interval ?? 1),
            } as RecurrenceRule,
          }
        : {}),
      exdates: input.exdates ?? [],
    };
  }

  /** 只有本机创建的事件能改/删；远程同步来的行没有 `local` 标记。 */
  private isLocalCreated(row: EventRow, data: { local?: boolean }): boolean {
    return row.calendar_id === LOCAL_CALENDAR_ID || data.local === true;
  }

  /**
   * 新建事件：有可写 CalDAV 账户时同时写回服务器（PUT + 离线队列），
   * 没有就只存本机。
   */
  createEvent(input: CalendarEventInput): CalendarEventView {
    const summary = input.summary.trim().slice(0, 200) || '（无标题）';
    const startsAt = Math.round(Number(input.startsAt));
    const allDay = input.allDay === true;
    const fallbackEnd = allDay ? startsAt + 24 * 60 * 60 * 1000 : startsAt + 60 * 60 * 1000;
    const requestedEnd = Number(input.endsAt);
    const endsAt = Number.isFinite(requestedEnd) ? Math.max(requestedEnd, startsAt) : fallbackEnd;
    const kind: CalendarEventKind = input.kind;
    const rrule = input.rrule;

    const uid = crypto.randomBytes(16).toString('hex');
    const account = this.writableAccount();
    const calendarId = account ? account.id : LOCAL_CALENDAR_ID;
    const href = account ? this.hrefFor(account, uid) : null;
    // 有 href 时用与同步一致的 id 规则，保证同步回来是同一行、而不是多出一条
    const id = href
      ? `${account!.id}|${href}|${startsAt}`
      : `local-${crypto.randomBytes(8).toString('hex')}`;

    this.db
      .prepare(
        `INSERT INTO calendar_events
           (id, calendar_id, uid, etag, summary, starts_at, ends_at, all_day, data_json)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        calendarId,
        uid,
        summary,
        startsAt,
        endsAt,
        allDay ? 1 : 0,
        JSON.stringify({
          kind,
          location: input.location ?? null,
          description: input.description ?? null,
          ...(rrule ? { rrule } : {}),
          ...(href ? { href } : {}),
          local: true,
        }),
      );

    if (account && href) {
      this.queueWrite(account.id, {
        method: 'PUT',
        href,
        payload: buildIcs([
          this.toIcsEvent({
            uid,
            summary,
            startsAt,
            endsAt,
            allDay,
            ...(rrule ? { rrule } : {}),
            ...(input.location ? { location: input.location } : {}),
            ...(input.description ? { description: input.description } : {}),
          }),
        ]),
      });
    }

    this.onChange();

    return {
      id,
      calendarId,
      uid,
      summary,
      startsAt,
      endsAt,
      allDay,
      kind,
      ...(rrule ? { rrule } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.description ? { description: input.description } : {}),
    };
  }

  /**
   * 修改本机创建的事件：同步更新本机行，并在有可写账户时重新 PUT。
   * 远程同步来的事件返回 null，由 IPC 层转成明确错误。
   */
  updateEvent(patch: CalendarEventPatch): CalendarEventView | null {
    const row = this.db
      .prepare('SELECT * FROM calendar_events WHERE id = ?')
      .get(patch.id) as EventRow | undefined;
    if (!row) return null;

    const data = this.parseData(row.data_json);
    if (!this.isLocalCreated(row, data)) return null;

    const summary = patch.summary.trim().slice(0, 200) || '（无标题）';
    const startsAt = Math.round(Number(patch.startsAt));
    const allDay = patch.allDay === true;
    const fallbackEnd = allDay ? startsAt + 24 * 60 * 60 * 1000 : startsAt + 60 * 60 * 1000;
    const requestedEnd = Number(patch.endsAt);
    const endsAt = Number.isFinite(requestedEnd) ? Math.max(requestedEnd, startsAt) : fallbackEnd;
    const kind: CalendarEventKind = patch.kind;
    const rrule = patch.rrule;

    // 重复事件的「仅此 / 此及后续」：把原系列截断或排除，再新建承载修改后的那段
    const scope = patch.scope;
    const occurrenceStart = patch.occurrenceStart;
    if (rrule && occurrenceStart !== undefined && (scope === 'this' || scope === 'thisAndFuture')) {
      const base = {
        kind,
        summary,
        startsAt,
        endsAt,
        allDay,
        ...(patch.location ? { location: patch.location } : {}),
        ...(patch.description ? { description: patch.description } : {}),
      };
      if (scope === 'this') {
        this.persistRow(row, {
          data: { ...data, exdates: [...(data.exdates ?? []), occurrenceStart] },
        });
        return this.createEvent(base);
      }
      this.persistRow(row, {
        data: { ...data, rrule: { ...rrule, until: occurrenceStart - 1 } },
      });
      return this.createEvent({ ...base, rrule });
    }

    const uid = row.uid ?? crypto.randomBytes(16).toString('hex');
    const account = row.calendar_id === LOCAL_CALENDAR_ID ? null : this.get(row.calendar_id);
    const href =
      typeof data.href === 'string' ? data.href : account ? this.hrefFor(account, uid) : null;
    // id 里含 startsAt：改了时间就必须换 id，否则下次同步会按新时间再插一条
    const nextId = account && href ? `${account.id}|${href}|${startsAt}` : patch.id;

    this.db
      .prepare(
        `UPDATE calendar_events
            SET id = ?, summary = ?, starts_at = ?, ends_at = ?, all_day = ?, data_json = ?
          WHERE id = ?`,
      )
      .run(
        nextId,
        summary,
        startsAt,
        endsAt,
        allDay ? 1 : 0,
        JSON.stringify({
          kind,
          location: patch.location ?? null,
          description: patch.description ?? null,
          ...(rrule ? { rrule } : {}),
          ...(href ? { href } : {}),
          local: true,
        }),
        patch.id,
      );

    if (account && href) {
      this.queueWrite(account.id, {
        method: 'PUT',
        href,
        payload: buildIcs([
          this.toIcsEvent({
            uid,
            summary,
            startsAt,
            endsAt,
            allDay,
            ...(rrule ? { rrule } : {}),
            ...(patch.location ? { location: patch.location } : {}),
            ...(patch.description ? { description: patch.description } : {}),
          }),
        ]),
        ...(row.etag ? { etag: row.etag } : {}),
      });
    }

    this.onChange();

    return {
      id: nextId,
      calendarId: row.calendar_id,
      uid,
      summary,
      startsAt,
      endsAt,
      allDay,
      kind,
      ...(rrule ? { rrule } : {}),
      ...(patch.location ? { location: patch.location } : {}),
      ...(patch.description ? { description: patch.description } : {}),
    };
  }

  /** 就地更新一行（必要时改主键 id），有可写账户时重新 PUT 整个系列。 */
  private persistRow(row: EventRow, next: { startsAt?: number; data: EventData }): void {
    const account = row.calendar_id === LOCAL_CALENDAR_ID ? null : this.get(row.calendar_id);
    const href =
      typeof next.data.href === 'string'
        ? next.data.href
        : account
          ? this.hrefFor(account, row.uid ?? '')
          : null;
    const startsAt = next.startsAt ?? row.starts_at ?? 0;
    const nextId = account && href ? `${account.id}|${href}|${startsAt}` : row.id;

    this.db
      .prepare('UPDATE calendar_events SET id = ?, starts_at = ?, data_json = ? WHERE id = ?')
      .run(nextId, startsAt, JSON.stringify(next.data), row.id);

    if (account && href) {
      this.queueWrite(account.id, {
        method: 'PUT',
        href,
        payload: buildIcs([
          this.toIcsEvent({
            uid: row.uid ?? '',
            summary: row.summary ?? '（无标题）',
            startsAt,
            endsAt: row.ends_at ?? startsAt,
            allDay: row.all_day === 1,
            ...(next.data.rrule ? { rrule: next.data.rrule } : {}),
            ...(next.data.location ? { location: next.data.location } : {}),
            ...(next.data.description ? { description: next.data.description } : {}),
            exdates: next.data.exdates ?? [],
          }),
        ]),
        ...(row.etag ? { etag: row.etag } : {}),
      });
    }

    this.onChange();
  }

  private removeEventRow(row: EventRow, data: EventData): boolean {
    if (row.calendar_id !== LOCAL_CALENDAR_ID) {
      const account = this.get(row.calendar_id);
      const href = typeof data.href === 'string' ? data.href : null;
      if (account && href) {
        this.queueWrite(account.id, {
          method: 'DELETE',
          href,
          ...(row.etag ? { etag: row.etag } : {}),
        });
      }
    }
    this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(row.id);
    this.onChange();
    return true;
  }

  /**
   * 删除事件。重复事件按 `scope` 只动一段：
   * this（EXDATE 排除）/ thisAndFuture（UNTIL 截断）/ past（起点前移）等。
   */
  deleteEvent(request: CalendarEventDeleteRequest): boolean {
    const row = this.db
      .prepare('SELECT * FROM calendar_events WHERE id = ?')
      .get(request?.id ?? '') as EventRow | undefined;
    if (!row) return false;

    const data = this.parseData(row.data_json);
    if (!this.isLocalCreated(row, data)) return false;

    const rrule = data.rrule;
    const occurrenceStart = request.occurrenceStart;
    const scope = request.scope;

    // 单次事件、没给范围、整系列：直接删行
    if (!rrule || occurrenceStart === undefined || !scope || scope === 'all') {
      return this.removeEventRow(row, data);
    }

    switch (scope) {
      case 'this':
        this.persistRow(row, {
          data: { ...data, exdates: [...(data.exdates ?? []), occurrenceStart] },
        });
        return true;
      case 'thisAndFuture':
        this.persistRow(row, {
          data: { ...data, rrule: { ...rrule, until: occurrenceStart - 1 } },
        });
        return true;
      case 'future': {
        const next = this.nextOccurrenceAfter(row, data, occurrenceStart);
        if (next === null) return true;
        this.persistRow(row, { data: { ...data, rrule: { ...rrule, until: next - 1 } } });
        return true;
      }
      case 'past':
        // 起点前移到本次：之前的实例自然消失
        this.persistRow(row, { startsAt: occurrenceStart, data: { ...data } });
        return true;
      case 'pastAndThis': {
        const next = this.nextOccurrenceAfter(row, data, occurrenceStart);
        if (next === null) return this.removeEventRow(row, data);
        this.persistRow(row, { startsAt: next, data: { ...data } });
        return true;
      }
      default:
        return false;
    }
  }

  /** 离线写操作入队；联网后由 worker 按顺序写回（§16.2）。 */
  queueWrite(accountId: string, write: CalendarWriteCommand): void {
    this.db
      .prepare(
        `INSERT INTO calendar_outbox (id, account_id, method, href, payload, retry_count, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        `cob-${crypto.randomBytes(8).toString('hex')}`,
        accountId,
        write.method,
        write.href,
        write.payload ?? null,
        Date.now(),
      );
  }

  private pendingWrites(accountId: string): CalendarWriteCommand[] {
    const rows = this.db
      .prepare('SELECT method, href, payload FROM calendar_outbox WHERE account_id = ? ORDER BY created_at ASC')
      .all(accountId) as Array<{ method: 'PUT' | 'DELETE'; href: string; payload: string | null }>;
    return rows.map((row) => ({
      method: row.method,
      href: row.href,
      ...(row.payload ? { payload: row.payload } : {}),
    }));
  }

  async sync(accountId?: string): Promise<CalendarSyncResult[]> {
    const rows = accountId
      ? ([this.get(accountId)].filter(Boolean) as AccountRow[])
      : (this.db.prepare('SELECT * FROM calendar_accounts WHERE enabled = 1').all() as AccountRow[]);

    const results: CalendarSyncResult[] = [];
    for (const row of rows) {
      results.push(await this.syncOne(row));
    }
    return results;
  }

  private syncOne(row: AccountRow): Promise<CalendarSyncResult> {
    const existing = this.running.get(row.id);
    if (existing) return existing;

    const task = this.runSync(row).finally(() => {
      this.running.delete(row.id);
    });
    this.running.set(row.id, task);
    return task;
  }

  private async runSync(row: AccountRow): Promise<CalendarSyncResult> {
    const startedAt = Date.now();
    const password = row.secret_ref ? ((await this.secrets.get(row.secret_ref)) ?? '') : '';

    try {
      const response = await this.requestWorker(row, password);
      if (response.type === 'error') throw new Error(response.message);

      const counts = this.applyEvents(row, response.events, response.mode);

      if (response.writeFailures === 0) {
        this.db.prepare('DELETE FROM calendar_outbox WHERE account_id = ?').run(row.id);
      }

      this.db
        .prepare(
          `UPDATE calendar_accounts
              SET ctag = ?, sync_token = ?, last_sync_at = ?, last_error = NULL
            WHERE id = ?`,
        )
        .run(response.ctag ?? row.ctag, response.syncToken ?? row.sync_token, Date.now(), row.id);

      recordMetric('calendar_sync', {
        accountId: row.id,
        mode: response.mode,
        added: counts.added,
        updated: counts.updated,
        deleted: counts.deleted,
        durationMs: Date.now() - startedAt,
      });
      this.onChange();

      return { accountId: row.id, ...counts };
    } catch (error) {
      const message = (error as Error).message;
      this.db
        .prepare('UPDATE calendar_accounts SET last_error = ?, last_sync_at = ? WHERE id = ?')
        .run(message.slice(0, 300), Date.now(), row.id);
      log.warn('calendar', '日历同步失败', { accountId: row.id, message });
      this.onChange();
      return { accountId: row.id, added: 0, updated: 0, deleted: 0, error: message };
    }
  }

  private requestWorker(row: AccountRow, password: string): Promise<CalendarWorkerResponse> {
    return new Promise<CalendarWorkerResponse>((resolve, reject) => {
      const worker = new Worker(workerScriptPath());
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error('日历同步超时'));
      }, 60_000);

      worker.once('message', (message: CalendarWorkerResponse) => {
        clearTimeout(timer);
        void worker.terminate();
        resolve(message);
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        void worker.terminate();
        reject(error);
      });
      worker.once('exit', (code) => {
        if (code !== 0) {
          clearTimeout(timer);
          reject(new Error(`日历 worker 退出（code=${code}）`));
        }
      });

      const command: CalendarWorkerCommand = {
        id: 1,
        type: 'sync',
        config: {
          id: row.id,
          kind: row.kind,
          url: row.url,
          username: row.username ?? '',
          password,
          ctag: row.ctag,
          syncToken: row.sync_token,
        },
        writes: this.pendingWrites(row.id),
        windowEnd: Date.now() + 370 * 24 * 60 * 60 * 1000,
      };
      worker.postMessage(command);
    });
  }

  private applyEvents(
    row: AccountRow,
    events: CalendarWorkerEvent[],
    mode: 'unchanged' | 'incremental' | 'full' | 'ics',
  ): { added: number; updated: number; deleted: number } {
    if (mode === 'unchanged') return { added: 0, updated: 0, deleted: 0 };

    let added = 0;
    let updated = 0;
    let deleted = 0;

    const tx = this.db.transaction(() => {
      if (mode === 'full' || mode === 'ics') {
        this.db.prepare('DELETE FROM calendar_events WHERE calendar_id = ?').run(row.id);
      }

      for (const event of events) {
        const prefix = `${row.id}|${event.href}|`;
        if (event.deleted) {
          const result = this.db
            .prepare('DELETE FROM calendar_events WHERE calendar_id = ? AND substr(id, 1, ?) = ?')
            .run(row.id, prefix.length, prefix);
          deleted += result.changes;
          continue;
        }

        const id = `${prefix}${event.startsAt}`;
        const existing = this.db
          .prepare('SELECT id FROM calendar_events WHERE id = ?')
          .get(id) as { id: string } | undefined;

        const data = JSON.stringify({
          href: event.href,
          location: event.location ?? null,
          description: event.description ?? null,
        });

        this.db
          .prepare(
            `INSERT INTO calendar_events
               (id, calendar_id, uid, etag, summary, starts_at, ends_at, all_day, data_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               uid = excluded.uid,
               etag = excluded.etag,
               summary = excluded.summary,
               starts_at = excluded.starts_at,
               ends_at = excluded.ends_at,
               all_day = excluded.all_day,
               data_json = excluded.data_json`,
          )
          .run(
            id,
            row.id,
            event.uid,
            event.etag,
            event.summary,
            event.startsAt,
            event.endsAt,
            event.allDay ? 1 : 0,
            data,
          );

        if (existing) updated += 1;
        else added += 1;
      }
    });

    tx();
    return { added, updated, deleted };
  }

  events(from: number, to: number): CalendarEventView[] {
    const rows = this.db
      .prepare(
        // LEFT JOIN：本地事件（calendar_id='local'）没有对应账户行，用内连接会被漏掉
        `SELECT e.* FROM calendar_events e
           LEFT JOIN calendar_accounts a ON a.id = e.calendar_id
          WHERE (e.calendar_id = ? OR a.enabled = 1) AND e.starts_at IS NOT NULL
            AND e.starts_at < ? AND COALESCE(e.ends_at, e.starts_at) >= ?
          ORDER BY e.starts_at ASC
          LIMIT 2000`,
      )
      .all(LOCAL_CALENDAR_ID, to, from) as EventRow[];

    const views: CalendarEventView[] = [];
    for (const row of rows) {
      const data = this.parseData(row.data_json);
      const base: CalendarEventView = {
        id: row.id,
        calendarId: row.calendar_id,
        uid: row.uid,
        summary: row.summary ?? '（无标题）',
        startsAt: row.starts_at ?? 0,
        endsAt: row.ends_at ?? row.starts_at ?? 0,
        allDay: row.all_day === 1,
        ...(data.location ? { location: data.location } : {}),
        ...(data.description ? { description: data.description } : {}),
        ...(data.kind ? { kind: data.kind } : {}),
        ...(data.rrule ? { rrule: data.rrule } : {}),
      };

      if (!data.rrule) {
        views.push(base);
        continue;
      }

      // 重复事件在库里只存一行，读取时按查询窗口展开（与远程 ICS 的处理一致）。
      // exdates / until 必须一起带上，否则「仅删这次」和「截断系列」在读取侧全部失效。
      const instances = expandRecurrence(
        {
          uid: row.uid ?? '',
          summary: base.summary,
          startsAt: base.startsAt,
          endsAt: base.endsAt,
          allDay: base.allDay,
          exdates: data.exdates ?? [],
          rrule: {
            freq: data.rrule.freq,
            interval: Math.max(1, data.rrule.interval ?? 1),
            ...(data.rrule.until !== undefined ? { until: data.rrule.until } : {}),
          },
        },
        to,
        2000,
      );
      for (const instance of instances) {
        if (instance.startsAt < from || instance.startsAt >= to) continue;
        views.push({ ...base, startsAt: instance.startsAt, endsAt: instance.endsAt });
      }
    }

    return views.sort((a, b) => a.startsAt - b.startsAt).slice(0, 2000);
  }
}
