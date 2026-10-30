import type { MetricEvent } from '../../shared/types';
import { log } from './logger';

/**
 * 进程内轻量指标采集（§25.3）。不引入外部 APM SDK。
 * 隐私边界：不记录邮件内容、主题、发件人地址；队列只记录计数。
 */
export function recordMetric(
  type: MetricEvent['type'],
  payload: Record<string, number | string> = {},
): void {
  log.info('metric', type, {
    metric: type,
    timestamp: Date.now(),
    ...payload,
  });
}
