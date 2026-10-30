// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  applySettingsFilter,
  collectSettingsSections,
  matchesSettingsQuery,
  normalizeSettingsQuery,
} from '../src/renderer/lib/settings-search';

/**
 * 设置搜索按 `.settings-section` 过滤。
 * 这里只构造最小 DOM，不需要挂载整个设置页（它依赖 store、诊断、插件等一大堆异步数据）。
 */
describe('设置搜索', () => {
  it('归一化：去首尾空白、忽略大小写', () => {
    expect(normalizeSettingsQuery('  时区 ')).toBe('时区');
    expect(normalizeSettingsQuery('Time')).toBe('time');
    expect(normalizeSettingsQuery('   ')).toBe('');
  });

  it('空搜索词视为全部命中', () => {
    expect(matchesSettingsQuery('任意文本', '')).toBe(true);
    expect(matchesSettingsQuery('任意文本', '   ')).toBe(true);
  });

  it('按区块过滤，返回可见数量，清空后恢复', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <section class="settings-section"><h3>时间</h3><p>时间格式与时区</p></section>
      <section class="settings-section"><h3>通知</h3><p>桌面通知与提醒</p></section>
      <section class="settings-section"><h3>日历</h3><p>工作时间</p></section>
    `;
    const sections = Array.from(root.querySelectorAll('.settings-section'));

    expect(applySettingsFilter(root, '时区')).toBe(1);
    expect(sections[0]?.hasAttribute('data-search-hidden')).toBe(false);
    expect(sections[1]?.hasAttribute('data-search-hidden')).toBe(true);
    expect(sections[2]?.hasAttribute('data-search-hidden')).toBe(true);

    // 清空搜索：全部恢复
    expect(applySettingsFilter(root, '')).toBe(3);
    expect(sections.every((section) => !section.hasAttribute('data-search-hidden'))).toBe(true);
  });

  it('标题与正文都能命中，大小写不敏感', () => {
    const root = document.createElement('div');
    root.innerHTML = `<section class="settings-section"><h3>阅读</h3><p>自动全屏</p></section>`;

    expect(applySettingsFilter(root, '阅读')).toBe(1);
    expect(applySettingsFilter(root, '全屏')).toBe(1);
    expect(applySettingsFilter(root, '不存在的词')).toBe(0);
  });

  it('收集区块标题用于左侧菜单，缺标题时按序号兜底', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <section class="settings-section"><h3>时间</h3></section>
      <section class="settings-section"><h3> 通知 </h3></section>
      <section class="settings-section"><p>没有标题</p></section>
    `;

    expect(collectSettingsSections(root)).toEqual([
      { index: 0, title: '时间' },
      { index: 1, title: '通知' },
      { index: 2, title: '设置 3' },
    ]);
  });
});
