import type { ScanInput, ScanResult } from '../../shared/types';

/**
 * VirusTotal 适配器（§12.4）。
 * - URL：先查询，404 后提交并轮询分析
 * - 附件：只按 SHA-256 查询，绝不上传内容
 * - API Key 只存在于主进程内存，不写日志
 * - 免费额度限速：请求间隔 >= 15 秒
 */

export interface ScanProvider {
  id: string;
  name: string;
  supports: Array<'url' | 'attachment'>;
  /** 同时可跑几个任务；缺省 3。Defender 每个文件起进程，必须串行。 */
  concurrency?: number;
  /** 不可用时给出原因，供设置页展示（避免"静默不扫"让用户误以为扫过了）。 */
  isAvailable?(): { available: boolean; reason?: string };
  scan(input: ScanInput, signal?: AbortSignal): Promise<ScanResult>;
}

export interface VirusTotalOptions {
  apiKey: string;
  baseUrl?: string;
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
}

interface VtStats {
  malicious?: number;
  suspicious?: number;
  undetected?: number;
  harmless?: number;
}

interface VtResponse {
  data?: {
    id?: string;
    attributes?: {
      status?: string;
      last_analysis_stats?: VtStats;
      stats?: VtStats;
    };
  };
}

export function mapStatsToVerdict(stats: VtStats | undefined): {
  verdict: ScanResult['verdict'];
  score?: number;
  detail?: string;
} {
  if (!stats) return { verdict: 'unknown' };
  const malicious = Number(stats.malicious ?? 0);
  const suspicious = Number(stats.suspicious ?? 0);
  const harmless = Number(stats.harmless ?? 0);
  const undetected = Number(stats.undetected ?? 0);

  if (malicious > 0) {
    return {
      verdict: 'malicious',
      score: malicious,
      detail: `${malicious} 个引擎命中，${suspicious} 个可疑，${undetected + harmless} 个未命中`,
    };
  }
  if (suspicious > 0) {
    return {
      verdict: 'suspicious',
      score: suspicious,
      detail: `${suspicious} 个引擎标记为可疑`,
    };
  }
  if (harmless + undetected > 0) {
    return { verdict: 'clean', score: 0, detail: `${harmless + undetected} 个引擎未命中` };
  }
  return { verdict: 'unknown' };
}

export class VirusTotalProvider implements ScanProvider {
  readonly id = 'virustotal';
  readonly name = 'VirusTotal';
  readonly supports: Array<'url' | 'attachment'> = ['url', 'attachment'];

  private readonly baseUrl: string;
  private readonly minIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly options: VirusTotalOptions) {
    this.baseUrl = options.baseUrl ?? 'https://www.virustotal.com/api/v3';
    this.minIntervalMs = options.minIntervalMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? this.minIntervalMs;
    this.maxPolls = options.maxPolls ?? 5;
  }

  /** 串行化 + 最小间隔，保证免费额度不被突发请求打穿。 */
  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      return task();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async request(pathname: string, init?: RequestInit): Promise<Response> {
    return this.schedule(() =>
      this.fetchImpl(`${this.baseUrl}${pathname}`, {
        ...init,
        headers: {
          'x-apikey': this.options.apiKey,
          accept: 'application/json',
          ...(init?.headers ?? {}),
        },
      }),
    );
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    if (input.type === 'attachment') {
      return this.scanFile(input.sha256);
    }
    return this.scanUrl(input.value);
  }

  private async scanFile(sha256: string): Promise<ScanResult> {
    const response = await this.request(`/files/${encodeURIComponent(sha256)}`);
    if (response.status === 404) {
      return {
        verdict: 'unknown',
        source: this.name,
        detail: '该文件哈希尚未收录',
        scannedAt: this.now(),
      };
    }
    if (!response.ok) {
      throw new Error(`VirusTotal 文件查询失败（HTTP ${response.status}）`);
    }
    const payload = (await response.json()) as VtResponse;
    const mapped = mapStatsToVerdict(payload.data?.attributes?.last_analysis_stats);
    return {
      verdict: mapped.verdict,
      source: this.name,
      ...(mapped.score !== undefined ? { score: mapped.score } : {}),
      ...(mapped.detail ? { detail: mapped.detail } : {}),
      scannedAt: this.now(),
    };
  }

  private async scanUrl(url: string): Promise<ScanResult> {
    const id = Buffer.from(url, 'utf8').toString('base64url');
    const lookup = await this.request(`/urls/${id}`);
    if (lookup.ok) {
      const payload = (await lookup.json()) as VtResponse;
      const mapped = mapStatsToVerdict(payload.data?.attributes?.last_analysis_stats);
      return {
        verdict: mapped.verdict,
        source: this.name,
        ...(mapped.score !== undefined ? { score: mapped.score } : {}),
        ...(mapped.detail ? { detail: mapped.detail } : {}),
        scannedAt: this.now(),
      };
    }
    if (lookup.status !== 404) {
      throw new Error(`VirusTotal URL 查询失败（HTTP ${lookup.status}）`);
    }

    const submitted = await this.request('/urls', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url }).toString(),
    });
    if (!submitted.ok) {
      throw new Error(`VirusTotal URL 提交失败（HTTP ${submitted.status}）`);
    }
    const submitPayload = (await submitted.json()) as VtResponse;
    const analysisId = submitPayload.data?.id;
    if (!analysisId) {
      return { verdict: 'unknown', source: this.name, scannedAt: this.now() };
    }

    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      if (attempt > 0) await this.sleep(this.pollIntervalMs);
      const analysis = await this.request(`/analyses/${encodeURIComponent(analysisId)}`);
      if (!analysis.ok) continue;
      const payload = (await analysis.json()) as VtResponse;
      if (payload.data?.attributes?.status !== 'completed') continue;

      const mapped = mapStatsToVerdict(payload.data.attributes.stats);
      return {
        verdict: mapped.verdict,
        source: this.name,
        ...(mapped.score !== undefined ? { score: mapped.score } : {}),
        ...(mapped.detail ? { detail: mapped.detail } : {}),
        scannedAt: this.now(),
      };
    }

    return {
      verdict: 'unknown',
      source: this.name,
      detail: '分析尚未完成',
      scannedAt: this.now(),
    };
  }
}
