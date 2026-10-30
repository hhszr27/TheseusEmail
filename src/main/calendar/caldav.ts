/**
 * 最小 CalDAV 客户端（§16.2）。
 * 只实现 MailForge 需要的四个操作：属性读取、事件列表、增量同步、写回。
 * XML 解析采用受控的正则提取（响应来自固定的 DAV 命名空间），不执行任何脚本。
 */

export interface CalDavOptions {
  url: string;
  username: string;
  password: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DavMeta {
  ctag: string | null;
  syncToken: string | null;
}

export interface DavEvent {
  href: string;
  etag: string | null;
  data: string | null;
  deleted?: boolean;
}

export interface DavSyncResult {
  events: DavEvent[];
  syncToken: string | null;
}

function authHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/** 去掉命名空间前缀后按本地名提取第一个文本值。 */
export function xmlValue(xml: string, localName: string): string | null {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`,
    'i',
  );
  const match = pattern.exec(xml);
  return match ? match[1]!.trim() : null;
}

export function xmlValues(xml: string, localName: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`,
    'gi',
  );
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    values.push(match[1]!.trim());
  }
  return values;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseMeta(xml: string): DavMeta {
  const ctag = xmlValue(xml, 'getctag');
  const syncToken = xmlValue(xml, 'sync-token');
  return {
    ctag: ctag ? decodeXmlEntities(ctag) : null,
    syncToken: syncToken ? decodeXmlEntities(syncToken) : null,
  };
}

/** 解析 multistatus 中的 response 块（列表与增量同步共用）。 */
export function parseMultiStatus(xml: string): DavEvent[] {
  const blocks = xml.split(/<\/(?:[\w.-]+:)?response>/i);
  const events: DavEvent[] = [];

  for (const block of blocks) {
    if (!/<(?:[\w.-]+:)?response[\s>]/i.test(block)) continue;

    const href = xmlValue(block, 'href');
    if (!href) continue;
    const etag = xmlValue(block, 'getetag');
    const data = xmlValue(block, 'calendar-data');
    const status = xmlValue(block, 'status') ?? '';
    const deleted = /\s404\b/.test(status);

    events.push({
      href: decodeXmlEntities(href),
      etag: etag ? decodeXmlEntities(etag).replace(/^W\//, '').replace(/"/g, '') : null,
      data: data ? decodeXmlEntities(data) : null,
      ...(deleted ? { deleted: true } : {}),
    });
  }

  return events;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
    <d:sync-token/>
  </d:prop>
</d:propfind>`;

const CALENDAR_QUERY_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT"/>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;

function syncCollectionBody(token: string): string {
  return `<?xml version="1.0" encoding="utf-8" ?>
<d:sync-collection xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>${token.replace(/[<>&]/g, '')}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
</d:sync-collection>`;
}

export class CalDavClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: CalDavOptions) {
    this.baseUrl = options.url.replace(/\/?$/, '/');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async request(method: string, body: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.baseUrl, {
        method,
        headers: {
          authorization: authHeader(this.options.username, this.options.password),
          'content-type': 'application/xml; charset=utf-8',
          accept: 'application/xml, text/xml',
          ...extraHeaders,
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async getMeta(): Promise<DavMeta> {
    const response = await this.request('PROPFIND', PROPFIND_BODY, { depth: '0' });
    if (!response.ok && response.status !== 207) {
      throw new Error(`CalDAV 属性读取失败（HTTP ${response.status}）`);
    }
    return parseMeta(await response.text());
  }

  async listEvents(): Promise<DavEvent[]> {
    const response = await this.request('REPORT', CALENDAR_QUERY_BODY, { depth: '1' });
    if (!response.ok && response.status !== 207) {
      throw new Error(`CalDAV 事件列表失败（HTTP ${response.status}）`);
    }
    return parseMultiStatus(await response.text());
  }

  /** 增量同步；服务端不支持 sync-collection 时返回 null。 */
  async syncCollection(token: string): Promise<DavSyncResult | null> {
    const response = await this.request('REPORT', syncCollectionBody(token), { depth: '1' });
    if (response.status === 400 || response.status === 501 || response.status === 403) {
      return null;
    }
    if (!response.ok && response.status !== 207) {
      throw new Error(`CalDAV 增量同步失败（HTTP ${response.status}）`);
    }
    const xml = await response.text();
    return { events: parseMultiStatus(xml), syncToken: parseMeta(xml).syncToken };
  }

  async putEvent(href: string, ics: string, etag?: string): Promise<string | null> {
    const url = href.startsWith('http') ? href : `${this.baseUrl.replace(/\/$/, '')}${href}`;
    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: {
        authorization: authHeader(this.options.username, this.options.password),
        'content-type': 'text/calendar; charset=utf-8',
        ...(etag ? { 'if-match': etag } : {}),
      },
      body: ics,
    });
    if (!response.ok) throw new Error(`CalDAV 写入失败（HTTP ${response.status}）`);
    return response.headers.get('etag')?.replace(/^W\//, '').replace(/"/g, '') ?? null;
  }

  async deleteEvent(href: string, etag?: string): Promise<void> {
    const url = href.startsWith('http') ? href : `${this.baseUrl.replace(/\/$/, '')}${href}`;
    const response = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: {
        authorization: authHeader(this.options.username, this.options.password),
        ...(etag ? { 'if-match': etag } : {}),
      },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`CalDAV 删除失败（HTTP ${response.status}）`);
    }
  }
}
