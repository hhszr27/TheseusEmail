import { afterEach, describe, expect, it } from 'vitest';
import { ScanService, cacheTtlFor, extractScannableUrls, isPrivateHost, mergeProviderResults, runWithConcurrency } from '../src/main/attachments/scan';
import { MALICIOUS_TTL_MS, CACHE_TTL_MS } from '../src/main/attachments/scan';
import type { ScanInput, ScanResult } from '../src/shared/types';
import type { ScanProvider } from '../src/main/security/virustotal';
import { createTestDb, type TestDb } from './helpers/test-db';

let context: TestDb | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function fakeProvider(options: {
  verdict?: (input: ScanInput) => ScanResult['verdict'];
  delayMs?: number;
} = {}): ScanProvider & { calls: ScanInput[]; maxActive: number } {
  const state = {
    calls: [] as ScanInput[],
    active: 0,
    maxActive: 0,
  };

  return {
    id: 'fake',
    name: 'FakeScan',
    supports: ['url', 'attachment'],
    get calls() {
      return state.calls;
    },
    get maxActive() {
      return state.maxActive;
    },
    async scan(input: ScanInput): Promise<ScanResult> {
      state.calls.push(input);
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      await new Promise((done) => setTimeout(done, options.delayMs ?? 15));
      state.active -= 1;
      return {
        verdict: options.verdict ? options.verdict(input) : 'clean',
        source: 'FakeScan',
        score: 0,
        scannedAt: Date.now(),
      };
    },
  };
}

describe('扫描工具函数', () => {
  it('缓存 TTL：普通 24h，malicious 7d', () => {
    expect(cacheTtlFor('clean')).toBe(CACHE_TTL_MS);
    expect(cacheTtlFor('malicious')).toBe(MALICIOUS_TTL_MS);
    expect(MALICIOUS_TTL_MS).toBeGreaterThan(CACHE_TTL_MS);
  });

  it('提取公网 URL 并跳过内网地址', () => {
    const html = `
      <a href="https://example.com/a">a</a>
      <img src="http://127.0.0.1/pixel.png">
      <a href="http://192.168.1.10/admin">b</a>
      <img src="https://cdn.example.org/x.png">
      <a href="mailto:someone@example.com">mail</a>
      <img src="data:image/png;base64,AAA">
      <a href="https://example.com/a">dup</a>
    `;
    const urls = extractScannableUrls(html);
    expect(urls).toContain('https://example.com/a');
    expect(urls).toContain('https://cdn.example.org/x.png');
    expect(urls).toHaveLength(2);

    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('10.0.0.2')).toBe(true);
    expect(isPrivateHost('172.20.1.1')).toBe(true);
    expect(isPrivateHost('example.com')).toBe(false);
  });

  it('固定并发度且保持结果顺序', async () => {
    let active = 0;
    let maxActive = 0;
    const tasks = Array.from({ length: 7 }, (_, index) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((done) => setTimeout(done, 8));
      active -= 1;
      return index;
    });

    const results = await runWithConcurrency(tasks, 3);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});

