import { parentPort } from 'node:worker_threads';
import { CalDavClient } from './caldav';
import { parseIcs } from './ics';
import type {
  CalendarWorkerCommand,
  CalendarWorkerEvent,
  CalendarWorkerResponse,
} from './protocol';

/**
 * 日历同步 worker：网络与解析都在这里完成，主进程只做持久化。
 * 输入是不可信的 .ics 文本，解析过程不执行任何脚本或外部引用。
 */

if (!parentPort) {
  throw new Error('calendar-worker must be started as a worker thread');
}
const port = parentPort;

function eventsFromIcs(
  href: string,
  etag: string | null,
  data: string,
  windowEnd: number,
): CalendarWorkerEvent[] {
  return parseIcs(data, { windowEnd }).map((event) => ({
    href,
    etag,
    deleted: false,
    uid: event.uid,
    summary: event.summary,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description } : {}),
  }));
}

async function sync(command: Extract<CalendarWorkerCommand, { type: 'sync' }>): Promise<void> {
  const { config } = command;

  if (config.kind === 'ics') {
    const headers: Record<string, string> = {};
    if (config.username) {
      headers.authorization = `Basic ${Buffer.from(
        `${config.username}:${config.password}`,
        'utf8',
      ).toString('base64')}`;
    }
    const response = await fetch(config.url, { headers });
    if (!response.ok) throw new Error(`订阅地址返回 HTTP ${response.status}`);
    const text = await response.text();
    const events = eventsFromIcs(config.url, null, text, command.windowEnd);
    post({
      id: command.id,
      type: 'synced',
      mode: 'ics',
      ctag: null,
      syncToken: null,
      events,
      writeFailures: 0,
    });
    return;
  }

  const client = new CalDavClient({
    url: config.url,
    username: config.username,
    password: config.password,
  });

  const meta = await client.getMeta();
  if (config.ctag && meta.ctag && config.ctag === meta.ctag) {
    post({
      id: command.id,
      type: 'synced',
      mode: 'unchanged',
      ctag: meta.ctag,
      syncToken: meta.syncToken ?? config.syncToken,
      events: [],
      writeFailures: 0,
    });
    return;
  }

  let mode: 'incremental' | 'full' = 'full';
  let events: CalendarWorkerEvent[] = [];
  let nextToken = meta.syncToken ?? config.syncToken;

  if (config.syncToken) {
    const incremental = await client.syncCollection(config.syncToken);
    if (incremental) {
      mode = 'incremental';
      events = incremental.events.flatMap((item) => {
        if (item.deleted) {
          return [
            {
              href: item.href,
              etag: item.etag,
              deleted: true,
              uid: '',
              summary: '',
              startsAt: 0,
              endsAt: 0,
              allDay: false,
            },
          ];
        }
        if (!item.data) return [];
        return eventsFromIcs(item.href, item.etag, item.data, command.windowEnd);
      });
      nextToken = incremental.syncToken ?? nextToken;
    }
  }

  if (mode === 'full') {
    const listed = await client.listEvents();
    events = listed.flatMap((item) =>
      item.data ? eventsFromIcs(item.href, item.etag, item.data, command.windowEnd) : [],
    );
  }

  let writeFailures = 0;
  for (const write of command.writes) {
    try {
      if (write.method === 'PUT' && write.payload) {
        await client.putEvent(write.href, write.payload, write.etag);
      } else if (write.method === 'DELETE') {
        await client.deleteEvent(write.href, write.etag);
      }
    } catch {
      writeFailures += 1;
    }
  }

  post({
    id: command.id,
    type: 'synced',
    mode,
    ctag: meta.ctag,
    syncToken: nextToken,
    events,
    writeFailures,
  });
}

function post(message: CalendarWorkerResponse): void {
  port.postMessage(message);
}

port.on('message', (message: CalendarWorkerCommand) => {
  if (message.type === 'close') {
    post({ id: message.id, type: 'error', message: 'closed' });
    return;
  }
  void sync(message)
    .then(() => undefined)
    .catch((error: Error) => {
      post({ id: message.id, type: 'error', message: error.message });
    });
});
