import type { TimeFormat } from '../../shared/calendar-settings';

/**
 * 自绘时间输入（小时 / 分钟 / 可选的 AM-PM）。
 *
 * 为什么不用 `<input type="time">`：它的显示格式由**操作系统的区域设置**决定，
 * 应用内选 12/24 小时制对它无效 —— 用户会遇到「设置里改了 24 小时，输入框还是 12 小时」。
 * 这里把格式完全交给 `timeFormat`，`value` 内部始终是 24 小时语义的 `"14:30"`。
 */
interface CalendarTimeFieldProps {
  /** 24 小时语义的 `"14:30"`。 */
  value: string;
  onChange(next: string): void;
  /** 无障碍标签前缀，如「开始」→「开始时间-小时」。 */
  label: string;
  timeFormat: TimeFormat;
}

const HOURS_24 = Array.from({ length: 24 }, (_, index) => index);
const HOURS_12 = Array.from({ length: 12 }, (_, index) => index + 1);
const MINUTES = Array.from({ length: 60 }, (_, index) => index);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function parseTime(value: string): { hour: number; minute: number } {
  const [hourText = '0', minuteText = '0'] = value.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return {
    hour: Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 0,
    minute: Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0,
  };
}

export function CalendarTimeField({
  value,
  onChange,
  label,
  timeFormat,
}: CalendarTimeFieldProps): JSX.Element {
  const { hour, minute } = parseTime(value);
  const is12 = timeFormat === '12';
  const period: 'AM' | 'PM' = hour < 12 ? 'AM' : 'PM';
  const displayHour = is12 ? (hour % 12 === 0 ? 12 : hour % 12) : hour;

  const commit = (nextHour: number, nextMinute: number): void => {
    onChange(`${pad(nextHour)}:${pad(nextMinute)}`);
  };

  return (
    <div className="calendar-time-field">
      <select
        className="input"
        aria-label={`${label}时间-小时`}
        value={displayHour}
        onChange={(event) => {
          const picked = Number(event.target.value);
          // 12 小时制下要还原上午/下午：12 AM → 0 点，12 PM → 12 点
          const nextHour = is12 ? (picked % 12) + (period === 'PM' ? 12 : 0) : picked;
          commit(nextHour, minute);
        }}
      >
        {(is12 ? HOURS_12 : HOURS_24).map((item) => (
          <option key={item} value={item}>
            {pad(item)}
          </option>
        ))}
      </select>

      <span className="calendar-time-sep" aria-hidden="true">
        :
      </span>

      <select
        className="input"
        aria-label={`${label}时间-分钟`}
        value={minute}
        onChange={(event) => commit(hour, Number(event.target.value))}
      >
        {MINUTES.map((item) => (
          <option key={item} value={item}>
            {pad(item)}
          </option>
        ))}
      </select>

      {is12 ? (
        <select
          className="input"
          aria-label={`${label}时间-时段`}
          value={period}
          onChange={(event) => {
            const nextPeriod = event.target.value === 'PM' ? 'PM' : 'AM';
            commit((hour % 12) + (nextPeriod === 'PM' ? 12 : 0), minute);
          }}
        >
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      ) : null}
    </div>
  );
}
