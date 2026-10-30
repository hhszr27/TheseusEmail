import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ATTACHMENT_TTL_MS,
  buildOpenConfirm,
  buildScanBlockedNotice,
  buildScanNotice,
  classifyAttachment,
  extensionOf,
  fitWithinPixelBudget,
  formatScanAge,
  isScanStale,
  mergeExtLists,
  mergeRisk,
  mergeScanVerdict,
  PDF_MAX_CANVAS_PIXELS,
  quarantineXattrArgs,
  resolveHandling,
  riskCopy,
  RISK_COPY,
} from '../src/shared/attachments';
import { prepareTextPreview } from '../src/main/attachments/preview';
import {
  cleanupStaleTempFiles,
  readMarkOfTheWeb,
  sanitizeFileName,
  saveTo,
  stageForExternalOpen,
  writeMarkOfTheWeb,
} from '../src/main/attachments/open';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-attach-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('附件分层策略（§11.1）', () => {
  it('文本/图片/PDF 进入内部预览', () => {
    expect(classifyAttachment({ filename: 'notes.txt' })).toMatchObject({
      handling: 'preview',
      previewKind: 'text',
      risk: 'safe',
    });
    expect(classifyAttachment({ filename: 'PHOTO.PNG' })).toMatchObject({
      handling: 'preview',
      previewKind: 'image',
    });
    expect(classifyAttachment({ filename: 'report.pdf' })).toMatchObject({
      handling: 'preview',
      previewKind: 'pdf',
    });
  });

  it('svg 与办公文档走系统默认程序', () => {
    expect(classifyAttachment({ filename: 'logo.svg' })).toMatchObject({
      handling: 'system',
      risk: 'suspicious',
    });
    expect(classifyAttachment({ filename: '合同.docx' })).toMatchObject({
      handling: 'system',
      risk: 'suspicious',
    });
    expect(classifyAttachment({ filename: '旧合同.doc' })).toMatchObject({ risk: 'suspicious' });
  });

  it('危险类型默认只提示，不直接打开', () => {
    for (const name of ['setup.exe', 'run.BAT', 'macro.docm', 'script.js', 'tool.ps1']) {
      expect(classifyAttachment({ filename: name })).toMatchObject({
        handling: 'confirm',
        risk: 'danger',
      });
    }
  });

  it('默认禁止的那几个：双击直接拒绝', () => {
    for (const name of ['screen.scr', 'auto.pif', 'panel.cpl']) {
      expect(classifyAttachment({ filename: name })).toMatchObject({
        handling: 'blocked',
        risk: 'danger',
      });
    }
    // .scr 本来也在内置危险列表里，但默认提示列表要把它剔除，避免两档重复
    expect(mergeExtLists([], []).warn).not.toContain('.scr');
  });

  it('提示列表是完整列表：可删默认项、可清空、兼容旧的追加字段', () => {
    // 没给完整列表：内置默认生效
    expect(mergeExtLists([], []).warn).toContain('.exe');

    // 给了完整列表：以它为准，默认项被移除
    const custom = mergeExtLists([], [], ['.hta', '.lnk']);
    expect(custom.warn).toEqual(['.hta', '.lnk']);
    expect(custom.warn).not.toContain('.exe');

    // 空数组是有效值：用户清空了全部提示类型
    expect(mergeExtLists([], [], []).warn).toEqual([]);

    // 旧数据兼容：旧的危险列表字段与 customDangerExts 合并
    expect(mergeExtLists([], ['hta'], ['.lnk']).warn).toEqual(['.lnk', '.hta']);
  });

  it('禁止列表是完整列表：清空后回到提示或普通处理', () => {
    expect(mergeExtLists([], [], undefined, []).blocked).toEqual([]);

    // 不再禁止 .scr，但它仍在提示列表里 → 回到「提示」
    expect(classifyAttachment({ filename: 'screen.scr', blockExts: [] })).toMatchObject({
      handling: 'confirm',
    });
    // 两档都删掉，才是普通处理
    expect(
      classifyAttachment({ filename: 'screen.scr', blockExts: [], warnExts: [] }),
    ).not.toMatchObject({ handling: 'confirm' });
  });

  it('同一扩展名同时出现在两档时按禁止处理', () => {
    expect(
      classifyAttachment({ filename: 'x.exe', warnExts: ['.exe'], blockExts: ['.exe'] }),
    ).toMatchObject({ handling: 'blocked' });
  });

  it('移除默认提示项后判定跟着变', () => {
    const withoutExe = mergeExtLists([], [], ['.bat']).warn;

    expect(
      classifyAttachment({ filename: 'setup.exe', warnExts: withoutExe }),
    ).not.toMatchObject({ handling: 'confirm' });
    expect(
      classifyAttachment({ filename: 'run.bat', warnExts: withoutExe }),
    ).toMatchObject({ handling: 'confirm', risk: 'danger' });
  });

  it('用户还能追加纯文本类型与额外提示类型', () => {
    expect(classifyAttachment({ filename: 'doc.rst', customTextExts: ['.rst'] })).toMatchObject({
      handling: 'preview',
      previewKind: 'text',
    });
    expect(
      classifyAttachment({ filename: 'payload.hta', customDangerExts: ['hta'] }),
    ).toMatchObject({ handling: 'confirm', risk: 'danger' });
  });

  it('扫描结论怎么处理由用户配置决定', () => {
    // 默认：危险只提示、疑似只标记（误报不该让用户打不开文件）
    expect(resolveHandling('system', 'malicious')).toMatchObject({
      handling: 'confirm',
      scanAction: 'confirm',
    });
    expect(resolveHandling('system', 'suspicious')).toEqual({
      handling: 'system',
      scanAction: 'label',
    });
    // 没有结论：原样返回；用户配置的禁止仍标 policy
    expect(resolveHandling('system', null)).toEqual({ handling: 'system' });
    expect(resolveHandling('blocked', null)).toMatchObject({
      handling: 'blocked',
      blockedBy: 'policy',
    });

    // 用户把「危险」配成禁止
    expect(
      resolveHandling('system', 'malicious', { malicious: 'block', suspicious: 'label' }),
    ).toMatchObject({ handling: 'blocked', blockedBy: 'scan' });
  });

  it('扩展名规则与扫描结论按严格度合成，谁更严听谁的', () => {
    const strict = { malicious: 'block', suspicious: 'confirm' } as const;
    const relaxed = { malicious: 'label', suspicious: 'label' } as const;

    // 扩展名禁止 + 扫描只标记 → 仍然禁止，来源标成策略
    expect(resolveHandling('blocked', 'malicious', relaxed)).toMatchObject({
      handling: 'blocked',
      blockedBy: 'policy',
    });

    // 扩展名提示 + 扫描禁止 → 禁止，来源标成扫描
    expect(resolveHandling('confirm', 'malicious', strict)).toMatchObject({
      handling: 'blocked',
      blockedBy: 'scan',
    });

    // 扩展名禁止 + 扫描提示 → 禁止优先于提示
    expect(resolveHandling('blocked', 'suspicious', strict)).toMatchObject({
      handling: 'blocked',
      blockedBy: 'policy',
    });

    // 扩展名普通 + 扫描提示 → 提示
    expect(
      resolveHandling('system', 'malicious', { malicious: 'confirm', suspicious: 'label' }),
    ).toMatchObject({ handling: 'confirm' });
  });

  it('扫描禁止提示里写明来源与文件名', () => {
    const notice = buildScanBlockedNotice('invoice.exe', {
      scanSource: 'VirusTotal',
      scanDetail: 'VirusTotal 报告 42 个引擎命中。',
    });
    expect(notice.buttons).toEqual(['知道了']);
    expect(notice.message).toContain('VirusTotal');
    expect(notice.detail).toContain('invoice.exe');
    expect(notice.detail).toContain('另存为');
  });

  it('扩展名解析与无扩展名文件', () => {
    expect(extensionOf('a/b/c.TXT')).toBe('.txt');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf('.bashrc')).toBe('');
    expect(classifyAttachment({ filename: 'README' }).handling).toBe('system');
  });
});

