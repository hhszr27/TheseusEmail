// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Indent } from '../src/renderer/extensions/indent';
import { Search } from '../src/renderer/extensions/search';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';

function makeEditor(): Editor {
  return new Editor({
    extensions: [StarterKit, TextStyle, Color, FontFamily, FontSize, Indent, Search, Table, TableRow, TableHeader, TableCell],
    content: '<p>hello world</p>',
  });
}

describe('Tiptap 扩展命令（jsdom 验证）', () => {
  it('indent 给段落加 margin-left', () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    const parentName = (editor.state.selection as any).$from.parent.type.name;
    const okChain = editor.chain().focus().updateAttributes('paragraph', { indent: 1 }).run();
    console.log('parentName=', parentName, 'okChain=', okChain, 'html=', editor.getHTML());
    expect(editor.getHTML()).toContain('margin-left');
    editor.destroy();
  });

  it('outdent 把 margin-left 收回', () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    editor.commands.indent();
    editor.commands.selectAll();
    editor.commands.outdent();
    expect(editor.getHTML()).not.toContain('margin-left');
    editor.destroy();
  });

  it('setColor 产出 span style=color', () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    const ok = editor.commands.setColor('#dc2626');
    expect(ok).toBe(true);
    // Tiptap/ProseMirror 会把 #dc2626 规范化为 rgb(220, 38, 38)，二者等价
    expect(editor.getHTML()).toContain('color: rgb(220, 38, 38)');
    editor.destroy();
  });

  it('setFontSize 产出 span style=font-size', () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    editor.commands.setFontSize('20px');
    expect(editor.getHTML()).toContain('font-size: 20px');
    editor.destroy();
  });

  it('Search：查找命中、全部替换', () => {
    const editor = makeEditor();
    editor.commands.insertContent('apple banana apple');
    editor.commands.setSearchTerm('apple');
    editor.commands.setReplaceTerm('橙子');
    expect((editor.storage as any).search.results.length).toBeGreaterThan(0);
    editor.commands.replaceAllSearch();
    expect(editor.getText()).toContain('橙子');
    expect(editor.getText()).not.toContain('apple');
    editor.destroy();
  });
});
