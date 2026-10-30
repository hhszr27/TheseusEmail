import { useEffect, useState } from 'react';
import type {
  CalendarEventKind,
  CalendarEventScope,
  CalendarEventView,
  CalendarRecurrence,
} from '../../shared/ipc';
import { CalendarScopeDialog } from './CalendarScopeDialog';
import { CalendarTimeField } from './CalendarTimeField';
import type { TimeFormat } from '../../shared/calendar-settings';
import {
  systemTimeZone,
  zonedMinutesOfDay,
  zonedParts,
  zonedTimeToUtc,
} from '../../shared/timezone';

/** 提交给主进程的事件字段（新建与修改共用）。 */
type EventPayload = {
  kind: CalendarEventKind;
  summary: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location?: string;
  description?: string;
  rrule?: CalendarRecurrence;
};

/**
 * 新建 / 编辑日历事件弹窗（日程 / 会议 / 纪念日 / 生日）。
 *
 * - 新建：双击日历里的某一天（或某个半小时格）打开，默认日期就是那一天。
 * - 编辑：点已有的本地事件打开，字段回填，底部出现「删除」（两段式确认）。
 *   远程同步来的事件点不开编辑 —— 它们改不回服务器，删了也会被下次同步拉回来。
 */
interface CalendarEventDialogProps {
  /** 默认日期（新建时用；编辑时以事件自身的日期为准）。 */
  date: Date;
  /** 双击的起始分钟（0–1439，周视图半小时格）；省略时按 9:00。 */
  startMinute?: number;
  /** 有值即编辑模式。 */
  event?: CalendarEventView;
  /** 时间显示格式（12 小时制时在输入框旁补一行「2:30 PM」）。 */
  timeFormat?: TimeFormat;
  /** 时区：决定「某天某时」换算成哪个 UTC 时间戳。 */
  timeZone?: string;
  onClose(): void;
  /** 新建或保存成功后调用：面板负责刷新数据。 */
  onSaved(): void;
  /** 删除成功后调用。 */
  onDeleted?(): void;
}

const KIND_OPTIONS: { id: CalendarEventKind; label: string }[] = [
  { id: 'event', label: '日程' },
  { id: 'meeting', label: '会议' },
  { id: 'anniversary', label: '纪念日' },
  { id: 'birthday', label: '生日' },
];

