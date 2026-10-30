/**
 * 设置页搜索：按 `.settings-section` 区块过滤。
 *
 * 为什么不给每个设置项加标记：设置内容分散在十几个子组件（账户、通知、日历、插件…），
 * 逐个加 data 属性必然漏、且新加设置时没人会记得补。`.settings-section` 是它们统一的容器，
 * 用区块文本匹配既覆盖全部（含插件动态渲染的内容），也不需要维护清单。
 */

/** 搜索词归一化：去首尾空白、忽略大小写。空串表示不过滤。 */
export function normalizeSettingsQuery(value: string): string {
  return value.trim().toLowerCase();
}

/** 某段文本是否命中搜索词；空搜索词视为命中。 */
export function matchesSettingsQuery(text: string, query: string): boolean {
  const keyword = normalizeSettingsQuery(query);
  if (!keyword) return true;
  return text.toLowerCase().includes(keyword);
}

export interface SettingsSectionItem {
  index: number;
  title: string;
}

/**
 * 收集设置页的区块标题，供左侧菜单使用。
 * 缺 `h3` 时用序号兜底，保证菜单项数量与区块数量始终一致（点击序号才对得上）。
 */
export function collectSettingsSections(root: HTMLElement): SettingsSectionItem[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.settings-section')).map(
    (section, index) => ({
      index,
      title: section.querySelector('h3')?.textContent?.trim() || `设置 ${index + 1}`,
    }),
  );
}

/**
 * 在容器内应用过滤，返回可见区块数。
 *
 * 用 `data-search-hidden` 而不是 `style.display` / `hidden`：
 * React 不管理这个属性，重渲染不会把它覆盖掉，样式由 CSS 统一控制。
 */
export function applySettingsFilter(root: HTMLElement, query: string): number {
  const sections = Array.from(root.querySelectorAll<HTMLElement>('.settings-section'));
  let visible = 0;

  for (const section of sections) {
    if (matchesSettingsQuery(section.textContent ?? '', query)) {
      section.removeAttribute('data-search-hidden');
      visible += 1;
    } else {
      section.setAttribute('data-search-hidden', '');
    }
  }

  return visible;
}
