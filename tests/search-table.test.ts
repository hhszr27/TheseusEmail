// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Search } from '../src/renderer/extensions/search';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';

function makeEditor(): Editor {
  return new Editor({
    extensions: [StarterKit, TextStyle, Color, FontFamily, FontSize, Search, Table, TableRow, TableHeader, TableCell],
    content: '<p>重要通知：本周五开会。</p>',
  });
}

describe('Search 含表格文档', () => {
  it('简单文档全部替换', () => {
    const editor = makeEditor();
    editor.commands.setSearchTerm('通知');
    editor.commands.setReplaceTerm('公告');
    editor.commands.replaceAllSearch();
    expect(editor.getText()).toContain('公告');
    expect(editor.getText()).not.toContain('通知');
    editor.destroy();
  });

  it('含表格文档全部替换', () => {
    const editor = makeEditor();
    editor.commands.insertContent('<table><tbody><tr><th>h</th><td>c</td></tr></tbody></table>');
    editor.commands.setSearchTerm('通知');
    editor.commands.setReplaceTerm('公告');
    editor.commands.replaceAllSearch();
    expect(editor.getText()).toContain('公告');
    expect(editor.getText()).not.toContain('通知');
    editor.destroy();
  });

  it('含表格文档单次替换', () => {
    const editor = makeEditor();
    editor.commands.insertContent('<table><tbody><tr><td>x</td></tr></tbody></table>');
    editor.commands.setSearchTerm('通知');
    editor.commands.setReplaceTerm('公告');
    editor.commands.replaceSearch();
    expect(editor.getText()).toContain('公告');
    expect(editor.getText()).not.toContain('通知');
    editor.destroy();
  });
});
