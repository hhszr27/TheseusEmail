import { Extension } from '@tiptap/core';

export const INDENT_STEP = 24;
export const MAX_INDENT = 8;

/**
 * 段落缩进（Outlook 的「增加/减少缩进」）。
 *
 * 没有官方 v3 包，这里用全局属性给 paragraph / heading 挂一个 `indent` 步进值，
 * 渲染成 `margin-left`。步长 24px、上限 8 级——和 Outlook 默认一致。
 * 产物是 inline style，过主进程净化时由 DOMPurify 保留（见 sanitizeComposeHtml）。
 */
export const Indent = Extension.create({
  name: 'indent',

  addOptions() {
    return { types: ['paragraph', 'heading'] as string[] };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => {
              const v = (el as HTMLElement).style.marginLeft;
              const m = /(\d+(?:\.\d+)?)px/.exec(v);
              return m ? Math.round(parseFloat(m[1] ?? '0') / INDENT_STEP) : 0;
            },
            renderHTML: (attrs) =>
              attrs.indent ? { style: `margin-left: ${attrs.indent * INDENT_STEP}px` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    const apply =
      (delta: number) =>
      ({ state, dispatch }: any): boolean => {
        const { $from } = state.selection;
        // 选区顶到 doc 时（如全选），$from.parent 是 doc 而非段落，要下沉到 depth=1 的块
        const depth = $from.depth === 0 ? 1 : $from.depth;
        const blockPos = $from.before(depth);
        const node = state.doc.nodeAt(blockPos);
        if (!node || !this.options.types.includes(node.type.name)) return false;
        const current = (node.attrs.indent as number) ?? 0;
        const next = Math.max(0, Math.min(MAX_INDENT, current + delta));
        if (next === current) return false;
        if (dispatch) {
          // 用命令自带的 state.tr + dispatch 下发，绝不走 editor.chain().focus()
          // —— 后者在 headless / 未挂载视图时会抛「Applying a mismatched transaction」。
          const tr = state.tr.setNodeMarkup(blockPos, undefined, { ...node.attrs, indent: next });
          dispatch(tr);
        }
        return true;
      };

    return {
      indent: () => apply(1),
      outdent: () => apply(-1),
    };
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      /** 增加缩进一级（24px）。 */
      indent: () => ReturnType;
      /** 减少缩进一级。 */
      outdent: () => ReturnType;
    };
  }
}
