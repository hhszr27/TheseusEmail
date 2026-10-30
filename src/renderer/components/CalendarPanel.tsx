import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarAccountView, CalendarEventView } from '../../shared/ipc';
import {
  DEFAULT_WORK_HOURS,
  formatClock,
  formatHourLabel,
  isWorkHour,
  type WorkHours,
} from '../../shared/calendar-settings';
import { readWorkHours } from '../lib/calendar-settings';
import { useTimeFormat } from '../lib/use-time-format';
import { useTimeZone } from '../lib/use-time-zone';
import { zonedDayKey, zonedMinutesOfDay, zonedParts } from '../../shared/timezone';
import { CalendarEventDialog } from './CalendarEventDialog';

/**
 * 日历面板（§16.5）：以插槽式独立面板呈现，不接管邮件阅读视图。
 *
 * 月视图与周视图共用同一份 `events`（按当前视图的时间范围查），
 * 单击日期选中、双击日期打开「新建事件」弹窗。
 */

type CalendarMode = 'month' | 'week';

interface CalendarPanelProps {
  /** 返回邮件（右上角「返回邮件」按钮 / Esc）。 */
  onBack(): void;
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

/** 周视图时间轴：0–23 点，每小时一行。 */
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** 单行小时高度（px）；事件块按分钟比例定位，跨小时也能画对。 */
const HOUR_HEIGHT = 44;
/** 每小时拆成上下两个半小时格：双击 14:30 就建 14:30 的事。 */
const HALF_HOURS = Array.from({ length: 48 }, (_, index) => ({
  index,
  hour: Math.floor(index / 2),
  minute: index % 2 === 0 ? 0 : 30,
}));

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** 周一为一周第一天。 */
function startOfWeek(date: Date): Date {
  const offset = (date.getDay() + 6) % 7;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
  start.setHours(0, 0, 0, 0);
  return start;
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 月视图固定 42 格（含补白的前后两周）。 */
function monthCells(cursor: Date): Date[] {
  const first = startOfMonth(cursor);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function weekDays(cursor: Date): Date[] {
  const start = startOfWeek(cursor);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function formatWeekRange(days: Date[]): string {
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const fmt = (date: Date): string => `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return first.getFullYear() === last.getFullYear()
    ? `${fmt(first)} – ${fmt(last)}`
    : `${first.getFullYear()} 年 ${fmt(first)} – ${last.getFullYear()} 年 ${fmt(last)}`;
}

export function CalendarPanel({ onBack }: CalendarPanelProps): JSX.Element {
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [mode, setMode] = useState<CalendarMode>('month');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** 周视图选中的半小时格：`dayKey|slotIndex`；null = 没选具体时段。 */
  const [selectedSlotKey, setSelectedSlotKey] = useState<string | null>(null);
  /** 双击的日期；非空时显示新建弹窗。 */
  const [createDate, setCreateDate] = useState<Date | null>(null);
  /** 点击的本地事件；非空时显示编辑弹窗。 */
  const [editingEvent, setEditingEvent] = useState<CalendarEventView | null>(null);
  /** 双击时间轴时记下的起始分钟（0–1439）；null = 不是从具体时段打开的（默认 9:00）。 */
  const [createStartMinute, setCreateStartMinute] = useState<number | null>(null);
  const [events, setEvents] = useState<CalendarEventView[]>([]);
  const [accounts, setAccounts] = useState<CalendarAccountView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 工作时间（来自设置，默认 9–18）；非工作小时在周视图里灰掉。 */
  const [workHours, setWorkHours] = useState<WorkHours>(DEFAULT_WORK_HOURS);
  /** 时间显示格式（12/24 小时制，来自设置）。 */
  const timeFormat = useTimeFormat();
  /** 时区（首次打开自动取系统时区，可在设置里改）。 */
  const timeZone = useTimeZone();
  const weekScrollRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({
    kind: 'caldav' as 'caldav' | 'ics',
    name: '',
    url: '',
    username: '',
    password: '',
  });

  const cells = useMemo(
    () => (mode === 'month' ? monthCells(cursor) : weekDays(cursor)),
    [cursor, mode],
  );

  const load = useCallback(async (base: Date, view: CalendarMode) => {
    const range = view === 'month' ? monthCells(base) : weekDays(base);
    const from = new Date(range[0]!).setHours(0, 0, 0, 0);
    const last = range[range.length - 1]!;
    const to = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).getTime();

    const [eventsResult, accountsResult] = await Promise.all([
      window.api.listCalendarEvents({ from, to }),
      window.api.listCalendarAccounts(),
    ]);
    if (eventsResult.ok) setEvents(eventsResult.data);
    else setError(eventsResult.error.message);
    if (accountsResult.ok) setAccounts(accountsResult.data);
  }, []);

  useEffect(() => {
    void load(cursor, mode);
  }, [cursor, mode, load]);

  useEffect(() => {
    let cancelled = false;
    void readWorkHours().then((value) => {
      if (!cancelled) setWorkHours(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 打开周视图时滚到工作时间开始前一点，避免每次都从 0 点看起
  useEffect(() => {
    if (mode !== 'week') return;
    const element = weekScrollRef.current;
    if (element) element.scrollTop = Math.max(0, (workHours.start - 1) * HOUR_HEIGHT);
  }, [mode, workHours.start]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 新建弹窗自己处理 Esc：这里再返回邮件会把两层一起关掉
      if (createDate) return;
      onBack();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onBack, createDate]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEventView[]>();
    for (const event of events) {
      // 落在哪一列由「所选时区的日期」决定，不是系统时区
      const key = zonedDayKey(event.startsAt, timeZone);
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
    }
    return map;
  }, [events, timeZone]);

  // 「今天」也按所选时区算（跨时区时可能和系统日期差一天）
  const nowParts = zonedParts(Date.now(), timeZone);
  const today = new Date(nowParts.year, nowParts.month - 1, nowParts.day);

  const shift = (delta: number): void => {
    if (mode === 'month') {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + delta, 1));
    } else {
      const next = new Date(cursor);
      next.setDate(cursor.getDate() + delta * 7);
      setCursor(startOfWeek(next));
    }
  };

  const goToday = (): void => {
    setCursor(mode === 'month' ? startOfMonth(today) : startOfWeek(today));
    setSelectedKey(dayKey(today));
  };

  const sync = async (): Promise<void> => {
    setBusy(true);
    const result = await window.api.syncCalendar();
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    const failed = result.data.find((item) => item.error);
    setError(failed?.error ?? null);
    await load(cursor, mode);
  };

  const addAccount = async (): Promise<void> => {
    if (!form.name.trim() || !form.url.trim()) {
      setError('请填写名称与地址');
      return;
    }
    setBusy(true);
    const result = await window.api.addCalendarAccount({
      kind: form.kind,
      name: form.name,
      url: form.url,
      ...(form.username ? { username: form.username } : {}),
      ...(form.password ? { password: form.password } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setForm({ kind: 'caldav', name: '', url: '', username: '', password: '' });
    setError(null);
    await load(cursor, mode);
  };

  const renderEvent = (event: CalendarEventView): JSX.Element => (
    <button
      type="button"
      className={`calendar-event calendar-event-${event.kind ?? 'event'}`}
      key={`${event.id}|${event.startsAt}`}
      title={[event.summary, event.location, event.description].filter(Boolean).join(' · ')}
      onClick={(clickEvent) => {
        // 单击只定位到那一天，不弹窗；编辑交给双击（避免误触）
        clickEvent.stopPropagation();
        setSelectedKey(dayKey(new Date(event.startsAt)));
      }}
      onDoubleClick={(doubleEvent) => {
        doubleEvent.stopPropagation();
        // 只有本地事件能编辑；远程订阅事件保持只读
        if (event.calendarId === 'local') {
          setEditingEvent(event);
          setCreateDate(null);
        }
      }}
    >
      {event.allDay ? '全天 · ' : ''}
      {event.summary}
    </button>
  );

  return (
    <>
      <section className="main-view calendar-view" aria-label="日历">
        <header className="view-header">
          <div>
            <h1 className="view-title" id="calendar-title">
              日历
            </h1>
            <p className="hint">单击选中日期，双击日期新建日程 / 会议 / 纪念日 / 生日。</p>
          </div>
          <button type="button" className="btn" onClick={onBack}>
            返回邮件
          </button>
        </header>

        <div className="view-body calendar-body">
          {error ? <p className="error-banner">{error}</p> : null}

          <div className="calendar-toolbar">
            <button type="button" className="btn calendar-today" onClick={goToday}>
              今天
            </button>
            <button
              type="button"
              className="btn calendar-nav-btn"
              title={mode === 'month' ? '上个月' : '上一周'}
              aria-label={mode === 'month' ? '上个月' : '上一周'}
              onClick={() => shift(-1)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <strong>
              {mode === 'month'
                ? `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`
                : formatWeekRange(cells)}
            </strong>
            <button
              type="button"
              className="btn calendar-nav-btn"
              title={mode === 'month' ? '下个月' : '下一周'}
              aria-label={mode === 'month' ? '下个月' : '下一周'}
              onClick={() => shift(1)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>

            <div className="calendar-modes" role="tablist" aria-label="视图">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'month'}
                className={`calendar-mode${mode === 'month' ? ' is-active' : ''}`}
                onClick={() => setMode('month')}
              >
                月
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'week'}
                className={`calendar-mode${mode === 'week' ? ' is-active' : ''}`}
                onClick={() => setMode('week')}
              >
                周
              </button>
            </div>

            <span className="statusbar-spacer" />
            <button type="button" className="btn" onClick={() => void sync()} disabled={busy}>
              {busy ? '同步中…' : '同步日历'}
            </button>
          </div>

          {mode === 'month' ? (
            <div className="calendar-grid" role="grid" aria-label="月视图">
              {WEEKDAYS.map((label) => (
                <div className="calendar-weekday" key={label} role="columnheader">
                  {label}
                </div>
              ))}
              {cells.map((date) => {
                const key = dayKey(date);
                const inMonth = date.getMonth() === cursor.getMonth();
                const dayEvents = byDay.get(key) ?? [];
                const selected = selectedKey === key;
                return (
                  <div
                    className={[
                      'calendar-cell',
                      inMonth ? '' : 'calendar-cell-muted',
                      selected ? 'is-selected' : '',
                      sameDay(date, today) ? 'is-today' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    key={key}
                    role="gridcell"
                    aria-selected={selected}
                    title="双击新建"
                    onClick={() => setSelectedKey(key)}
                    onDoubleClick={() => {
                      setCreateStartMinute(null);
                      setCreateDate(date);
                    }}
                  >
                    <span className="calendar-day">{date.getDate()}</span>
                    <div className="calendar-events">
                      {dayEvents.slice(0, 3).map(renderEvent)}
                      {dayEvents.length > 3 ? (
                        <span className="calendar-more">+{dayEvents.length - 3}</span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="calendar-time" role="grid" aria-label="周视图">
              <div className="calendar-time-head">
                <div className="calendar-time-gutter" aria-hidden="true" />
                {cells.map((date) => {
                  const key = dayKey(date);
                  const allDayEvents = (byDay.get(key) ?? []).filter((event) => event.allDay);
                  const selected = selectedKey === key;
                  return (
                    <div
                      className={[
                        'calendar-time-dayhead',
                        selected ? 'is-selected' : '',
                        sameDay(date, today) ? 'is-today' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      key={key}
                      role="columnheader"
                      aria-selected={selected}
                      title="双击新建"
                      onClick={() => {
                        setSelectedKey(key);
                        setSelectedSlotKey(null);
                      }}
                      onDoubleClick={() => {
                        setCreateStartMinute(null);
                        setCreateDate(date);
                      }}
                    >
                      <div className="calendar-time-dayhead-main">
                        <span>周{WEEKDAYS[(date.getDay() + 6) % 7]}</span>
                        <strong>
                          {date.getMonth() + 1}/{date.getDate()}
                        </strong>
                        <button
                          type="button"
                          className="calendar-week-add"
                          title="新建"
                          aria-label={`在 ${date.getMonth() + 1} 月 ${date.getDate()} 日新建`}
                          onClick={(clickEvent) => {
                            clickEvent.stopPropagation();
                            setCreateDate(date);
                          }}
                        >
                          ＋
                        </button>
                      </div>
                      {allDayEvents.length > 0 ? (
                        <div className="calendar-time-allday">{allDayEvents.map(renderEvent)}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="calendar-time-body" ref={weekScrollRef}>
                <div className="calendar-time-gutter" aria-hidden="true">
                  {HOURS.map((hour) => (
                    <div className="calendar-time-label" key={hour}>
                      {formatHourLabel(hour, timeFormat)}
                    </div>
                  ))}
                </div>
                {cells.map((date) => {
                  const key = dayKey(date);
                  const timedEvents = (byDay.get(key) ?? []).filter((event) => !event.allDay);
                  const selected = selectedKey === key;
                  return (
                    <div
                      className={[
                        'calendar-time-col',
                        selected ? 'is-selected' : '',
                        sameDay(date, today) ? 'is-today' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      key={key}
                      role="gridcell"
                      aria-selected={selected}
                      title="双击新建"
                      onClick={() => {
                        setSelectedKey(key);
                        setSelectedSlotKey(null);
                      }}
                      onDoubleClick={() => {
                        setCreateStartMinute(null);
                        setCreateDate(date);
                      }}
                    >
                      {HALF_HOURS.map((slot) => {
                        const slotKey = `${key}|${slot.index}`;
                        const slotSelected = selectedSlotKey === slotKey;
                        return (
                          <div
                            className={[
                              'calendar-half-hour',
                              slot.minute === 0 ? 'is-hour' : 'is-half',
                              isWorkHour(slot.hour, workHours) ? '' : 'is-off-hours',
                              slotSelected ? 'is-selected' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            key={slot.index}
                            data-hour={slot.hour}
                            data-minute={slot.minute}
                            aria-selected={slotSelected}
                            onClick={(clickEvent) => {
                              // 只选这个半小时格：不 stopPropagation 的话会冒泡到列，
                              // 又被当成「点了这一天」，蓝框回到整列上
                              clickEvent.stopPropagation();
                              setSelectedSlotKey(slotKey);
                              setSelectedKey(null);
                            }}
                            onDoubleClick={(doubleEvent) => {
                              // 双击半小时格：新建窗口默认落在这个时段
                              doubleEvent.stopPropagation();
                              setCreateStartMinute(slot.hour * 60 + slot.minute);
                              setCreateDate(date);
                            }}
                          />
                        );
                      })}
                      {timedEvents.map((event) => {
                        // 位置按「所选时区的当天第几分钟」；高度按时长，跨天也不会算歪
                        const startMinutes = zonedMinutesOfDay(event.startsAt, timeZone);
                        const durationMinutes = Math.max(
                          0,
                          Math.round((event.endsAt - event.startsAt) / 60000),
                        );
                        const heightMinutes = durationMinutes > 0 ? durationMinutes : 60;
                        const top = (startMinutes / 60) * HOUR_HEIGHT;
                        const height = Math.max(20, (heightMinutes / 60) * HOUR_HEIGHT);
                        return (
                          <button
                            type="button"
                            className={`calendar-time-event calendar-event-${event.kind ?? 'event'}`}
                            key={`${event.id}|${event.startsAt}`}
                            style={{ top: `${top}px`, height: `${height}px` }}
                            title={[event.summary, event.location, event.description]
                              .filter(Boolean)
                              .join(' · ')}
                            onClick={(clickEvent) => {
                              // 单击只定位到那一天，不弹窗
                              clickEvent.stopPropagation();
                              setSelectedKey(dayKey(new Date(event.startsAt)));
                            }}
                            onDoubleClick={(doubleEvent) => {
                              doubleEvent.stopPropagation();
                              if (event.calendarId === 'local') {
                                setEditingEvent(event);
                                setCreateDate(null);
                              }
                            }}
                          >
                            <span className="calendar-time-event-title">{event.summary}</span>
                            <span className="calendar-time-event-time">
                              {formatClock(startMinutes, timeFormat)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <section className="settings-section">
            <h3 className="settings-title">日历账户</h3>
            {accounts.length === 0 ? (
              <p className="hint">尚未添加日历账户。支持 CalDAV 与只读 ICS 订阅。</p>
            ) : null}
            <ul className="calendar-accounts">
              {accounts.map((account) => (
                <li key={account.id}>
                  <span>{account.name}</span>
                  <span className="hint">
                    {account.kind === 'ics' ? 'ICS 订阅（只读）' : 'CalDAV'}
                  </span>
                  {account.lastError ? <span className="risk-badge risk-unknown">同步失败</span> : null}
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      void window.api
                        .removeCalendarAccount(account.id)
                        .then(() => void load(cursor, mode))
                    }
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>

            <div className="calendar-form">
              <select
                className="input"
                value={form.kind}
                onChange={(event) =>
                  setForm({ ...form, kind: event.target.value as 'caldav' | 'ics' })
                }
                aria-label="日历类型"
              >
                <option value="caldav">CalDAV</option>
                <option value="ics">ICS 订阅</option>
              </select>
              <input
                className="input"
                placeholder="名称"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                aria-label="日历名称"
              />
              <input
                className="input calendar-url"
                placeholder="https://…/calendars/user/calendar/"
                value={form.url}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
                aria-label="日历地址"
              />
              <input
                className="input"
                placeholder="用户名（可选）"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                aria-label="用户名"
              />
              <input
                className="input"
                type="password"
                placeholder="密码（可选）"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                aria-label="日历密码"
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void addAccount()}
                disabled={busy}
              >
                添加
              </button>
            </div>
          </section>
        </div>
      </section>

      {createDate && !editingEvent ? (
        <CalendarEventDialog
          date={createDate}
          {...(createStartMinute !== null ? { startMinute: createStartMinute } : {})}
          timeFormat={timeFormat}
          timeZone={timeZone}
          onClose={() => {
            setCreateDate(null);
            setCreateStartMinute(null);
          }}
          onSaved={() => {
            setCreateDate(null);
            setCreateStartMinute(null);
            void load(cursor, mode);
            // 写回：已入队的 PUT/DELETE 由后台同步推给服务器，失败留待下次重试
            void window.api.syncCalendar();
          }}
        />
      ) : null}

      {editingEvent ? (
        <CalendarEventDialog
          date={new Date(editingEvent.startsAt)}
          event={editingEvent}
          timeFormat={timeFormat}
          timeZone={timeZone}
          onClose={() => setEditingEvent(null)}
          onSaved={() => {
            setEditingEvent(null);
            void load(cursor, mode);
            void window.api.syncCalendar();
          }}
          onDeleted={() => {
            setEditingEvent(null);
            void load(cursor, mode);
            void window.api.syncCalendar();
          }}
        />
      ) : null}
    </>
  );
}
