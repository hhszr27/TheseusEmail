import {
  BLOCKED_EXTS,
  DANGEROUS_EXTS,
  PREVIEW_IMAGE_EXTS,
  PREVIEW_TEXT_EXTS,
  RISK_ORDER,
  SUSPICIOUS_EXTS,
} from './constants';
import type { AttachmentRisk, RiskLevel, ScanResult } from './types';

/**
 * 附件分层策略（§11.1）与中性文案（§11.3）。
 * 本模块必须保持纯函数：主进程用于决策，测试直接覆盖。
 */

export type AttachmentHandling = 'preview' | 'system' | 'confirm' | 'blocked';

/** 扫描结论的处理方式：禁止 / 打开前确认 / 仅标记（只影响角标，不打断操作）。 */
export type ScanAction = 'block' | 'confirm' | 'label';

export interface ScanPolicySettings {
  /** 扫描源开关：Defender 本地免费，VirusTotal 要 Key 且只查哈希。 */
  providers: { defender: boolean; virustotal: boolean };
  /** 结论对应的处理方式，由用户决定，软件不替用户做安全判断。 */
  actions: { malicious: ScanAction; suspicious: ScanAction };
}

export const DEFAULT_SCAN_POLICY: ScanPolicySettings = {
  // Defender 默认开：本地、无需配置，不开的话这个功能对多数人等于不存在
  providers: { defender: true, virustotal: false },
  // 默认只提示 / 只标记：误报不该让用户连文件都打不开
  actions: { malicious: 'confirm', suspicious: 'label' },
};

/** 读设置时归一化，脏值一律回落到默认（避免一个坏字段把扫描关掉）。 */
export function normalizeScanPolicy(value: unknown): ScanPolicySettings {
  const parsed = (value ?? {}) as Partial<ScanPolicySettings>;
  const providers = (parsed.providers ?? {}) as Partial<ScanPolicySettings['providers']>;
  const actions = (parsed.actions ?? {}) as Partial<ScanPolicySettings['actions']>;
  const action = (raw: unknown, fallback: ScanAction): ScanAction =>
    raw === 'block' || raw === 'confirm' || raw === 'label' ? raw : fallback;

  return {
    providers: {
      defender:
        typeof providers.defender === 'boolean'
          ? providers.defender
          : DEFAULT_SCAN_POLICY.providers.defender,
      virustotal:
        typeof providers.virustotal === 'boolean'
          ? providers.virustotal
          : DEFAULT_SCAN_POLICY.providers.virustotal,
    },
    actions: {
      malicious: action(actions.malicious, DEFAULT_SCAN_POLICY.actions.malicious),
      suspicious: action(actions.suspicious, DEFAULT_SCAN_POLICY.actions.suspicious),
    },
  };
}
export type PreviewKind = 'text' | 'image' | 'pdf' | 'none';

export interface AttachmentPolicyInput {
  filename: string;
  mimeType?: string;
  /** 用户追加的纯文本扩展名（只能加，不能删默认项）。 */
  customTextExts?: readonly string[];
  /** 兼容旧数据：并入 warnExts。 */
  customDangerExts?: readonly string[];
  /** 「打开前提示」的完整列表；提供时以它为准（用户可删除默认项）。 */
  warnExts?: readonly string[];
  /** 「禁止打开」的完整列表；提供时以它为准。 */
  blockExts?: readonly string[];
  /** 旧字段：等价于 warnExts（历史数据）。 */
  dangerousExts?: readonly string[];
}

export interface AttachmentPolicy {
  ext: string;
  handling: AttachmentHandling;
  previewKind: PreviewKind;
  risk: RiskLevel;
}

export function extensionOf(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot).toLowerCase();
}

function normalizeExt(ext: string): string {
  const trimmed = ext.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

/** 归一化 + 去重；非法值直接丢弃（保持传入顺序）。 */
function normalizeExtList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeExt(value);
    if (/^\.[a-z0-9]{1,12}$/.test(normalized)) seen.add(normalized);
  }
  return [...seen];
}

