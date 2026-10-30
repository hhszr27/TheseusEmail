import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

export interface SearchOptions {
  caseSensitive: boolean;
}

export interface SearchResult {
  from: number;
  to: number;
}

export interface SearchStorage {
  results: SearchResult[];
  current: number;
  searchTerm: string;
  replaceTerm: string;
  /** 与 options.caseSensitive 同步，供 UI（受控 checkbox）读取。 */
  caseSensitive: boolean;
}

/**
 * 块内不可匹配的分隔符：图片、硬换行这类非文本节点占位。
 * 用它隔断文本，避免「通<img>知」被误判成命中「通知」（替换会连节点一起吃掉）。
 * 用户输入里不可能出现 \u0000，所以命中永远不会跨越它。
 */
const INLINE_BREAK = '\u0000';

/** 把一段 inline 内容摊平成「文本 + 每个字符的文档位置」。 */
function collectInline(node: PMNode, start: number, out: { text: string; map: number[] }): void {
  let off = start;
  node.forEach((child) => {
    if (child.isText) {
      const t = child.text ?? '';
      for (let i = 0; i < t.length; i++) out.map.push(off + i);
      out.text += t;
    } else if (child.childCount > 0) {
      // 嵌套的行内容器（如 link 被建模成节点时），跳过开标签继续收
      collectInline(child, off + 1, out);
    } else {
      out.map.push(off);
      out.text += INLINE_BREAK;
    }
    off += child.nodeSize;
  });
}

/**
 * 全文查找。
 *
 * 关键点：**按 textblock 摊平后再匹配**，而不是逐 text node 匹配——
 * 否则「重要通<strong>知</strong>」这种被加粗/链接/颜色切断的词永远搜不到。
 * 只在同一个块内匹配（不跨段落），替换才不会把两个段落并成一个。
 */
function findMatches(doc: PMNode, text: string, caseSensitive: boolean): SearchResult[] {
  const results: SearchResult[] = [];
  if (!text || text.includes(INLINE_BREAK)) return results;
  const needle = caseSensitive ? text : text.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const out: { text: string; map: number[] } = { text: '', map: [] };
    collectInline(node, pos + 1, out);
    // 极少数字符 toLowerCase 后长度会变（如 'İ'），那样下标映射就失效了——
    // 退化为大小写敏感匹配，宁可少命中也不能错位替换。
    const lowered = caseSensitive ? out.text : out.text.toLowerCase();
    const hay = lowered.length === out.text.length ? lowered : out.text;
    const want = hay === out.text ? text : needle;
    let idx = hay.indexOf(want);
    while (idx !== -1) {
      const from = out.map[idx];
      const last = out.map[idx + text.length - 1];
      if (from !== undefined && last !== undefined) results.push({ from, to: last + 1 });
      idx = hay.indexOf(want, idx + text.length);
    }
    return false;
  });
  return results;
}

