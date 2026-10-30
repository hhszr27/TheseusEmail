/**
 * ICS 解析（§16.3 / §16.4）。
 * .ics 是不可信输入：这里只做纯文本解析，不 eval、不解析外部引用、不执行脚本。
 * 产出的时间统一为 UTC 毫秒，渲染进程只接收纯 JSON。
 */

import { zonedTimeToUtc } from '../../shared/timezone';

// 时区换算已收敛到 shared/timezone.ts（渲染进程也要用），这里保留同名导出
export { zonedTimeToUtc };

export interface IcsEvent {
  uid: string;
  summary: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location?: string;
  description?: string;
  rrule?: RecurrenceRule;
  exdates: number[];
}

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: number;
  byDay?: number[];
}

function unfold(input: string): string[] {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n');
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

interface PropertyLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): PropertyLine | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments = head.split(';');
  const name = segments[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    params[segment.slice(0, eq).toUpperCase()] = segment.slice(eq + 1);
  }
  return { name, params, value };
}

interface ParsedDate {
  ms: number;
  allDay: boolean;
}

export function parseIcsDate(value: string, params: Record<string, string>): ParsedDate | null {
  const raw = value.trim();
  if (!raw) return null;

  if (params.VALUE === 'DATE' || /^\d{8}$/.test(raw)) {
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
    if (!match) return null;
    return {
      ms: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0).getTime(),
      allDay: true,
    };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, utc] = match;
  if (utc) {
    return {
      ms: Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)),
      allDay: false,
    };
  }

  const tzid = params.TZID;
  if (tzid) {
    try {
      return {
        ms: zonedTimeToUtc(
          Number(year),
          Number(month),
          Number(day),
          Number(hour),
          Number(minute),
          Number(second),
          tzid,
        ),
        allDay: false,
      };
    } catch {
      // 未知时区按浮动时间处理
    }
  }

  return {
    ms: new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime(),
    allDay: false,
  };
}

const DAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRRule(value: string): RecurrenceRule | null {
  const parts = value.split(';');
  const map = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }

  const freq = map.get('FREQ')?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const rule: RecurrenceRule = {
    freq,
    interval: Math.max(1, Number(map.get('INTERVAL') ?? 1) || 1),
  };

  const count = Number(map.get('COUNT') ?? 0);
  if (count > 0) rule.count = count;

  const until = map.get('UNTIL');
  if (until) {
    const parsed = parseIcsDate(until, {});
    if (parsed) rule.until = parsed.ms;
  }

  const byDay = map.get('BYDAY');
  if (byDay) {
    const days = byDay
      .split(',')
      .map((token) => DAY_CODES[token.trim().slice(-2).toUpperCase()])
      .filter((day): day is number => typeof day === 'number');
    if (days.length > 0) rule.byDay = days;
  }

  return rule;
}

/** 展开重复规则；窗口用于 ICAL 订阅展示，避免无限循环。 */
export function expandRecurrence(
  event: IcsEvent,
  windowEnd: number,
  maxInstances = 180,
): IcsEvent[] {
  if (!event.rrule) return [event];
  const rule = event.rrule;
  const duration = Math.max(0, event.endsAt - event.startsAt);
  const instances: IcsEvent[] = [];

  const start = new Date(event.startsAt);
  let cursor = new Date(event.startsAt);
  let produced = 0;
  let sequence = 0;
  let guard = 0;

  while (guard < 5000 && produced < maxInstances) {
    guard += 1;
    if (rule.count !== undefined && sequence >= rule.count) break;
    if (rule.until !== undefined && cursor.getTime() > rule.until) break;
    if (cursor.getTime() > windowEnd) break;

    if (event.exdates.includes(cursor.getTime())) {
      // 被排除的实例仍占用 COUNT 名额
      sequence += 1;
    } else if (rule.freq === 'WEEKLY' && rule.byDay && rule.byDay.length > 0) {
      const weekStart = new Date(cursor);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      for (const day of rule.byDay) {
        const candidate = new Date(weekStart);
        candidate.setDate(weekStart.getDate() + ((day + 6) % 7));
        candidate.setHours(start.getHours(), start.getMinutes(), start.getSeconds(), 0);
        if (candidate.getTime() < event.startsAt) continue;
        if (rule.until !== undefined && candidate.getTime() > rule.until) continue;
        if (event.exdates.includes(candidate.getTime())) continue;
        instances.push({
          ...event,
          startsAt: candidate.getTime(),
          endsAt: candidate.getTime() + duration,
          rrule: undefined,
        });
        produced += 1;
        sequence += 1;
        if (produced >= maxInstances) break;
        if (rule.count !== undefined && sequence >= rule.count) break;
      }
      cursor.setDate(cursor.getDate() + 7 * rule.interval);
      continue;
    }

    if (!event.exdates.includes(cursor.getTime())) {
      instances.push({
        ...event,
        startsAt: cursor.getTime(),
        endsAt: cursor.getTime() + duration,
        rrule: undefined,
      });
      produced += 1;
      sequence += 1;
    }

    const next = new Date(cursor);
    switch (rule.freq) {
      case 'DAILY':
        next.setDate(next.getDate() + rule.interval);
        break;
      case 'WEEKLY':
        next.setDate(next.getDate() + 7 * rule.interval);
        break;
      case 'MONTHLY':
        next.setMonth(next.getMonth() + rule.interval);
        break;
      case 'YEARLY':
        next.setFullYear(next.getFullYear() + rule.interval);
        break;
    }
    if (next.getTime() === cursor.getTime()) break;
    cursor = next;
  }

  return instances.length > 0 ? instances : [event];
}