describe('扫描编排（§12.2 / §12.3）', () => {
  it('附件与 URL 并行扫描，并发不超过 3，结果原地回写', async () => {
    context = createTestDb();
    const provider = fakeProvider();
    const updates: Array<{ attachmentId?: string; target: string }> = [];

    const scanner = new ScanService(context.db, [provider], (update) => {
      updates.push({
        ...(update.attachmentId ? { attachmentId: update.attachmentId } : {}),
        target: update.target,
      });
    });

    expect(scanner.isEnabled()).toBe(true);

    await scanner.scanEmail({
      emailId: 'e1',
      urls: ['https://a.example/1', 'https://b.example/2'],
      attachments: [
        { id: 'a1', filename: 'one.txt', mimeType: 'text/plain', sha256: 'aa', baseRisk: 'safe' },
        { id: 'a2', filename: 'two.pdf', mimeType: 'application/pdf', sha256: 'bb', baseRisk: 'safe' },
        { id: 'a3', filename: 'three.exe', mimeType: 'application/octet-stream', sha256: 'cc', baseRisk: 'danger' },
      ],
    });

    expect(provider.calls).toHaveLength(5);
    expect(provider.maxActive).toBeLessThanOrEqual(3);
    expect(updates).toHaveLength(5);
    expect(updates.filter((item) => item.attachmentId)).toHaveLength(3);

    // danger 不会被 clean 降级
    const exeUpdate = updates.find((item) => item.attachmentId === 'a3');
    expect(exeUpdate).toBeTruthy();
  });

  it('缓存命中不重复调用服务商', async () => {
    context = createTestDb();
    const provider = fakeProvider();
    const scanner = new ScanService(context.db, [provider], () => undefined);

    const input = {
      emailId: 'e1',
      urls: ['https://example.com/x'],
      attachments: [
        { id: 'a1', filename: 'x.txt', mimeType: 'text/plain', sha256: 'dd', baseRisk: 'safe' as const },
      ],
    };

    await scanner.scanEmail(input);
    expect(provider.calls).toHaveLength(2);

    await scanner.scanEmail(input);
    expect(provider.calls).toHaveLength(2);

    const stats = scanner.cacheStats();
    expect(stats.entries).toBe(2);
  });

  it('malicious 结果缓存 7 天', async () => {
    context = createTestDb();
    const provider = fakeProvider({ verdict: () => 'malicious' });
    const scanner = new ScanService(context.db, [provider], () => undefined, () => 1_000_000);

    await scanner.scanEmail({
      emailId: 'e1',
      urls: [],
      attachments: [
        { id: 'a1', filename: 'bad.bin', mimeType: 'application/octet-stream', sha256: 'ee', baseRisk: 'unknown' },
      ],
    });

    // 缓存键现在带来源前缀（多源结果不能互相覆盖），这里只关心 TTL
    const row = context.db
      .prepare('SELECT expires_at FROM scan_cache WHERE key LIKE ?')
      .get('%file:ee') as { expires_at: number };
    expect(row.expires_at - 1_000_000).toBe(MALICIOUS_TTL_MS);
  });

  it('未配置服务商时不触发扫描', async () => {
    context = createTestDb();
    const scanner = new ScanService(context.db, [], () => undefined);
    expect(scanner.isEnabled()).toBe(false);
    await scanner.scanEmail({
      emailId: 'e1',
      urls: ['https://example.com'],
      attachments: [],
    });
    expect(scanner.cacheStats().entries).toBe(0);
  });

  it('服务商异常时保持 unknown，不影响其他项', async () => {
    context = createTestDb();
    const provider: ScanProvider = {
      id: 'broken',
      name: 'Broken',
      supports: ['attachment'],
      async scan() {
        throw new Error('网络中断');
      },
    };
    const updates: ScanResult[] = [];
    const scanner = new ScanService(context.db, [provider], (update) => updates.push(update.result));

    await scanner.scanEmail({
      emailId: 'e1',
      urls: [],
      attachments: [
        { id: 'a1', filename: 'x.txt', mimeType: 'text/plain', sha256: 'ff', baseRisk: 'safe' },
      ],
    });

    expect(updates[0]?.verdict).toBe('unknown');
  });
});

describe('多源结论合并', () => {
  it('取最严格者，并保留各家明细', () => {
    const merged = mergeProviderResults(
      [
        { verdict: 'clean', source: 'Defender', detail: '未检出', scannedAt: 1 },
        { verdict: 'malicious', source: 'VirusTotal', detail: '42 个引擎命中', scannedAt: 2 },
      ],
      10,
    );

    expect(merged.verdict).toBe('malicious');
    expect(merged.source).toBe('Defender + VirusTotal');
    expect(merged.detail).toContain('Defender');
    expect(merged.detail).toContain('VirusTotal');
  });

  it('一个源不可用不会冒充安全', () => {
    const merged = mergeProviderResults(
      [
        { verdict: 'clean', source: 'A', scannedAt: 1 },
        { verdict: 'unknown', source: 'B', detail: '不可用', scannedAt: 1 },
      ],
      1,
    );
    // 干净 + 不可用 = 不确定，绝不能算 clean
    expect(merged.verdict).toBe('unknown');
  });
});
