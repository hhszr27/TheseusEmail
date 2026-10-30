import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * DoH 设置（§31.5）。
 * Chromium 的 DoH 配置只能在 ready 之前通过命令行开关生效，因此切换后需要重启。
 */

export const DOH_TEMPLATE = 'https://cloudflare-dns.com/dns-query';

interface DohFile {
  enabled: boolean;
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'doh.json');
}

export function readDohSetting(): boolean {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DohFile>;
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

export function writeDohSetting(enabled: boolean): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ enabled }, null, 2), 'utf8');
}

/** 需要追加到 Chromium 的命令行开关；纯函数便于测试。 */
export function dohSwitches(enabled: boolean, template = DOH_TEMPLATE): Array<[string, string]> {
  if (!enabled) return [];
  return [
    ['enable-features', 'DnsOverHttps'],
    ['dns-over-https-templates', template],
    ['dns-over-https-mode', 'automatic'],
  ];
}

export function applyDohSetting(enabled: boolean, template = DOH_TEMPLATE): void {
  for (const [name, value] of dohSwitches(enabled, template)) {
    app.commandLine.appendSwitch(name, value);
  }
}

/** 当前进程是否已在启动时应用（用于诊断页如实显示）。 */
export function dohApplied(): boolean {
  return app.commandLine.hasSwitch('dns-over-https-templates');
}

export function dohStatus(): {
  enabled: boolean;
  template: string;
  applied: boolean;
  requiresRestart: boolean;
} {
  const enabled = readDohSetting();
  return {
    enabled,
    template: DOH_TEMPLATE,
    applied: dohApplied(),
    requiresRestart: enabled !== dohApplied(),
  };
}
