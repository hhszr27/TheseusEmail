import { parseRibbonOverrides, type RibbonOverrides } from '../../shared/ribbon';

/**
 * 跨窗口同步的渲染侧接线。
 *
 * 主进程在 `settings:set` 写入 ribbon 键后广播给所有窗口，
 * 这里把广播的 JSON 解析成覆盖配置再交给调用方。
 *
 * 单独抽出来是为了可测：解析失败（脏数据 / 空值）必须回退成 null（= 内置默认），
 * 不能让一个坏字符串把工具栏搞成空白。
 */
export interface RibbonChangedSource {
  onRibbonChanged(callback: (json: string) => void): () => void;
}

export function subscribeRibbonChanges(
  api: RibbonChangedSource,
  onUpdate: (overrides: RibbonOverrides | null) => void,
): () => void {
  return api.onRibbonChanged((json) => {
    onUpdate(parseRibbonOverrides(json));
  });
}