/**
 * 三类扩展名列表：
 * - `warn`：双击弹确认（默认 = 内置危险类型，去掉已被「禁止」的那几个）
 * - `blocked`：双击直接拒绝（默认 = BLOCKED_EXTS）
 *
 * 传入的完整列表优先；**空数组是有效值**（用户真的清空了），不能当成"没设置"。
 */
export function mergeExtLists(
  customTextExts: readonly string[] = [],
  customDangerExts: readonly string[] = [],
  warnExts?: readonly string[],
  blockExts?: readonly string[],
): { text: string[]; warn: string[]; blocked: string[] } {
  const text = new Set<string>([...PREVIEW_TEXT_EXTS]);
  for (const ext of normalizeExtList(customTextExts)) text.add(ext);

  const blocked = new Set<string>(
    blockExts !== undefined ? normalizeExtList(blockExts) : [...BLOCKED_EXTS],
  );
  const warn = new Set<string>(
    warnExts !== undefined
      ? normalizeExtList(warnExts)
      : DANGEROUS_EXTS.filter((ext) => !blocked.has(ext)),
  );
  // 兼容旧的「追加」字段
  for (const ext of normalizeExtList(customDangerExts)) warn.add(ext);

  return { text: [...text], warn: [...warn], blocked: [...blocked] };
}

export function classifyAttachment(input: AttachmentPolicyInput): AttachmentPolicy {
  const ext = extensionOf(input.filename);
  const lists = mergeExtLists(
    input.customTextExts,
    input.customDangerExts,
    input.warnExts ?? input.dangerousExts,
    input.blockExts,
  );

  // 禁止优先于提示：同一扩展名同时出现在两档时，按更严格的来
  if (lists.blocked.includes(ext)) {
    return { ext, handling: 'blocked', previewKind: 'none', risk: 'danger' };
  }

  if (lists.warn.includes(ext)) {
    return { ext, handling: 'confirm', previewKind: 'none', risk: 'danger' };
  }

  if (ext === '.pdf') {
    return { ext, handling: 'preview', previewKind: 'pdf', risk: 'safe' };
  }

  if ((PREVIEW_IMAGE_EXTS as readonly string[]).includes(ext)) {
    return { ext, handling: 'preview', previewKind: 'image', risk: 'safe' };
  }

  if (lists.text.includes(ext)) {
    return { ext, handling: 'preview', previewKind: 'text', risk: 'safe' };
  }

  if ((SUSPICIOUS_EXTS as readonly string[]).includes(ext)) {
    // .svg 不进入内部预览，走系统默认程序
    return { ext, handling: 'system', previewKind: 'none', risk: 'suspicious' };
  }

  // 其余类型交由系统默认程序打开，未扫描前视为 unknown
  return { ext, handling: 'system', previewKind: 'none', risk: 'unknown' };
}

export function mergeRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a;
}

/**
 * 扫描结论与类型风险的合并（§11.3 等级合并）：
 * 取更严格者；类型黑名单的 danger 永不被 clean 降级。
 */
export function mergeScanVerdict(base: RiskLevel, verdict: ScanResult['verdict']): RiskLevel {
  if (base === 'danger') return 'danger';
  switch (verdict) {
    case 'malicious':
      return 'suspicious';
    case 'suspicious':
      return 'suspicious';
    case 'clean':
      // danger 已在函数开头短路；clean 只覆盖“未扫描”的 unknown
      return base === 'suspicious' ? base : 'safe';
    default:
      return mergeRisk(base, 'unknown');
  }
}

/**
 * 面向用户的文案（§11.3 硬约束）：
 * 这里不得出现对文件性质的结论性判断，只描述事实与下一步。
 */