function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function toTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function CalendarEventDialog({
  date,
  startMinute,
  event,
  timeFormat = '24',
  timeZone = systemTimeZone(),
  onClose,
  onSaved,
  onDeleted,
}: CalendarEventDialogProps): JSX.Element {
  // 起始时间限制在 00:00–23:30，默认 9:00；结束默认 +1 小时（23:30 起则 23:59 收口）
  // 回填与换算都按「所选时区」，否则换个时区打开会差几个小时
  const baseParts = event ? zonedParts(event.startsAt, timeZone) : null;
  const baseDate = baseParts
    ? new Date(baseParts.year, baseParts.month - 1, baseParts.day)
    : date;
  const initialStart = event
    ? Math.min(23 * 60 + 30, Math.max(0, zonedMinutesOfDay(event.startsAt, timeZone)))
    : Math.min(23 * 60 + 30, Math.max(0, startMinute ?? 9 * 60));
  const initialEnd = event
    ? (() => {
        const minutes = zonedMinutesOfDay(event.endsAt, timeZone);
        // 跨天或异常时长（结束早于开始）时退回 +1 小时
        return minutes > initialStart ? minutes : Math.min(initialStart + 60, 23 * 60 + 59);
      })()
    : Math.min(initialStart + 60, 23 * 60 + 59);

  const [kind, setKind] = useState<CalendarEventKind>(event?.kind ?? 'event');
  const [summary, setSummary] = useState(event?.summary ?? '');
  const [day, setDay] = useState(() => toDateInput(baseDate));
  const [allDay, setAllDay] = useState(event?.allDay ?? false);
  const [startTime, setStartTime] = useState(() =>
    toTimeInput(Math.floor(initialStart / 60), initialStart % 60),
  );
  const [endTime, setEndTime] = useState(() =>
    toTimeInput(Math.floor(initialEnd / 60), initialEnd % 60),
  );
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  /** 重复频率；空串表示单次事件。 */
  const [repeat, setRepeat] = useState<'' | CalendarRecurrence['freq']>(event?.rrule?.freq ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 删除要按两次：第一次只是把按钮变成「确认删除？」。 */
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** 重复事件的范围选择（删除 / 修改）。 */
  const [scopePrompt, setScopePrompt] = useState<'delete' | 'edit' | null>(null);
  /** 选完范围后要提交的修改内容。 */
  const [pendingPayload, setPendingPayload] = useState<EventPayload | null>(null);

  useEffect(() => {
    const onKey = (keyboardEvent: KeyboardEvent): void => {
      if (keyboardEvent.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 纪念日/生日通常没有具体时刻，切过去时自动勾上「全天」。 */
  const pickKind = (next: CalendarEventKind): void => {
    setKind(next);
    if (next === 'anniversary' || next === 'birthday') setAllDay(true);
  };

  const applySave = async (payload: EventPayload, scope?: CalendarEventScope): Promise<void> => {
    setBusy(true);
    const result = event
      ? await window.api.updateCalendarEvent({
          id: event.id,
          ...payload,
          ...(scope ? { scope, occurrenceStart: event.startsAt } : {}),
        })
      : await window.api.createCalendarEvent(payload);
    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
  };

  const applyDelete = async (scope?: CalendarEventScope): Promise<void> => {
    if (!event) return;
    setBusy(true);
    const result = await window.api.deleteCalendarEvent({
      id: event.id,
      ...(scope ? { occurrenceStart: event.startsAt, scope } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onDeleted?.();
  };

  const submit = async (): Promise<void> => {
    if (!summary.trim()) {
      setError('请填写标题');
      return;
    }
    const [year, month, dateOfMonth] = day.split('-').map(Number);
    if (!year || !month || !dateOfMonth) {
      setError('请选择日期');
      return;
    }

    const [startHour, startMinuteOfInput] = startTime.split(':').map(Number);
    const [endHour, endMinuteOfInput] = endTime.split(':').map(Number);
    const startsAt = zonedTimeToUtc(
      year,
      month,
      dateOfMonth,
      allDay ? 0 : (startHour ?? 0),
      allDay ? 0 : (startMinuteOfInput ?? 0),
      0,
      timeZone,
    );
    const endsAt = allDay
      ? startsAt + 24 * 60 * 60 * 1000
      : zonedTimeToUtc(
          year,
          month,
          dateOfMonth,
          endHour ?? 0,
          endMinuteOfInput ?? 0,
          0,
          timeZone,
        );

    if (!allDay && endsAt <= startsAt) {
      setError('结束时间要晚于开始时间');
      return;
    }

    const payload = {
      kind,
      summary: summary.trim(),
      startsAt,
      endsAt,
      allDay,
      ...(location.trim() ? { location: location.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(repeat ? { rrule: { freq: repeat, interval: 1 } } : {}),
    };

    // 重复事件改了时间：先问影响范围（仅此 / 此及后续 / 全部）
    const timeChanged =
      !!event &&
      !!event.rrule &&
      (Math.floor(startsAt / 60_000) !== Math.floor(event.startsAt / 60_000) ||
        Math.floor(endsAt / 60_000) !== Math.floor(event.endsAt / 60_000));
    if (timeChanged) {
      setPendingPayload(payload);
      setScopePrompt('edit');
      return;
    }

    await applySave(payload);
  };

  const remove = async (): Promise<void> => {
    if (!event) return;
    // 重复事件先选范围（6 种）；单次事件仍用两段式确认
    if (event.rrule) {
      setScopePrompt('delete');
      return;
    }
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await applyDelete();
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(mouseEvent) => mouseEvent.target === mouseEvent.currentTarget && onClose()}
    >
      <div
        className="modal calendar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-dialog-title"
      >
        <div className="modal-header">
          <h2 className="modal-title" id="calendar-dialog-title">
            {event ? '编辑' : '新建'}
          </h2>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
        </div>

        <div className="modal-body calendar-dialog-body">
          <div className="calendar-kind-tabs" role="tablist" aria-label="事件类型">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="tab"
                aria-selected={kind === option.id}
                className={`calendar-kind-tab${kind === option.id ? ' is-active' : ''}`}
                onClick={() => pickKind(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="calendar-field">
            <span>标题</span>
            <input
              className="input"
              value={summary}
              placeholder={kind === 'meeting' ? '会议主题' : '事件标题'}
              aria-label="标题"
              autoFocus
              onChange={(inputEvent) => setSummary(inputEvent.target.value)}
            />
          </label>

          <div className="calendar-field-row">
            <label className="calendar-field">
              <span>日期</span>
              <input
                className="input"
                type="date"
                value={day}
                aria-label="日期"
                onChange={(inputEvent) => setDay(inputEvent.target.value)}
              />
            </label>
            <label className="calendar-check">
              <input
                type="checkbox"
                checked={allDay}
                onChange={(inputEvent) => setAllDay(inputEvent.target.checked)}
              />
              <span>全天</span>
            </label>
          </div>

          <label className="calendar-field">
            <span>重复</span>
            <select
              className="input"
              value={repeat}
              aria-label="重复"
              onChange={(inputEvent) =>
                setRepeat(inputEvent.target.value as '' | CalendarRecurrence['freq'])
              }
            >
              <option value="">不重复</option>
              <option value="DAILY">每天</option>
              <option value="WEEKLY">每周</option>
              <option value="MONTHLY">每月</option>
              <option value="YEARLY">每年</option>
            </select>
          </label>

          {!allDay ? (
            <div className="calendar-field-row">
              <label className="calendar-field">
                <span>开始</span>
                <CalendarTimeField
                  label="开始"
                  value={startTime}
                  timeFormat={timeFormat}
                  onChange={setStartTime}
                />
              </label>
              <label className="calendar-field">
                <span>结束</span>
                <CalendarTimeField
                  label="结束"
                  value={endTime}
                  timeFormat={timeFormat}
                  onChange={setEndTime}
                />
              </label>
            </div>
          ) : null}

          <label className="calendar-field">
            <span>地点</span>
            <input
              className="input"
              value={location}
              placeholder="可选"
              aria-label="地点"
              onChange={(inputEvent) => setLocation(inputEvent.target.value)}
            />
          </label>

          <label className="calendar-field">
            <span>备注</span>
            <textarea
              className="input calendar-notes"
              rows={3}
              value={description}
              placeholder="可选"
              aria-label="备注"
              onChange={(inputEvent) => setDescription(inputEvent.target.value)}
            />
          </label>

          <p className="hint calendar-dialog-hint">
            {repeat ? '重复事件会按所选频率展开；编辑或删除会作用于整个系列。' : ''}
            已连接可写 CalDAV 日历时会自动同步到服务器，否则只保存在本机。
          </p>

          {error ? <p className="error-banner">{error}</p> : null}
        </div>

        <div className="modal-footer">
          {event ? (
            <button
              type="button"
              className={`btn btn-danger calendar-delete${confirmDelete ? ' is-confirming' : ''}`}
              onClick={() => void remove()}
              disabled={busy}
            >
              {confirmDelete ? '确认删除？' : '删除'}
            </button>
          ) : null}
          <span className="calendar-dialog-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {scopePrompt ? (
        <CalendarScopeDialog
          mode={scopePrompt}
          summary={summary || event?.summary || ''}
          onClose={() => {
            setScopePrompt(null);
            setPendingPayload(null);
          }}
          onPick={(scope) => {
            const action = scopePrompt;
            setScopePrompt(null);
            if (action === 'edit' && pendingPayload) {
              const payload = pendingPayload;
              setPendingPayload(null);
              void applySave(payload, scope);
            } else if (action === 'delete') {
              void applyDelete(scope);
            }
          }}
        />
      ) : null}
    </div>
  );
}
