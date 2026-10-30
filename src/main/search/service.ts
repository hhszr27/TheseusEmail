import type { Db } from '../db/open';
import { toSummary, type EmailRow, type EmailsRepo } from '../db/repositories/emails-repo';
import type { SearchRequest, SearchResponse } from '../../shared/ipc';
import type { EmailSummary } from '../../shared/types';
import { htmlToPlainText, sanitizeEmailHtml } from '../security/sanitize';
import { recordMetric } from '../observability/metrics';
import { log } from '../observability/logger';
import { parseSearchQuery, toFtsPhrase } from './query';
import { buildExcerpt } from '../../shared/search-excerpt';
import { filterCondition, normalizeListFilter, normalizeListSort, sortOrderSql } from '../db/list-query';

/**
 * 全文检索与索引维护（§18）。
 *
 * 索引内容是净化后的正文纯文本；附件内容不进入索引。
 * 维护分三层：增量对账（10 分钟）、optimize（每日/阈值）、全量重建（手动/每周）。
 */

const MAX_INDEXED_BODY = 200_000;
const OPTIMIZE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class SearchService {
  private reconcileTimer: NodeJS.Timeout | null = null;
  private optimizeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly emails: EmailsRepo,
  ) {}

  /** 重新索引单封邮件；正文缺失时只索引主题。 */
  indexEmail(emailId: string): void {
    const email = this.emails.get(emailId);
    if (!email) {
      this.removeEmail(emailId);
      return;
    }

    const body = this.emails.getBody(emailId);
    const rawHtml = body?.html ?? '';
    const sanitized = rawHtml ? sanitizeEmailHtml(rawHtml).html : '';
    const text = (body?.text ?? '').trim() || htmlToPlainText(sanitized);

    this.removeEmail(emailId);
    this.db
      .prepare('INSERT INTO emails_fts (email_id, subject, body) VALUES (?, ?, ?)')
      .run(emailId, email.subject, text.slice(0, MAX_INDEXED_BODY));
  }

  removeEmail(emailId: string): void {
    const rows = this.db
      .prepare('SELECT rowid FROM emails_fts WHERE email_id = ?')
      .all(emailId) as Array<{ rowid: number }>;
    const statement = this.db.prepare('DELETE FROM emails_fts WHERE rowid = ?');
    for (const row of rows) statement.run(row.rowid);
  }

  /** 增量对账：补齐未索引邮件，删除孤儿索引。 */
  reconcile(batchSize = 500): { indexed: number; removed: number } {
    const missing = this.db
      .prepare(
        `SELECT e.id AS id FROM emails e
          LEFT JOIN emails_fts f ON f.email_id = e.id
          WHERE f.rowid IS NULL
          LIMIT ?`,
      )
      .all(batchSize) as Array<{ id: string }>;

    for (const row of missing) {
      this.indexEmail(row.id);
    }

    const orphans = this.db
      .prepare(
        `SELECT DISTINCT f.email_id AS id FROM emails_fts f
          LEFT JOIN emails e ON e.id = f.email_id
          WHERE e.id IS NULL
          LIMIT ?`,
      )
      .all(batchSize) as Array<{ id: string }>;

    for (const row of orphans) {
      this.removeEmail(row.id);
    }

    if (missing.length || orphans.length) {
      log.info('fts', '索引对账完成', {
        indexed: missing.length,
        removed: orphans.length,
      });
    }

    return { indexed: missing.length, removed: orphans.length };
  }

  segmentCount(): number {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS c FROM emails_fts_data WHERE id > 10')
        .get() as { c: number };
      return row.c;
    } catch {
      return 0;
    }
  }

  optimize(): { durationMs: number; segments: number } {
    const started = Date.now();
    this.db.exec("INSERT INTO emails_fts(emails_fts) VALUES('optimize')");
    const durationMs = Date.now() - started;
    const segments = this.segmentCount();

    this.setSetting('fts.lastOptimizeAt', String(Date.now()));
    recordMetric('fts_optimize_duration', { ms: durationMs, segments });
    recordMetric('fts_segment_count', { count: segments });

    log.info('fts', '索引 optimize 完成', { durationMs, segments });
    return { durationMs, segments };
  }

  /** 全量重建：清空后按邮件表重写索引，可清理损坏的 shadow table 残留。 */
  rebuild(batchSize = 500): { indexed: number } {
    this.db.prepare('DELETE FROM emails_fts').run();
    let offset = 0;
    let indexed = 0;

    for (;;) {
      const rows = this.db
        .prepare('SELECT id FROM emails ORDER BY rowid LIMIT ? OFFSET ?')
        .all(batchSize, offset) as Array<{ id: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        this.indexEmail(row.id);
        indexed += 1;
      }
      offset += rows.length;
    }

    recordMetric('fts_segment_count', { count: this.segmentCount() });
    log.info('fts', '索引全量重建完成', { indexed });
    return { indexed };
  }

  search(request: SearchRequest): SearchResponse {
    const started = Date.now();
    const parsed = parseSearchQuery(request.query ?? '');
    const limit = Math.min(500, Math.max(1, request.limit ?? 100));

    const where: string[] = [];
    const params: unknown[] = [];

    if (parsed.text) {
      if (parsed.text.length >= 3) {
        where.push('e.id IN (SELECT email_id FROM emails_fts WHERE emails_fts MATCH ?)');
        params.push(toFtsPhrase(parsed.text));
      } else {
        // trigram 需要至少 3 个字符；短词（常见中文双字词）回退到 LIKE，
        // 同时覆盖主题、摘要与索引正文，避免正文命中丢失。
        where.push(
          '(e.subject LIKE ? OR e.snippet LIKE ? OR e.id IN (SELECT email_id FROM emails_fts WHERE body LIKE ?))',
        );
        params.push(`%${parsed.text}%`, `%${parsed.text}%`, `%${parsed.text}%`);
      }
    }
    if (parsed.from) {
      where.push('e.from_json LIKE ?');
      params.push(`%${parsed.from}%`);
    }
    if (parsed.subject) {
      where.push('e.subject LIKE ?');
      params.push(`%${parsed.subject}%`);
    }
    if (parsed.hasAttachment) {
      where.push('e.has_attachments = 1');
    }
    if (parsed.after !== undefined) {
      where.push('e.date >= ?');
      params.push(parsed.after);
    }
    if (parsed.before !== undefined) {
      where.push('e.date < ?');
      params.push(parsed.before);
    }
    if (request.accountId) {
      if (request.scope !== 'enabled' && request.scope !== 'all') {
        where.push('e.account_id = ?');
        params.push(request.accountId);
      }
    }
    if (request.scope === 'enabled') {
      where.push('EXISTS (SELECT 1 FROM accounts a WHERE a.id = e.account_id AND a.enabled = 1)');
    }
    if (request.folder) {
      where.push('e.folder = ?');
      params.push(request.folder);
    }
    // 与列表同口径的筛选（全部/未读/已标记）；映射来自 list-query.ts 白名单
    const filter = normalizeListFilter(request.filter);
    const condition = filterCondition(filter, 'e');
    if (condition) {
      where.push(condition);
    }

    const whereSql = where.length ? where.join(' AND ') : '1 = 1';

    let emails: EmailRow[] = [];
    let total = 0;
    try {
      emails = this.db
        .prepare(
          `SELECT e.* FROM emails e
            WHERE ${whereSql}
            ORDER BY ${sortOrderSql(normalizeListSort(request.sort), 'e')}
            LIMIT ?`,
        )
        .all(...params, limit) as EmailRow[];

      const countRow = this.db
        .prepare(`SELECT COUNT(*) AS c FROM emails e WHERE ${whereSql}`)
        .get(...params) as { c: number };
      total = countRow.c;
    } catch (error) {
      log.warn('fts', '搜索失败', { message: (error as Error).message, query: request.query });
      recordMetric('fts_latency', { ms: Date.now() - started, hits: 0, failed: 1 });
      throw error;
    }

    const latency = Date.now() - started;
    recordMetric('fts_latency', {
      ms: latency,
      hits: emails.length,
      queryLength: (request.query ?? '').length,
    });

    const summaries = emails.map(toSummary);
    if (parsed.text) this.attachBodyExcerpts(summaries, parsed.text);

    return {
      emails: summaries,
      total,
      parsed: {
        text: parsed.text,
        ...(parsed.from ? { from: parsed.from } : {}),
        ...(parsed.subject ? { subject: parsed.subject } : {}),
        ...(parsed.hasAttachment ? { hasAttachment: true } : {}),
        ...(parsed.after !== undefined ? { after: parsed.after } : {}),
        ...(parsed.before !== undefined ? { before: parsed.before } : {}),
      },
    };
  }

  /**
   * 正文命中的邮件：把列表摘要换成命中位置的正文摘录。
   * 只在「主题 / 摘要都没命中」时替换，避免覆盖本来就能看到的关键词。
   * （IMAP 同步时 snippet 只是主题前 180 字，正文命中不在摘要里。）
   */
  private attachBodyExcerpts(summaries: EmailSummary[], needle: string): void {
    const statement = this.db.prepare('SELECT body FROM emails_fts WHERE email_id = ?');
    const lowered = needle.toLowerCase();
    for (const summary of summaries) {
      if (
        summary.subject.toLowerCase().includes(lowered) ||
        summary.snippet.toLowerCase().includes(lowered)
      ) {
        continue;
      }
      const row = statement.get(summary.id) as { body?: string } | undefined;
      const excerpt = buildExcerpt(row?.body ?? '', needle);
      if (excerpt) summary.snippet = excerpt;
    }
  }

  startMaintenance(): void {
    // 启动后先做一次增量对账（不阻塞启动）
    setTimeout(() => {
      try {
        this.reconcile();
        const last = Number(this.getSetting('fts.lastOptimizeAt') ?? 0);
        if (!last || Date.now() - last > OPTIMIZE_INTERVAL_MS) {
          this.optimize();
        }
      } catch (error) {
        log.warn('fts', '启动索引维护失败', { message: (error as Error).message });
      }
    }, 2000).unref?.();

    this.reconcileTimer = setInterval(() => {
      try {
        this.reconcile();
      } catch (error) {
        log.warn('fts', '增量对账失败', { message: (error as Error).message });
      }
    }, 10 * 60 * 1000);
    this.reconcileTimer.unref?.();

    this.optimizeTimer = setInterval(() => {
      try {
        this.optimize();
      } catch (error) {
        log.warn('fts', 'optimize 失败', { message: (error as Error).message });
      }
    }, OPTIMIZE_INTERVAL_MS);
    this.optimizeTimer.unref?.();
  }

  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.optimizeTimer) clearInterval(this.optimizeTimer);
    this.reconcileTimer = null;
    this.optimizeTimer = null;
  }

  private getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }
}