/** 解析 VCALENDAR 文本，返回展开后的实例。 */
export function parseIcs(input: string, options: { windowEnd?: number } = {}): IcsEvent[] {
  const lines = unfold(input);
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;
  let inEvent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      current = { exdates: [] };
      inEvent = true;
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (current && current.startsAt !== undefined) {
        const allDay = current.allDay === true;
        const endsAt =
          current.endsAt ??
          current.startsAt + (allDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000);
        const event: IcsEvent = {
          uid: current.uid ?? `ics-${current.startsAt}`,
          summary: current.summary ?? '（无标题）',
          startsAt: current.startsAt,
          endsAt,
          allDay,
          exdates: current.exdates ?? [],
          ...(current.location ? { location: current.location } : {}),
          ...(current.description ? { description: current.description } : {}),
          ...(current.rrule ? { rrule: current.rrule } : {}),
        };
        events.push(...expandRecurrence(event, options.windowEnd ?? event.startsAt + 365 * 24 * 60 * 60 * 1000));
      }
      current = null;
      inEvent = false;
      continue;
    }
    if (!inEvent || !current) continue;

    const property = parseLine(trimmed);
    if (!property) continue;

    switch (property.name) {
      case 'UID':
        current.uid = unescapeText(property.value);
        break;
      case 'SUMMARY':
        current.summary = unescapeText(property.value);
        break;
      case 'LOCATION':
        current.location = unescapeText(property.value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(property.value).slice(0, 4000);
        break;
      case 'DTSTART': {
        const parsed = parseIcsDate(property.value, property.params);
        if (parsed) {
          current.startsAt = parsed.ms;
          current.allDay = parsed.allDay;
        }
        break;
      }
      case 'DTEND': {
        const parsed = parseIcsDate(property.value, property.params);
        if (parsed) current.endsAt = parsed.ms;
        break;
      }
      case 'RRULE': {
        const rule = parseRRule(property.value);
        if (rule) current.rrule = rule;
        break;
      }
      case 'EXDATE': {
        const list = property.value.split(',');
        for (const item of list) {
          const parsed = parseIcsDate(item, property.params);
          if (parsed) current.exdates = [...(current.exdates ?? []), parsed.ms];
        }
        break;
      }
      default:
        break;
    }
  }

  return events.sort((a, b) => a.startsAt - b.startsAt);
}

/** 生成最小可用 ICS（用于导出/写回，不含 UI 状态）。 */
export function buildIcs(events: IcsEvent[], calendarName = 'MailForge'): string {
  const format = (ms: number): string => {
    const date = new Date(ms);
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
      date.getUTCDate(),
    ).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(
      date.getUTCMinutes(),
    ).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
  };
  const formatDate = (ms: number): string => {
    const date = new Date(ms);
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
      date.getUTCDate(),
    ).padStart(2, '0')}`;
  };
  /** RRULE 是写回 CalDAV 的关键：不带它，重复事件到了服务器就只剩单次。 */
  const formatRule = (rule: RecurrenceRule): string => {
    const parts = [`FREQ=${rule.freq}`];
    if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
    if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
    if (rule.until !== undefined) parts.push(`UNTIL=${format(rule.until)}`);
    if (rule.byDay && rule.byDay.length > 0) {
      // 0=周日，与 parseRRule 的约定一致
      const names = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      parts.push(`BYDAY=${rule.byDay.map((day) => names[day] ?? 'MO').join(',')}`);
    }
    return parts.join(';');
  };

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MailForge//Calendar//CN',
    `X-WR-CALNAME:${calendarName}`,
    ...events.flatMap((event) => [
      'BEGIN:VEVENT',
      `UID:${event.uid}`,
      `DTSTAMP:${format(Date.now())}`,
      ...(event.allDay
        ? [
            `DTSTART;VALUE=DATE:${formatDate(event.startsAt)}`,
            `DTEND;VALUE=DATE:${formatDate(event.endsAt)}`,
          ]
        : [`DTSTART:${format(event.startsAt)}`, `DTEND:${format(event.endsAt)}`]),
      `SUMMARY:${event.summary.replace(/\n/g, '\\n')}`,
      ...(event.location ? [`LOCATION:${event.location.replace(/\n/g, '\\n')}`] : []),
      ...(event.description ? [`DESCRIPTION:${event.description.replace(/\n/g, '\\n')}`] : []),
      ...(event.rrule ? [`RRULE:${formatRule(event.rrule)}`] : []),
      // EXDATE：被单独删除（或改到别处）的那些实例
      ...(event.exdates.length > 0
        ? [`EXDATE:${event.exdates.map((ms) => format(ms)).join(',')}`]
        : []),
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
    '',
  ];

  return lines.join('\r\n');
}