export const RISK_COPY: Record<RiskLevel, { label: string; tooltip: string }> = {
  danger: {
    label: '可执行文件，打开前请确认来源',
    tooltip: '此文件为可执行程序或包含自动运行内容。请确认发件人可信后再决定是否打开。',
  },
  suspicious: {
    label: '此类文件可能含自动运行内容',
    tooltip: '该类型文件可能包含宏或脚本。打开时请留意程序的安全提示。',
  },
  unknown: {
    label: '未经安全扫描，请自行判断',
    tooltip: '此附件尚未完成安全扫描，或扫描结果未知。打开前请确认来源可信。',
  },
  safe: { label: '', tooltip: '' },
};

export function riskCopy(level: RiskLevel): { label: string; tooltip: string } {
  return RISK_COPY[level];
}

export function buildAttachmentRisk(level: RiskLevel, scan?: ScanResult | null): AttachmentRisk {
  const copy = RISK_COPY[level];
  if (!scan || scan.verdict === 'unknown') {
    return { level, reason: copy.label, tooltip: copy.tooltip };
  }
  const source = scan.source || '扫描服务';
  const detail =
    typeof scan.score === 'number'
      ? `${source} 报告 ${scan.score} 个引擎命中。`
      : `${source} 返回结果：${scan.verdict}。`;
  return {
    level,
    reason: copy.label || detail,
    tooltip: copy.tooltip || detail,
    scanSource: scan.source,
    scanDetail: detail,
  };
}

/**
 * 危险类型双击后的中性确认（§11.4）：取消为默认按钮。
 * 这里返回的是 dialog.showMessageBox 的参数，便于测试默认按钮。
 */
