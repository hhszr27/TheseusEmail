import { afterEach, describe, expect, it } from 'vitest';
import {
  buildIcs,
  expandRecurrence,
  parseIcs,
  parseIcsDate,
  parseRRule,
  zonedTimeToUtc,
} from '../src/main/calendar/ics';
import {
  CalDavClient,
  parseMeta,
  parseMultiStatus,
  xmlValue,
  xmlValues,
} from '../src/main/calendar/caldav';
import { CalendarService } from '../src/main/calendar/service';
import type { SecretStore } from '../src/main/mail/auth/token-store';
import { createTestDb, type TestDb } from './helpers/test-db';

let context: TestDb | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

const UTC_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:evt-1
SUMMARY:Team sync
DESCRIPTION:Weekly sync\\nAgenda attached
LOCATION:Room 3
DTSTART:20261022T030000Z
DTEND:20261022T040000Z
END:VEVENT
END:VCALENDAR`;

const TZ_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-2
SUMMARY:上海会议
DTSTART;TZID=Asia/Shanghai:20261022T110000
DTEND;TZID=Asia/Shanghai:20261022T120000
END:VEVENT
END:VCALENDAR`;

const ALL_DAY_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-3
SUMMARY:全天活动
DTSTART;VALUE=DATE:20261022
END:VEVENT
END:VCALENDAR`;

const RECURRING_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-4
SUMMARY:每日站会
DTSTART:20261001T010000Z
DTEND:20261001T011500Z
RRULE:FREQ=DAILY;COUNT=3
EXDATE:20261002T010000Z
END:VEVENT
END:VCALENDAR`;

describe('ICS 解析（§16.3）', () => {
  it('解析 UTC 时间、描述与地点', () => {
    const [event] = parseIcs(UTC_ICS);
    expect(event).toMatchObject({
      uid: 'evt-1',
      summary: 'Team sync',
      startsAt: Date.UTC(2026, 9, 22, 3, 0, 0),
      endsAt: Date.UTC(2026, 9, 22, 4, 0, 0),
      allDay: false,
      location: 'Room 3',
    });
    expect(event?.description).toContain('Agenda attached');
  });

  it('TZID 时间按目标时区换算为 UTC', () => {
    const [event] = parseIcs(TZ_ICS);
    expect(event?.startsAt).toBe(Date.UTC(2026, 9, 22, 3, 0, 0));
    expect(zonedTimeToUtc(2026, 10, 22, 11, 0, 0, 'Asia/Shanghai')).toBe(
      Date.UTC(2026, 9, 22, 3, 0, 0),
    );
  });

  it('全天事件使用 DATE 并在本地零点开始', () => {
    const [event] = parseIcs(ALL_DAY_ICS);
    expect(event?.allDay).toBe(true);
    expect(new Date(event!.startsAt).getHours()).toBe(0);
    expect(event!.endsAt - event!.startsAt).toBe(24 * 60 * 60 * 1000);
  });

  it('RRULE 展开并排除 EXDATE', () => {
    const events = parseIcs(RECURRING_ICS);
    expect(events).toHaveLength(2);
    expect(events.map((event) => new Date(event.startsAt).getUTCDate())).toEqual([1, 3]);
    expect(events[0]?.rrule).toBeUndefined();
  });

  it('解析 RRULE 参数', () => {
    const rule = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5');
    expect(rule).toMatchObject({ freq: 'WEEKLY', interval: 2, count: 5 });
    expect(rule?.byDay).toEqual([1, 3]);
  });

  it('展开窗口限制实例数量', () => {
    const base = {
      uid: 'r',
      summary: 'repeat',
      startsAt: Date.UTC(2026, 0, 1),
      endsAt: Date.UTC(2026, 0, 1, 1),
      allDay: false,
      exdates: [],
      rrule: { freq: 'DAILY' as const, interval: 1 },
    };
    const instances = expandRecurrence(base, Date.UTC(2026, 0, 5), 180);
    expect(instances).toHaveLength(5);
  });

  it('非法 DTSTART 返回 null 且不抛错', () => {
    expect(parseIcsDate('not-a-date', {})).toBeNull();
  });

  it('生成的 ICS 可被重新解析', () => {
    const ics = buildIcs([
      {
        uid: 'export-1',
        summary: '导出测试',
        startsAt: Date.UTC(2026, 9, 22, 3),
        endsAt: Date.UTC(2026, 9, 22, 4),
        allDay: false,
        exdates: [],
      },
    ]);
    const [event] = parseIcs(ics);
    expect(event?.summary).toBe('导出测试');
    expect(event?.startsAt).toBe(Date.UTC(2026, 9, 22, 3));
  });

  it('生成的 ICS 带 RRULE，重新解析后按窗口展开', () => {
    const startsAt = Date.UTC(2026, 9, 26, 1);
    const ics = buildIcs([
      {
        uid: 'rep-1',
        summary: '每周站会',
        startsAt,
        endsAt: startsAt + 30 * 60 * 1000,
        allDay: false,
        rrule: { freq: 'WEEKLY', interval: 1 },
        exdates: [],
      },
    ]);
    expect(ics).toContain('RRULE:FREQ=WEEKLY');

    const instances = parseIcs(ics, { windowEnd: startsAt + 21 * 24 * 60 * 60 * 1000 });
    expect(instances).toHaveLength(4);
    expect(instances[0]?.summary).toBe('每周站会');
  });

  it('全天事件写成 VALUE=DATE，不写成 UTC 时刻', () => {
    const startsAt = Date.UTC(2026, 9, 29);
    const ics = buildIcs([
      {
        uid: 'd1',
        summary: '生日',
        startsAt,
        endsAt: startsAt + 24 * 60 * 60 * 1000,
        allDay: true,
        exdates: [],
      },
    ]);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261029');

    const [event] = parseIcs(ics);
    expect(event?.allDay).toBe(true);
  });
});

