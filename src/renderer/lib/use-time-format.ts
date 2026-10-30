/**
 * 时间显示格式（12 / 24 小时制）的渲染进程入口。
 *
 * 读取时机：组件挂载时读一次。设置页改动后还会派发一个同窗口事件，
 * 让**已经挂载**的列表 / 日历立刻跟着变 —— 只靠「切换视图会重新挂载」
 * 太脆弱：一旦哪天改成常驻渲染，用户就会看到「设置改了没生效」。
 */
import { useEffect, useState } from 'react';
import { DEFAULT_TIME_FORMAT, type TimeFormat } from '../../shared/calendar-settings';
import { readTimeFormat } from './calendar-settings';

export const TIME_FORMAT_EVENT = 'mf:time-format-changed';

/** 设置页写完设置后调用，通知同窗口的时间显示组件。 */
export function broadcastTimeFormat(format: TimeFormat): void {
  window.dispatchEvent(new CustomEvent<TimeFormat>(TIME_FORMAT_EVENT, { detail: format }));
}

export function useTimeFormat(): TimeFormat {
  const [format, setFormat] = useState<TimeFormat>(DEFAULT_TIME_FORMAT);

  useEffect(() => {
    let cancelled = false;
    void readTimeFormat().then((value) => {
      if (!cancelled) setFormat(value);
    });

    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<TimeFormat>).detail;
      if (detail === '12' || detail === '24') setFormat(detail);
    };
    window.addEventListener(TIME_FORMAT_EVENT, onChange);

    return () => {
      cancelled = true;
      window.removeEventListener(TIME_FORMAT_EVENT, onChange);
    };
  }, []);

  return format;
}
