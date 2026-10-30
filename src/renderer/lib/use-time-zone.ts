/**
 * 时区设置的渲染进程入口。
 *
 * 首次打开（设置里没有值）时自动读取系统时区并写回库里，
 * 之后用户在设置里改成别的时区就以库里的值为准。
 */
import { useEffect, useState } from 'react';
import { TIMEZONE_KEY, normalizeTimeZone, systemTimeZone } from '../../shared/timezone';

export const TIMEZONE_EVENT = 'mf:timezone-changed';

/** 设置页改完时区后调用，通知同窗口已挂载的组件。 */
export function broadcastTimeZone(timeZone: string): void {
  window.dispatchEvent(new CustomEvent<string>(TIMEZONE_EVENT, { detail: timeZone }));
}

export function useTimeZone(): string {
  const [timeZone, setTimeZone] = useState<string>(() => systemTimeZone());

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await window.api.getSetting(TIMEZONE_KEY);
        if (cancelled) return;
        const raw = result.ok ? result.data : null;
        if (raw === null) {
          // 第一次打开：把系统时区落库，用户之后可以改
          const system = systemTimeZone();
          void window.api.setSetting(TIMEZONE_KEY, system);
          setTimeZone(system);
          return;
        }
        setTimeZone(normalizeTimeZone(raw));
      } catch {
        // 读取失败就保持系统时区，绝不因此让日历打不开
      }
    })();

    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === 'string') setTimeZone(normalizeTimeZone(detail));
    };
    window.addEventListener(TIMEZONE_EVENT, onChange);

    return () => {
      cancelled = true;
      window.removeEventListener(TIMEZONE_EVENT, onChange);
    };
  }, []);

  return timeZone;
}