describe('CalDAV 客户端（§16.2）', () => {
  it('XML 提取忽略命名空间前缀', () => {
    const xml = '<d:prop><cs:getctag>abc-123</cs:getctag><d:sync-token>tok-1</d:sync-token></d:prop>';
    expect(xmlValue(xml, 'getctag')).toBe('abc-123');
    expect(parseMeta(xml)).toEqual({ ctag: 'abc-123', syncToken: 'tok-1' });
    expect(xmlValues('<a><x>1</x><x>2</x></a>', 'x')).toEqual(['1', '2']);
  });

  it('解析 multistatus 事件与删除标记', () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/evt1.ics</d:href>
    <d:propstat><d:prop>
      <d:getetag>"etag-1"</d:getetag>
      <cal:calendar-data>BEGIN:VCALENDAR&#13;
END:VCALENDAR</cal:calendar-data>
    </d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/cal/evt2.ics</d:href>
    <d:propstat><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
  </d:response>
</d:multistatus>`;

    const events = parseMultiStatus(xml);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ href: '/cal/evt1.ics', etag: 'etag-1' });
    expect(events[0]?.data).toContain('BEGIN:VCALENDAR');
    expect(events[1]?.deleted).toBe(true);
  });

  it('请求带 Basic 认证与 Depth 头', async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        ...(init?.method ? { method: init.method } : {}),
        headers: init?.headers as Record<string, string>,
      });
      if (init?.method === 'PROPFIND') {
        return new Response(
          '<d:propfind><d:prop><cs:getctag>ctag-1</cs:getctag></d:prop></d:propfind>',
          { status: 207 },
        );
      }
      return new Response('<d:multistatus></d:multistatus>', { status: 207 });
    }) as unknown as typeof fetch;

    const client = new CalDavClient({
      url: 'https://dav.example.com/cal/',
      username: 'user',
      password: 'pass',
      fetchImpl,
    });

    const meta = await client.getMeta();
    expect(meta.ctag).toBe('ctag-1');
    expect(calls[0]?.method).toBe('PROPFIND');
    expect(calls[0]?.headers?.depth).toBe('0');
    expect(calls[0]?.headers?.authorization).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    );

    await client.listEvents();
    expect(calls[1]?.method).toBe('REPORT');
    expect(calls[1]?.headers?.depth).toBe('1');
  });

  it('服务端不支持 sync-collection 时返回 null 以回落全量', async () => {
    const client = new CalDavClient({
      url: 'https://dav.example.com/cal/',
      username: 'u',
      password: 'p',
      fetchImpl: (async () => new Response('unsupported', { status: 501 })) as unknown as typeof fetch,
    });
    expect(await client.syncCollection('token')).toBeNull();
  });
});

describe('日历账户与事件（§16.2）', () => {
  function fakeSecrets(): SecretStore {
    return {
      has: async () => true,
      get: async () => 'pw',
      set: async () => undefined,
      delete: async () => undefined,
      logPresence: async () => undefined,
    } as unknown as SecretStore;
  }

  it('添加只读订阅并读取事件', async () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const account = await service.add({ kind: 'ics', name: '团队日历', url: 'https://example.com/cal.ics' });

    expect(account.readOnly).toBe(true);
    expect(service.list()).toHaveLength(1);

    const startsAt = Date.UTC(2026, 9, 22, 3);
    context.db
      .prepare(
        `INSERT INTO calendar_events (id, calendar_id, uid, etag, summary, starts_at, ends_at, all_day, data_json)
         VALUES (?, ?, 'u1', NULL, '评审会', ?, ?, 0, '{}')`,
      )
      .run(`${account.id}|https://example.com/cal.ics|${startsAt}`, account.id, startsAt, startsAt + 3600_000);

    const events = service.events(startsAt - 86_400_000, startsAt + 86_400_000);
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toBe('评审会');

    expect(await service.remove(account.id)).toBe(true);
    expect(service.list()).toHaveLength(0);
    expect(service.events(startsAt - 1000, startsAt + 1000)).toHaveLength(0);
  });

  it('离线写操作进入队列', async () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const account = await service.add({ kind: 'caldav', name: 'Cal', url: 'https://dav.example.com/cal/' });

    service.queueWrite(account.id, {
      method: 'PUT',
      href: '/cal/new.ics',
      payload: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    });

    const rows = context.db
      .prepare('SELECT method, href FROM calendar_outbox WHERE account_id = ?')
      .all(account.id) as Array<{ method: string; href: string }>;
    expect(rows).toEqual([{ method: 'PUT', href: '/cal/new.ics' }]);
  });

  it('新建本地事件写库并保留类型，且没有账户时也能读回', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const startsAt = Date.UTC(2026, 9, 29, 2);

    const created = service.createEvent({
      kind: 'birthday',
      summary: '小明生日',
      startsAt,
      allDay: true,
      location: '上海',
      description: '记得买蛋糕',
    });

    expect(created.calendarId).toBe('local');
    expect(created.kind).toBe('birthday');
    // 全天事件默认占满一天
    expect(created.endsAt - created.startsAt).toBe(24 * 60 * 60 * 1000);

    // 关键：本地事件没有对应 calendar_accounts 行，events() 必须走 LEFT JOIN 才读得到
    expect(service.list()).toHaveLength(0);
    const events = service.events(startsAt - 1000, startsAt + 24 * 60 * 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      summary: '小明生日',
      kind: 'birthday',
      location: '上海',
      allDay: true,
    });
  });

  it('定时事件未给结束时间时默认 1 小时', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const startsAt = Date.UTC(2026, 9, 29, 2);

    const created = service.createEvent({
      kind: 'meeting',
      summary: '周会',
      startsAt,
      allDay: false,
    });
    expect(created.endsAt - created.startsAt).toBe(60 * 60 * 1000);
  });

  it('更新本地事件：字段生效，远程事件改不动', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const startsAt = Date.UTC(2026, 9, 29, 2);

    const created = service.createEvent({
      kind: 'event',
      summary: '原标题',
      startsAt,
      allDay: false,
    });

    const updated = service.updateEvent({
      id: created.id,
      kind: 'meeting',
      summary: '新标题',
      startsAt: startsAt + 60 * 60 * 1000,
      allDay: false,
      location: '3F 会议室',
    });
    expect(updated).toMatchObject({
      id: created.id,
      summary: '新标题',
      kind: 'meeting',
      location: '3F 会议室',
    });

    const events = service.events(startsAt - 1000, startsAt + 10 * 60 * 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ summary: '新标题', kind: 'meeting' });

    // 造一条真实存在的「远程同步」事件行：用不存在的 id 测不出 calendar_id 防护，
    // 必须让这行真的在库里，才能证明 update 的 `calendar_id='local'` 条件拦住了它
    context.db
      .prepare(
        `INSERT INTO calendar_events (id, calendar_id, uid, etag, summary, starts_at, ends_at, all_day, data_json)
         VALUES ('remote-1', 'acc-1', 'u9', '"etag"', '远程会议', ?, ?, 0, '{}')`,
      )
      .run(startsAt, startsAt + 60 * 60 * 1000);

    expect(
      service.updateEvent({
        id: 'remote-1',
        kind: 'event',
        summary: 'x',
        startsAt,
        allDay: false,
      }),
    ).toBeNull();
    // 原样未变
    const remote = context.db
      .prepare('SELECT summary FROM calendar_events WHERE id = ?')
      .get('remote-1') as { summary: string };
    expect(remote.summary).toBe('远程会议');
  });

  it('删除本地事件；远程事件删不掉', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const startsAt = Date.UTC(2026, 9, 29, 2);

    const created = service.createEvent({
      kind: 'birthday',
      summary: '生日',
      startsAt,
      allDay: true,
    });

    expect(service.deleteEvent({ id: created.id })).toBe(true);
    expect(service.events(startsAt - 1000, startsAt + 24 * 60 * 60 * 1000)).toHaveLength(0);

    // 远程事件行真实存在，但 calendar_id 不是 local → 删不掉（也不能被同步拉回后误删）
    context.db
      .prepare(
        `INSERT INTO calendar_events (id, calendar_id, uid, etag, summary, starts_at, ends_at, all_day, data_json)
         VALUES ('remote-1', 'acc-1', 'u9', '"etag"', '远程会议', ?, ?, 0, '{}')`,
      )
      .run(startsAt, startsAt + 60 * 60 * 1000);

    expect(service.deleteEvent({ id: 'remote-1' })).toBe(false);
    const still = context.db
      .prepare('SELECT COUNT(*) AS n FROM calendar_events WHERE id = ?')
      .get('remote-1') as { n: number };
    expect(still.n).toBe(1);
  });

  it('有可写 CalDAV 账户时，新建事件入队 PUT 并使用同步 id', async () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const account = await service.add({
      kind: 'caldav',
      name: 'Cal',
      url: 'https://dav.example.com/cal/',
    });
    expect(account.readOnly).toBe(false);

    const startsAt = Date.UTC(2026, 9, 29, 2);
    const created = service.createEvent({
      kind: 'meeting',
      summary: '周会',
      startsAt,
      allDay: false,
    });

    // 归属可写账户，id 用与同步一致的 `${accountId}|${href}|${startsAt}`
    expect(created.calendarId).toBe(account.id);
    expect(created.id.startsWith(`${account.id}|https://dav.example.com/cal/`)).toBe(true);

    const writes = context.db
      .prepare('SELECT method, href, payload FROM calendar_outbox WHERE account_id = ?')
      .all(account.id) as Array<{ method: string; href: string; payload: string }>;
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe('PUT');
    expect(writes[0]?.payload).toContain('SUMMARY:周会');
  });

  it('修改与删除分别入队 PUT 和 DELETE', async () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const account = await service.add({
      kind: 'caldav',
      name: 'Cal',
      url: 'https://dav.example.com/cal/',
    });
    const startsAt = Date.UTC(2026, 9, 29, 2);
    const created = service.createEvent({
      kind: 'event',
      summary: '原标题',
      startsAt,
      allDay: false,
    });

    const updated = service.updateEvent({
      id: created.id,
      kind: 'event',
      summary: '新标题',
      startsAt: startsAt + 60 * 60 * 1000,
      allDay: false,
    });
    expect(updated).not.toBeNull();
    // 时间变了 → id 跟着变，否则同步会按新时间再插一条
    expect(updated!.id).not.toBe(created.id);

    expect(service.deleteEvent({ id: updated!.id })).toBe(true);

    const methods = (
      context.db
        .prepare('SELECT method FROM calendar_outbox WHERE account_id = ? ORDER BY rowid ASC')
        .all(account.id) as Array<{ method: string }>
    ).map((row) => row.method);
    expect(methods).toEqual(['PUT', 'PUT', 'DELETE']);
  });

  it('重复事件在读取窗口内展开成多个实例', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const startsAt = Date.UTC(2026, 9, 26, 1);

    service.createEvent({
      kind: 'event',
      summary: '每周站会',
      startsAt,
      allDay: false,
      rrule: { freq: 'WEEKLY', interval: 1 },
    });

    const views = service.events(startsAt - 3600_000, startsAt + 21 * 24 * 60 * 60 * 1000);
    expect(views).toHaveLength(3);
    expect(views.every((view) => view.summary === '每周站会')).toBe(true);
    expect(views[1]!.startsAt - views[0]!.startsAt).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('修改事件时能加上重复规则（原单次 → 每周）', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const startsAt = Date.UTC(2026, 9, 26, 1);

    const created = service.createEvent({
      kind: 'event',
      summary: '站会',
      startsAt,
      allDay: false,
    });

    const updated = service.updateEvent({
      id: created.id,
      kind: 'event',
      summary: '站会',
      startsAt,
      allDay: false,
      rrule: { freq: 'WEEKLY', interval: 1 },
    });
    expect(updated?.rrule).toEqual({ freq: 'WEEKLY', interval: 1 });

    const views = service.events(startsAt - 3600_000, startsAt + 21 * 24 * 60 * 60 * 1000);
    expect(views).toHaveLength(3);
  });

  it('重复事件「仅删除这个」只排除该实例', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const day = 24 * 60 * 60 * 1000;
    const startsAt = Date.UTC(2026, 9, 26, 1);
    const created = service.createEvent({
      kind: 'event',
      summary: '站会',
      startsAt,
      allDay: false,
      rrule: { freq: 'WEEKLY', interval: 1 },
    });

    const second = startsAt + 7 * day;
    expect(
      service.deleteEvent({ id: created.id, occurrenceStart: second, scope: 'this' }),
    ).toBe(true);

    const views = service.events(startsAt - 3600_000, startsAt + 28 * day);
    expect(views.map((view) => view.startsAt)).toEqual([
      startsAt,
      startsAt + 14 * day,
      startsAt + 21 * day,
    ]);
  });

  it('重复事件「删除这个和之后的」截断系列', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const day = 24 * 60 * 60 * 1000;
    const startsAt = Date.UTC(2026, 9, 26, 1);
    const created = service.createEvent({
      kind: 'event',
      summary: '站会',
      startsAt,
      allDay: false,
      rrule: { freq: 'WEEKLY', interval: 1 },
    });

    service.deleteEvent({
      id: created.id,
      occurrenceStart: startsAt + 7 * day,
      scope: 'thisAndFuture',
    });

    const views = service.events(startsAt - 3600_000, startsAt + 28 * day);
    expect(views.map((view) => view.startsAt)).toEqual([startsAt]);
  });

  it('重复事件「删除之前的」把起点前移', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const day = 24 * 60 * 60 * 1000;
    const startsAt = Date.UTC(2026, 9, 26, 1);
    const created = service.createEvent({
      kind: 'event',
      summary: '站会',
      startsAt,
      allDay: false,
      rrule: { freq: 'WEEKLY', interval: 1 },
    });

    const third = startsAt + 14 * day;
    service.deleteEvent({ id: created.id, occurrenceStart: third, scope: 'past' });

    const views = service.events(startsAt - 3600_000, startsAt + 28 * day);
    expect(views.map((view) => view.startsAt)).toEqual([third, third + 7 * day]);
  });

  it('重复事件「仅修改这个」把该次移到新时间', () => {
    context = createTestDb();
    const service = new CalendarService(context.db, fakeSecrets());
    const day = 24 * 60 * 60 * 1000;
    const startsAt = Date.UTC(2026, 9, 26, 1);
    const created = service.createEvent({
      kind: 'event',
      summary: '站会',
      startsAt,
      allDay: false,
      rrule: { freq: 'WEEKLY', interval: 1 },
    });

    const second = startsAt + 7 * day;
    const newStart = second + 3 * 60 * 60 * 1000;
    service.updateEvent({
      id: created.id,
      kind: 'event',
      summary: '站会',
      startsAt: newStart,
      endsAt: newStart + 60 * 60 * 1000,
      allDay: false,
      rrule: { freq: 'WEEKLY', interval: 1 },
      scope: 'this',
      occurrenceStart: second,
    });

    const views = service.events(startsAt - 3600_000, startsAt + 28 * day);
    // 第 2 次被排除，同时在 newStart 多出一个单次事件
    expect(views.map((view) => view.startsAt)).toEqual([
      startsAt,
      newStart,
      startsAt + 14 * day,
      startsAt + 21 * day,
    ]);
  });
});
