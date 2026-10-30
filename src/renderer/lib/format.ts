import type { EmailAddress } from '../../shared/types';
import { formatClock, type TimeFormat } from '../../shared/calendar-settings';
import { systemTimeZone, zonedParts } from '../../shared/timezone';

export function formatAddressList(addresses: EmailAddress[]): string {
  if (!addresses.length) return '（未知发件人）';
  return addresses
    .map((item) => (item.name ? `${item.name} <${item.address}>` : item.address))
    .join(', ');
}

export function formatShortAddress(addresses: EmailAddress[]): string {
  const first = addresses[0];
  if (!first) return '（未知发件人）';
  return first.name || first.address;
}

function pad2(value: number): string {
  return `${value}`.padStart(2, '0');
}

export function formatListDate(
  iso: string,
  timeFormat: TimeFormat = '24',
  timeZone: string = systemTimeZone(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = zonedParts(date.getTime(), timeZone);
  const now = zonedParts(Date.now(), timeZone);
  const sameDay = parts.year === now.year && parts.month === now.month && parts.day === now.day;

  // 当天只显示时刻，交给统一的 12/24 小时格式化
  if (sameDay) return formatClock(parts.hour * 60 + parts.minute, timeFormat);
  if (parts.year === now.year) return `${parts.month}月${parts.day}日`;
  return `${parts.year}/${parts.month}/${parts.day}`;
}

export function formatFullDate(
  iso: string,
  timeFormat: TimeFormat = '24',
  timeZone: string = systemTimeZone(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = zonedParts(date.getTime(), timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${formatClock(
    parts.hour * 60 + parts.minute,
    timeFormat,
  )}`;
}

/** 头像配色：与界面主色一致的一组高对比色，按地址稳定映射。 */
const AVATAR_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#6b7280'];

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/** 发件人头像：中文取首字，英文取首字母，颜色按地址哈希稳定。 */
export function avatarFor(addresses: EmailAddress[]): { initial: string; color: string } {
  const first = addresses[0];
  if (!first) return { initial: '?', color: '#6b7280' };
  const name = (first.name ?? '').trim();
  const seed = (first.address || name || '?').toLowerCase();
  const initial = name ? name.slice(0, 1) : (first.address || '?').slice(0, 1).toUpperCase();
  return { initial, color: AVATAR_COLORS[hashString(seed) % AVATAR_COLORS.length] as string };
}

const PROVIDER_TAG: Record<string, { label: string; color: string }> = {
  qq: { label: 'QQ', color: '#10b981' },
  netease: { label: '网易', color: '#f59e0b' },
  gmail: { label: 'Gmail', color: '#dc2626' },
  outlook: { label: 'Outlook', color: '#7c3aed' },
};

/** 邮件列表里的账户标签（统一收件箱下用于区分来源）。 */
export function accountTagFor(account: {
  providerPreset?: string;
  displayName: string;
  color?: string;
}): { label: string; color: string } {
  const preset = account.providerPreset ? PROVIDER_TAG[account.providerPreset] : undefined;
  if (preset) return preset;
  return {
    label: account.displayName.slice(0, 3),
    color: account.color ?? '#2563eb',
  };
}
