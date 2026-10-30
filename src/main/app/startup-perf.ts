import { recordMetric } from '../observability/metrics';

/**
 * 启动性能基线（§25.4）。
 * 口径：进程创建（spawn）→ 渲染进程完成首次挂载（可交互）。
 */

const moduleLoadedAt = Date.now();

function processCreationTime(): number {
  const getter = (process as unknown as { getCreationTime?: () => number | null }).getCreationTime;
  if (typeof getter === 'function') {
    try {
      const value = getter.call(process);
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    } catch {
      // ignore
    }
  }
  return moduleLoadedAt;
}

export function processStartedAt(): number {
  return processCreationTime();
}

let interactiveMs: number | null = null;

/** 渲染进程首次挂载后调用一次。 */
export function markInteractive(mountMs: number): number {
  if (interactiveMs !== null) return interactiveMs;
  const startedAt = processCreationTime();
  const elapsed = Date.now() - startedAt;
  interactiveMs = elapsed;

  recordMetric('startup_time', {
    ms: elapsed,
    mountMs: Math.round(mountMs),
  });

  return elapsed;
}

export function getStartupMs(): number | null {
  return interactiveMs;
}