export function buildOpenConfirm(
  filename: string,
  ext: string,
  scan?: { scanSource?: string; scanDetail?: string },
): {
  type: 'warning';
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: true;
  title: string;
  message: string;
  detail: string;
} {
  const shownExt = ext || extensionOf(filename) || '未知类型';
  return {
    type: 'warning',
    buttons: ['取消', '仍要打开'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: '打开此文件前请确认',
    message: `这是一个 ${shownExt} 文件。`,
    detail:
      `${scan?.scanDetail ? `${scan.scanDetail}\n` : ''}` +
      `请确认它来自你信任的发件人，并且你预期收到此类文件。\n文件名：${filename}`,
  };
}

/** 扫描结论的缓存期：普通结论 24 小时，恶意结论 7 天。 */
export const SCAN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SCAN_MALICIOUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 结论是否已经过期（过期后只能"仅供参考"，不能当作当前判断）。 */
export function isScanStale(level: RiskLevel, scannedAt: number, now: number): boolean {
  if (!scannedAt) return true;
  const ttl = level === 'danger' ? SCAN_MALICIOUS_TTL_MS : SCAN_CACHE_TTL_MS;
  return now - scannedAt > ttl;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function formatScanAge(scannedAt: number, now: number): string {
  const diff = Math.max(0, now - scannedAt);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 最终打开方式：**扩展名规则与扫描结论按「严格度」合成**，谁更严格听谁的。
 *
 * 严格度：禁止 > 提示 > 普通。这样用户不需要理解"哪条规则优先"，
 * 只要任何一处设了禁止，它就打不开；都没禁止时，任何一处要求提示，就提示。
 *
 * 扫描结论该怎么处理由 `actions` 决定（用户可配）：禁止 / 提示 / 仅标记。
 */
export function resolveHandling(
  handling: AttachmentHandling,
  scanVerdict: string | null | undefined,
  actions: ScanPolicySettings['actions'] = DEFAULT_SCAN_POLICY.actions,
): { handling: AttachmentHandling; blockedBy?: 'policy' | 'scan'; scanAction?: ScanAction } {
  const scanAction: ScanAction | null =
    scanVerdict === 'malicious'
      ? actions.malicious
      : scanVerdict === 'suspicious'
        ? actions.suspicious
        : null;

  // 「仅标记」或没有结论：不改变打开方式，只让调用方决定要不要显示角标
  if (!scanAction || scanAction === 'label') {
    return {
      handling,
      ...(handling === 'blocked' ? { blockedBy: 'policy' as const } : {}),
      ...(scanAction ? { scanAction } : {}),
    };
  }

  const severity = (value: AttachmentHandling): number =>
    value === 'blocked' ? 3 : value === 'confirm' ? 2 : 1;

  const fromScan: AttachmentHandling = scanAction === 'block' ? 'blocked' : 'confirm';
  if (severity(fromScan) > severity(handling)) {
    return {
      handling: fromScan,
      ...(fromScan === 'blocked' ? { blockedBy: 'scan' as const } : {}),
      scanAction,
    };
  }

  // 扩展名规则已经更严格（或同样严格）：保留 policy 的来源标记
  return {
    handling,
    ...(handling === 'blocked' ? { blockedBy: 'policy' as const } : {}),
    scanAction,
  };
}

/** 扫描判恶意时的提示：说明依据，并指出「另存为」是唯一出路。 */
export function buildScanBlockedNotice(
  filename: string,
  scan: { scanSource?: string; scanDetail?: string },
): {
  type: 'warning';
  buttons: string[];
  defaultId: number;
  noLink: true;
  title: string;
  message: string;
  detail: string;
} {
  const source = scan.scanSource || '扫描服务';
  return {
    type: 'warning',
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
    title: '扫描服务把这个文件判为恶意',
    message: `${source} 报告了恶意结果，已禁止打开。`,
    detail: `${scan.scanDetail ?? ''}\n如果确认是误报，可以用「另存为」保存后自行判断。\n文件名：${filename}`,
  };
}

/** 「禁止打开」的提示：只有一个「知道了」，不提供任何打开入口。 */
export function buildBlockedNotice(
  filename: string,
  ext: string,
): {
  type: 'warning';
  buttons: string[];
  defaultId: number;
  noLink: true;
  title: string;
  message: string;
  detail: string;
} {
  const shownExt = ext || extensionOf(filename) || '未知类型';
  return {
    type: 'warning',
    buttons: ['知道了'],
    defaultId: 0,
    noLink: true,
    title: '这类文件已被禁止打开',
    message: `这是一个 ${shownExt} 文件，已在设置里被列为「禁止打开」。`,
    detail: `确实需要的话，可以到「设置 → 程序 → 附件扩展名」把它从禁止列表里移除。\n文件名：${filename}`,
  };
}

/** 扫描命中时的中性披露（引用服务名与命中数，不替用户下结论）。 */export function buildScanNotice(scan: ScanResult): string {
  const score = typeof scan.score === 'number' ? `${scan.score} 个引擎命中` : '返回了结果';
  return `${scan.source} ${score}。请结合发件人与上下文自行判断。`;
}

const MOTW_CONTENT = '[ZoneTransfer]\r\nZoneId=3\r\n';

export function markOfTheWebContent(): string {
  return MOTW_CONTENT;
}

/** macOS 隔离属性参数（§11.6），缺失即安全缺陷。 */
export function quarantineXattrArgs(filePath: string, hexTimestamp: string): string[] {
  return [
    '-w',
    'com.apple.quarantine',
    `0081;${hexTimestamp};Safari;`,
    filePath,
  ];
}

/** 临时附件文件的保留上限（§11.6）。 */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** PDF 渲染的像素上限（§11.2）：每页画布不超过 800 万像素。 */
export const PDF_MAX_CANVAS_PIXELS = 8_000_000;

/** 等比缩放到像素预算内；纯计算，主进程与渲染进程共用。 */
export function fitWithinPixelBudget(
  width: number,
  height: number,
  maxPixels = PDF_MAX_CANVAS_PIXELS,
): { scale: number; width: number; height: number } {
  if (width <= 0 || height <= 0) return { scale: 1, width: 0, height: 0 };
  const pixels = width * height;
  if (pixels <= maxPixels) {
    return { scale: 1, width: Math.round(width), height: Math.round(height) };
  }
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    scale,
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}