function scrollToResult(editor: any, pos: number): void {
  try {
    const dom = editor.view.domAtPos(pos);
    const node = dom.node instanceof HTMLElement ? dom.node : (dom.node.parentElement as HTMLElement);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch {
    /* 位置可能已失效，忽略 */
  }
}

/**
 * 查找 / 替换（Outlook 的「查找」面板）。
 *
 * 没有官方 v3 包，用 ProseMirror 装饰实现：
 *  - 所有命中用 `.mf-search-hit` 高亮，当前命中额外加 `.mf-search-current`；
 *  - 替换走 `insertContentAt` / `insertText`，从后往前替换避免位置错位。
 * 仅做纯文本匹配（不做正则），避免 ReDoS 与注入风险。
 */
export const Search = Extension.create<SearchOptions, SearchStorage>({
  name: 'search',

  addOptions() {
    return { caseSensitive: false };
  },

  addStorage() {
    return {
      results: [],
      current: 0,
      searchTerm: '',
      replaceTerm: '',
      caseSensitive: this.options.caseSensitive,
    };
  },

  addCommands() {
    return {
      setSearchTerm:
        (term: string) =>
        ({ editor }) => {
          this.storage.searchTerm = term;
          this.storage.results = findMatches(editor.state.doc, term, this.options.caseSensitive);
          this.storage.current = 0;
          scrollToResult(editor, this.storage.results[0]?.from ?? 0);
          editor.view.dispatch(editor.state.tr.setMeta('searchUpdate', true));
          return true;
        },
      setReplaceTerm:
        (term: string) =>
        () => {
          this.storage.replaceTerm = term;
          return true;
        },
      setCaseSensitive:
        (value: boolean) =>
        ({ editor }) => {
          this.options.caseSensitive = value;
          this.storage.caseSensitive = value;
          this.storage.current = 0;
          this.storage.results = findMatches(editor.state.doc, this.storage.searchTerm, value);
          editor.view.dispatch(editor.state.tr.setMeta('searchUpdate', true));
          return true;
        },
      nextSearch:
        () =>
        ({ editor }) => {
          const s = this.storage;
          if (s.results.length === 0) return false;
          s.current = (s.current + 1) % s.results.length;
          scrollToResult(editor, s.results[s.current]?.from ?? 0);
          editor.view.dispatch(editor.state.tr.setMeta('searchUpdate', true));
          return true;
        },
      prevSearch:
        () =>
        ({ editor }) => {
          const s = this.storage;
          if (s.results.length === 0) return false;
          s.current = (s.current - 1 + s.results.length) % s.results.length;
          scrollToResult(editor, s.results[s.current]?.from ?? 0);
          editor.view.dispatch(editor.state.tr.setMeta('searchUpdate', true));
          return true;
        },
      replaceSearch:
        () =>
        ({ editor, state, dispatch }) => {
          const s = this.storage;
          const r = s.results[s.current];
          if (!r) return false;
          if (dispatch) {
            let tr = state.tr.insertText(s.replaceTerm, r.from, r.to);
            tr.setMeta('searchUpdate', true);
            dispatch(tr);
          }
          // 替换后重算命中（基于新文档），并刷新高亮装饰
          s.results = findMatches(editor.state.doc, s.searchTerm, this.options.caseSensitive);
          if (s.current >= s.results.length) s.current = Math.max(0, s.results.length - 1);
          return true;
        },
      replaceAllSearch:
        () =>
        ({ editor, state, dispatch }) => {
          const term = this.storage.searchTerm;
          const repl = this.storage.replaceTerm;
          if (!term) return false;
          const matches = findMatches(state.doc, term, this.options.caseSensitive);
          if (matches.length === 0) return false;
          if (dispatch) {
            // 从后往前替换，保证早先命中位置在已修改文档里依然有效；
            // 用命令自带的 dispatch（而非 editor.view.dispatch）下发手工 tr，
            // 否则 tr.before 与当前 state.doc 不一致会抛 mismatched transaction。
            let tr = state.tr;
            for (let i = matches.length - 1; i >= 0; i--) {
              const m = matches[i];
              if (!m) continue;
              tr = tr.insertText(repl, m.from, m.to);
            }
            tr.setMeta('searchUpdate', true);
            dispatch(tr);
          }
          this.storage.results = [];
          this.storage.current = 0;
          return true;
        },
      clearSearch:
        () =>
        ({ editor }) => {
          this.storage.results = [];
          this.storage.current = 0;
          // 词也要一起清掉：否则关闭查找栏后，正文一改动就会被下面的
          // 「文档变化重算命中」重新点亮一片黄。
          this.storage.searchTerm = '';
          this.storage.replaceTerm = '';
          editor.view.dispatch(editor.state.tr.setMeta('searchUpdate', true));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: new PluginKey('search'),
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, old) => {
            const meta = tr.getMeta('searchUpdate');
            if (!meta && !tr.docChanged) return old;
            // 正文被改动（用户继续打字、撤销、粘贴）时旧命中位置就失效了，
            // 这里按新文档重算，保证高亮 / 计数 / 下一个跳转都不指向错地方。
            if (tr.docChanged && storage.searchTerm) {
              storage.results = findMatches(tr.doc, storage.searchTerm, storage.caseSensitive);
              if (storage.current >= storage.results.length) {
                storage.current = Math.max(0, storage.results.length - 1);
              }
            }
            const decos: Decoration[] = [];
            storage.results.forEach((r, i) => {
              decos.push(
                Decoration.inline(r.from, r.to, {
                  class: i === storage.current ? 'mf-search-hit mf-search-current' : 'mf-search-hit',
                }),
              );
            });
            return DecorationSet.create(tr.doc, decos);
          },
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
        },
      }),
    ];
  },
});

declare module '@tiptap/core' {
  interface Storage {
    search: SearchStorage;
  }
  interface Commands<ReturnType> {
    search: {
      setSearchTerm: (term: string) => ReturnType;
      setReplaceTerm: (term: string) => ReturnType;
      setCaseSensitive: (value: boolean) => ReturnType;
      nextSearch: () => ReturnType;
      prevSearch: () => ReturnType;
      replaceSearch: () => ReturnType;
      replaceAllSearch: () => ReturnType;
      clearSearch: () => ReturnType;
    };
  }
}
