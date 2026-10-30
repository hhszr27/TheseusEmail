import crypto from 'node:crypto';
import type { Db } from '../db/open';
import type { RiskLevel, ScanInput, ScanProgress, ScanResult } from '../../shared/types';
import { DEFAULT_SCAN_POLICY, extensionOf, mergeScanVerdict, type ScanPolicySettings } from '../../shared/attachments';
import type { ScanProvider } from '../security/virustotal';
import { log } from '../observability/logger';
import { recordMetric } from '../observability/metrics';

/**
 * 安全扫描编排（§12.2 / §12.3）：
 * 并发上限 3、结果缓存（24h，malicious 7d）、扫描结果原地回写。
 */

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MALICIOUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 单封邮件一次最多扫多少：几十个附件的邮件不该把队列拖死。 */
export const MAX_SCAN_ATTACHMENTS = 20;
export const MAX_SCAN_URLS = 12;

export function cacheTtlFor(verdict: ScanResult['verdict']): number {
  return verdict === 'malicious' ? MALICIOUS_TTL_MS : CACHE_TTL_MS;
}

export function cacheKeyFor(input: ScanInput): string {
  if (input.type === 'url') {
    return `url:${crypto.createHash('sha256').update(input.value).digest('hex')}`;
  }
  return `file:${input.sha256.toLowerCase()}`;
}

const URL_PATTERN = /href\s*=\s*["'](https?:\/\/[^"'\s]+)["']|src\s*=\s*["'](https?:\/\/[^"'\s]+)["']/gi;

/** 从净化后的正文中提取可扫描 URL，限制数量并跳过内网地址。 */
export function extractScannableUrls(html: string, limit = 12): string[] {
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(html)) !== null && urls.size < limit) {
    const raw = match[1] ?? match[2] ?? '';
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      if (isPrivateHost(parsed.hostname)) continue;
      urls.add(parsed.toString());
    } catch {
      // 非法 URL 直接跳过
    }
  }
  return [...urls];
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host) || host === '::1' || host === '0.0.0.0') return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return false;
}

/** 简单地以固定并发度执行任务，避免引入额外依赖。 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), tasks.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]!();
    }
  });

  await Promise.all(workers);
  return results;
}

export interface ScanUpdate {
  emailId: string;
  key: string;
  kind: 'url' | 'attachment';
  attachmentId?: string;
  target: string;
  result: ScanResult;
  riskLevel?: RiskLevel;
}

export interface AttachmentScanTarget {
  id: string;
  filename: string;
  mimeType: string;
  sha256: string;
  baseRisk: RiskLevel;
  /** 本地副本路径（Defender 之类的内容扫描器需要）。 */
  localPath?: string;
}

export interface ScanEmailInput {
  emailId: string;
  urls: string[];
  attachments: AttachmentScanTarget[];
}