describe('风险合并（§11.3）', () => {
  it('取更严格者', () => {
    expect(mergeRisk('safe', 'unknown')).toBe('unknown');
    expect(mergeRisk('suspicious', 'unknown')).toBe('suspicious');
    expect(mergeRisk('danger', 'safe')).toBe('danger');
  });

  it('危险类型不会被 clean 降级', () => {
    expect(mergeScanVerdict('danger', 'clean')).toBe('danger');
    expect(mergeScanVerdict('danger', 'malicious')).toBe('danger');
    expect(mergeScanVerdict('unknown', 'clean')).toBe('safe');
    expect(mergeScanVerdict('suspicious', 'malicious')).toBe('suspicious');
  });

  it('面向用户文案不含结论性判断词', () => {
    const copy = [
      ...Object.values(RISK_COPY).flatMap((item) => [item.label, item.tooltip]),
      buildOpenConfirm('setup.exe', '.exe').message,
      buildOpenConfirm('setup.exe', '.exe').detail,
      buildScanNotice({
        verdict: 'malicious',
        source: 'VirusTotal',
        score: 3,
        scannedAt: Date.now(),
      }),
    ].join('\n');

    expect(copy).not.toMatch(/有害|危险|恶意/);
    expect(copy).toContain('请确认');
  });

  it('危险类型确认弹窗默认取消', () => {
    const confirm = buildOpenConfirm('invoice.exe', '.exe');
    expect(confirm.buttons).toEqual(['取消', '仍要打开']);
    expect(confirm.defaultId).toBe(0);
    expect(confirm.cancelId).toBe(0);
    expect(confirm.title).toBe('打开此文件前请确认');
    expect(confirm.detail).toContain('invoice.exe');
  });

  it('riskCopy 对 safe 返回空文案', () => {
    expect(riskCopy('safe').label).toBe('');
  });
});

