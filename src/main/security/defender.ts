import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ScanInput, ScanResult } from '../../shared/types';
import type { ScanProvider } from './virustotal';

/** 单个文件扫描的硬上限：超时就当未知，绝不能让一个卡住的任务拖住整封邮件。 */
const TIMEOUT_MS = 30_000;

/**
 * 找 `MpCmdRun.exe`。
 *
 * Windows 10/11 上 `C:\Program Files\Windows Defender\MpCmdRun.exe` 往往只是个转发器，
 * 真正的二进制在 `%ProgramData%\Microsoft\Windows Defender\Platform\<版本>\` 下，版本号会变，
 * 所以要先按版本号倒序探测 Platform 目录，再退回固定路径。
 */
export function findMpCmdRun(): string | null {
  if (process.platform !== 'win32') return null;

  const candidates: string[] = [];
  const programData = process.env.ProgramData ?? 'C:\\ProgramData';
  const platformDir = path.join(programData, 'Microsoft', 'Windows Defender', 'Platform');

  try {
    const versions = fs
      .readdirSync(platformDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => compareVersion(b, a));
    for (const version of versions) {
      candidates.push(path.join(platformDir, version, 'MpCmdRun.exe'));
    }
  } catch {
    // 目录不存在就只走固定路径
  }

  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  candidates.push(path.join(programFiles, 'Windows Defender', 'MpCmdRun.exe'));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续探测下一个
    }
  }
  return null;
}

function compareVersion(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0);
  const right = b.split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Windows 自带的 Microsoft Defender（本地内容扫描）。
 *
 * 优势是文件不出本机、无需 API Key、病毒库跟系统更新走；
 * 代价是每个文件起一个进程（必须串行）、可能锁住文件、企业环境常被策略禁用。
 */
export class DefenderProvider implements ScanProvider {
  readonly id = 'defender';
  readonly name = 'Microsoft Defender';
  readonly supports: Array<'url' | 'attachment'> = ['attachment'];
  /** 每文件一个进程，并发会把磁盘和 CPU 打满。 */
  readonly concurrency = 1;

  isAvailable(): { available: boolean; reason?: string } {
    if (process.platform !== 'win32') {
      return { available: false, reason: '仅 Windows 可用' };
    }
    return findMpCmdRun()
      ? { available: true }
      : { available: false, reason: '找不到 MpCmdRun.exe（Defender 可能被策略禁用）' };
  }

  scan(input: ScanInput, signal?: AbortSignal): Promise<ScanResult> {
    const startedAt = Date.now();
    const unknown = (detail: string): ScanResult => ({
      verdict: 'unknown',
      source: this.name,
      detail,
      scannedAt: Date.now(),
    });

    const file = input.type === 'attachment' ? input.localPath : undefined;
    // 没有本地副本时无从扫描：返回 unknown 而不是 clean
    if (!file) return Promise.resolve(unknown('没有本地文件副本'));

    const exe = findMpCmdRun();
    if (!exe) return Promise.resolve(unknown('Defender 不可用'));

    return new Promise<ScanResult>((resolve) => {
      const child = spawn(
        exe,
        ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation', '-NoLogo'],
        { windowsHide: true },
      );

      let settled = false;
      const finish = (result: ScanResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(unknown('扫描超时'));
      }, TIMEOUT_MS);

      const onAbort = (): void => {
        child.kill();
        finish(unknown('已取消'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', () => finish(unknown('无法启动扫描进程')));

      child.on('close', (code) => {
        // 0 = 未检出；2 = 发现威胁；其余一律 unknown —— 绝不能把出错当成"安全"
        if (code === 2) {
          finish({
            verdict: 'malicious',
            source: this.name,
            detail: 'Defender 报告检测到威胁',
            scannedAt: Date.now(),
          });
          return;
        }
        if (code === 0) {
          finish({
            verdict: 'clean',
            source: this.name,
            detail: `Defender 未检出（${Math.round((Date.now() - startedAt) / 100) / 10}s）`,
            scannedAt: Date.now(),
          });
          return;
        }
        finish(unknown(`Defender 退出码 ${code ?? 'null'}`));
      });
    });
  }
}