export class ScanService {
  private readonly inflight = new Map<string, Promise<ScanResult>>();
  private readonly providers: ScanProvider[];
  /** 按邮件保存取消句柄：停止只影响这一封。 */
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly db: Db,
    providers: ScanProvider[],
    private readonly emit: (update: ScanUpdate) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly policy: () => ScanPolicySettings = () => DEFAULT_SCAN_POLICY,
    private readonly onProgress: (progress: ScanProgress) => void = () => undefined,
  ) {
    this.providers = providers;
  }

  /**
   * 当前真正会跑的扫描源：先看设置开关，再看可用性。
   * 不可用（如 Defender 被策略禁用）的绝不静默算作"扫过了"。
   */
  activeProviders(): ScanProvider[] {
    const policy = this.policy();
    return this.providers
      .filter((provider) => {
        if (provider.id === 'defender') return policy.providers.defender;
        if (provider.id === 'virustotal') return policy.providers.virustotal;
        return true;
      })
      .filter((provider) => provider.isAvailable?.().available !== false);
  }

  isEnabled(): boolean {
    return this.activeProviders().length > 0;
  }

  providerNames(): string[] {
    return this.providers.map((provider) => provider.name);
  }

  /** 每个扫描源的可用性：设置页用它解释"为什么没扫"。 */
  providerStatuses(): Array<{ id: string; name: string; available: boolean; reason?: string }> {
    return this.providers.map((provider) => {
      const status = provider.isAvailable?.() ?? { available: true };
      return {
        id: provider.id,
        name: provider.name,
        available: status.available,
        ...(status.reason ? { reason: status.reason } : {}),
      };
    });
  }

  private getCached(key: string): ScanResult | null {
    const row = this.db
      .prepare('SELECT result_json, expires_at FROM scan_cache WHERE key = ?')
      .get(key) as { result_json: string; expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.db.prepare('DELETE FROM scan_cache WHERE key = ?').run(key);
      return null;
    }
    try {
      return JSON.parse(row.result_json) as ScanResult;
    } catch {
      return null;
    }
  }

  private putCached(key: string, result: ScanResult): void {
    this.db
      .prepare(
        `INSERT INTO scan_cache (key, result_json, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET result_json = excluded.result_json, expires_at = excluded.expires_at`,
      )
      .run(key, JSON.stringify(result), this.now() + cacheTtlFor(result.verdict));
  }

  /** 单个来源扫描（缓存按「来源 + 目标」隔离，多源结果不会互相覆盖）。 */
  private async scanOneWith(
    provider: ScanProvider,
    input: ScanInput,
    signal?: AbortSignal,
  ): Promise<ScanResult> {
    const key = `${provider.id}:${cacheKeyFor(input)}`;
    const cached = this.getCached(key);
    if (cached) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = provider
      .scan(input, signal)
      .then((result) => {
        this.putCached(key, result);
        return result;
      })
      .catch((error: Error) => {
        log.warn('scan', '扫描失败，保持未知状态', {
          provider: provider.id,
          message: error.message,
        });
        return { verdict: 'unknown', source: provider.name, scannedAt: this.now() } as ScanResult;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, task);
    return task;
  }

  /** 一个目标跑遍所有可用来源，结论按最严格合并，来源与明细都保留。 */
  private async scanOne(input: ScanInput, signal?: AbortSignal): Promise<ScanResult> {
    const providers = this.activeProviders().filter((provider) =>
      provider.supports.includes(input.type),
    );
    if (providers.length === 0) {
      return { verdict: 'unknown', source: 'none', scannedAt: this.now() };
    }

    const results = await Promise.all(
      providers.map((provider) => this.scanOneWith(provider, input, signal)),
    );
    return mergeProviderResults(results, this.now());
  }

  /** 选中邮件后调用：URL 与附件并行扫描；并发度按在场扫描源里最小的那个。 */
  async scanEmail(input: ScanEmailInput): Promise<void> {
    const providers = this.activeProviders();
    if (providers.length === 0) return;

    const startedAt = this.now();
    const controller = new AbortController();
    this.controllers.set(input.emailId, controller);
    const { signal } = controller;

    // Defender 每个文件起一个进程，只要它在场就退化成串行
    const concurrency = Math.min(...providers.map((provider) => provider.concurrency ?? 3));

    const tasks: Array<() => Promise<void>> = [];

    for (const url of input.urls.slice(0, MAX_SCAN_URLS)) {
      tasks.push(async () => {
        if (signal.aborted) return;
        const result = await this.scanOne({ type: 'url', value: url }, signal);
        this.emit({
          emailId: input.emailId,
          key: cacheKeyFor({ type: 'url', value: url }),
          kind: 'url',
          target: url,
          result,
        });
      });
    }

    // 一封邮件只扫前 N 个附件：几十个附件的邮件会把队列拖很久
    for (const attachment of input.attachments.slice(0, MAX_SCAN_ATTACHMENTS)) {
      if (!attachment.sha256) continue;
      tasks.push(async () => {
        if (signal.aborted) return;
        const result = await this.scanOne(
          {
            type: 'attachment',
            sha256: attachment.sha256,
            filename: attachment.filename,
            ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
          },
          signal,
        );
        this.emit({
          emailId: input.emailId,
          key: cacheKeyFor({
            type: 'attachment',
            sha256: attachment.sha256,
            filename: attachment.filename,
          }),
          kind: 'attachment',
          attachmentId: attachment.id,
          target: attachment.filename,
          result,
          riskLevel: mergeScanVerdict(attachment.baseRisk, result.verdict),
        });
      });
    }

    if (tasks.length === 0) return;
    this.onProgress({ emailId: input.emailId, phase: 'start', total: tasks.length });
    try {
      await runWithConcurrency(tasks, concurrency);
    } finally {
      this.onProgress({ emailId: input.emailId, phase: 'end', total: tasks.length });
      if (this.controllers.get(input.emailId) === controller) {
        this.controllers.delete(input.emailId);
      }
    }

    recordMetric('scan_batch', {
      emailId: input.emailId,
      items: tasks.length,
      durationMs: this.now() - startedAt,
    });
  }

  /** 停止某封邮件的扫描：不再启动新任务，正在跑的会在 provider 里被中断。 */
  cancel(emailId: string): boolean {
    const controller = this.controllers.get(emailId);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(emailId);
    return true;
  }

  /** 设置页展示：缓存条目数与 earliest expiry。 */
  cacheStats(): { entries: number; expired: number } {
    const now = this.now();
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM scan_cache').get() as { c: number };
    const expired = this.db
      .prepare('SELECT COUNT(*) AS c FROM scan_cache WHERE expires_at <= ?')
      .get(now) as { c: number };
    return { entries: total.c, expired: expired.c };
  }
}

/** 附件扩展名归一化，保证扫描目标与风险分级使用同一来源。 */
export function scanTargetExt(filename: string): string {
  return extensionOf(filename);
}

/**
 * 自动扫描只覆盖危险/可疑类型（方案 3）。
 *
 * 普通文档（.pdf/.png/…）扫出来几乎必然是 safe，扫了只是白白消耗配额、拖慢队列；
 * 真正需要判断的恰恰是那些"看起来能点开"的文件。
 */
export function isScannableRisk(level: RiskLevel): boolean {
  return level !== 'safe';
}

const VERDICT_RANK: Record<ScanResult['verdict'], number> = {
  malicious: 3,
  suspicious: 2,
  unknown: 1,
  clean: 0,
};

/**
 * 多源结论合并：取最严格者，但把各家明细都留下来。
 * 用户有权知道"是谁说的"——只给一个笼统的"危险"等于替用户隐藏依据。
 */
export function mergeProviderResults(results: ScanResult[], now: number): ScanResult {
  const usable = results.filter((item) => item.source !== 'none');
  if (usable.length === 0) return { verdict: 'unknown', source: 'none', scannedAt: now };

  const worst = usable.reduce((left, right) =>
    VERDICT_RANK[right.verdict] > VERDICT_RANK[left.verdict] ? right : left,
  );

  return {
    verdict: worst.verdict,
    source: [...new Set(usable.map((item) => item.source))].join(' + '),
    ...(typeof worst.score === 'number' ? { score: worst.score } : {}),
    detail: usable.map((item) => `${item.source}：${item.detail ?? item.verdict}`).join('\n'),
    scannedAt: now,
  };
}