describe('文本预览净化（§11.2）', () => {
  it('移除 script/style 块，保留可读文本', () => {
    const result = prepareTextPreview(
      Buffer.from('<script>alert(1)</script>\n第一行\n<style>body{color:red}</style>\n<b>粗体</b>', 'utf8'),
    );
    expect(result.text).not.toContain('alert(1)');
    expect(result.text).not.toContain('color:red');
    expect(result.text).toContain('第一行');
    expect(result.text).toContain('粗体');
    expect(result.text).not.toContain('<b>');
  });

  it('超长文本被截断标记', () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 0x41);
    const result = prepareTextPreview(big);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('PDF 画布不超过 800 万像素', () => {
    const fit = fitWithinPixelBudget(6000, 8000);
    expect(fit.width * fit.height).toBeLessThanOrEqual(PDF_MAX_CANVAS_PIXELS);
    expect(fit.width / fit.height).toBeCloseTo(6000 / 8000, 2);
    expect(fitWithinPixelBudget(800, 600)).toMatchObject({ scale: 1, width: 800, height: 600 });
  });
});

describe('文件系统标记（§11.6）', () => {
  it('文件名净化阻止路径穿越', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('a\\b\\c.txt')).toBe('c.txt');
    expect(sanitizeFileName('bad<>:"|?*.txt')).toBe('bad_______.txt');
    expect(sanitizeFileName('   ')).toBe('attachment');
  });

  it('macOS quarantine 参数格式正确', () => {
    const args = quarantineXattrArgs('/tmp/a.docx', '6789ab');
    expect(args).toEqual(['-w', 'com.apple.quarantine', '0081;6789ab;Safari;', '/tmp/a.docx']);
  });

  it.runIf(process.platform === 'win32')('Windows 写入 Zone.Identifier', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'doc.docx');
    fs.writeFileSync(file, 'content');

    expect(await writeMarkOfTheWeb(file)).toBe(true);
    const stream = await readMarkOfTheWeb(file);
    expect(stream).toContain('[ZoneTransfer]');
    expect(stream).toContain('ZoneId=3');
    expect(fs.readFileSync(file, 'utf8')).toBe('content');
  });

  it.runIf(process.platform === 'win32')('系统打开前落到临时目录并写入 MotW', async () => {
    const dir = tempDir();
    const source = path.join(dir, 'source.txt');
    fs.writeFileSync(source, 'hello');

    const staged = await stageForExternalOpen(source, '../../evil.txt');
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;

    expect(path.basename(staged.path)).toBe('evil.txt');
    expect(fs.readFileSync(staged.path, 'utf8')).toBe('hello');
    expect(await readMarkOfTheWeb(staged.path)).toContain('ZoneId=3');
    fs.rmSync(staged.path, { force: true });
  });

  it.runIf(process.platform === 'win32')('另存为同样写入 MotW', async () => {
    const dir = tempDir();
    const source = path.join(dir, 'source.bin');
    const destination = path.join(dir, 'saved.bin');
    fs.writeFileSync(source, 'data');

    expect(await saveTo(source, destination)).toEqual({ ok: true });
    expect(fs.readFileSync(destination, 'utf8')).toBe('data');
    expect(await readMarkOfTheWeb(destination)).toContain('ZoneId=3');
  });

  it('清理超过 TTL 的临时附件', async () => {
    const old = new Date(Date.now() - ATTACHMENT_TTL_MS - 60_000);
    const staged = path.join(os.tmpdir(), 'MailForge', 'attachments');
    fs.mkdirSync(staged, { recursive: true });
    const stale = path.join(staged, `stale-${Date.now()}.tmp`);
    fs.writeFileSync(stale, 'x');
    fs.utimesSync(stale, old, old);

    const removed = await cleanupStaleTempFiles(ATTACHMENT_TTL_MS);
    expect(removed).toBeGreaterThan(0);
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('扫描结论时效', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;

  it('普通结论 24 小时过期，恶意结论 7 天', () => {
    expect(isScanStale('safe', now - DAY - 1, now)).toBe(true);
    expect(isScanStale('safe', now - DAY + 1, now)).toBe(false);
    expect(isScanStale('danger', now - 6 * DAY, now)).toBe(false);
    expect(isScanStale('danger', now - 8 * DAY, now)).toBe(true);
  });

  it('没有扫描时间视为过期，不能拿来当依据', () => {
    expect(isScanStale('safe', 0, now)).toBe(true);
  });

  it('相对时间文案', () => {
    expect(formatScanAge(now - 30_000, now)).toBe('刚刚');
    expect(formatScanAge(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatScanAge(now - 3 * 3600_000, now)).toBe('3 小时前');
    expect(formatScanAge(now - 2 * DAY, now)).toBe('2 天前');
  });
});
