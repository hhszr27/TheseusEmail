import os from 'node:os';
import type { RecoveryInfo } from '../../shared/ipc';
import { getRecentLogs } from '../observability/logger';

/**
 * 进程级故障分类与恢复（§25.1）。
 *
 * 关键原则：渲染进程崩溃后不自动重载。自动重载会在用户复制诊断信息前抹掉证据。
 */

export interface CrashRecord {
  reason: string;
  exitCode: number;
  source: string;
  occurredAt: number;
  detail?: string;
}

/** Chromium 的 clean-exit 属于正常退出，不能当作崩溃。 */
export function isCrashReason(reason: string): boolean {
  return reason !== 'clean-exit';
}

export function classifyProcessGone(details: { reason: string; exitCode: number }): boolean {
  if (!isCrashReason(details.reason)) return false;
  // 被系统正常终止（killed）不算崩溃，但需要记录
  if (details.reason === 'killed' && details.exitCode === 0) return false;
  return true;
}

export class FaultRecovery {
  private crash: CrashRecord | null = null;
  private gpuCrashCount = 0;

  recordCrash(details: { reason: string; exitCode: number }, source: string, detail?: string): void {
    this.crash = {
      reason: details.reason,
      exitCode: details.exitCode,
      source,
      occurredAt: Date.now(),
      ...(detail ? { detail } : {}),
    };
  }

  recordGpuCrash(): number {
    this.gpuCrashCount += 1;
    return this.gpuCrashCount;
  }

  getGpuCrashCount(): number {
    return this.gpuCrashCount;
  }

  clear(): void {
    this.crash = null;
  }

  hasCrash(): boolean {
    return this.crash !== null;
  }

  buildRecoveryInfo(appVersion: string, electronVersion: string): RecoveryInfo | null {
    if (!this.crash) return null;
    return {
      reason: this.crash.reason,
      exitCode: this.crash.exitCode,
      source: this.crash.source,
      occurredAt: this.crash.occurredAt,
      appVersion,
      electronVersion,
      recentLogs: getRecentLogs(60),
      reloadLabel: '重新加载',
    };
  }

  /** 供诊断页展示的运行时信息（不含任何邮件内容）。 */
  runtimeSummary(): Record<string, string | number> {
    return {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      gpuCrashes: this.gpuCrashCount,
      pid: process.pid,
    };
  }
}
