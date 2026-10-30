// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Search, type SearchStorage } from '../src/renderer/extensions/search';

function mk(content: string): Editor {
  return new Editor({
    extensions: [StarterKit, Image.configure({ allowBase64: true }), Search],
    content,
  });
}

function hits(editor: Editor): SearchStorage {
  return editor.storage.search as SearchStorage;
}

/** 命中位置在当前文档里实际指向的文字（防止位置错位后仍然「看起来有命中」）。 */
function hitTexts(editor: Editor): string[] {
  return hits(editor).results.map((r) => editor.state.doc.textBetween(r.from, r.to));
}

describe('Search 跨格式匹配', () => {
  it('词被加粗切断时仍能搜到', () => {
    const editor = mk('<p>重要通<strong>知</strong>：本周五开会</p>');
    editor.commands.setSearchTerm('通知');
    expect(hits(editor).results.length).toBe(1);
    expect(hitTexts(editor)).toEqual(['通知']);
    editor.destroy();
  });

  it('跨格式命中可以整体替换', () => {
    const editor = mk('<p>重要通<strong>知</strong>：本周五开会</p>');
    editor.commands.setSearchTerm('通知');
    editor.commands.setReplaceTerm('公告');
    editor.commands.replaceAllSearch();
    expect(editor.getText()).toContain('公告');
    expect(editor.getText()).not.toContain('通知');
    editor.destroy();
  });

  it('不跨段落匹配（替换不能把两段并成一段）', () => {
    const editor = mk('<p>重要通</p><p>知：开会</p>');
    editor.commands.setSearchTerm('通知');
    expect(hits(editor).results.length).toBe(0);
    editor.destroy();
  });

  it('不被内联节点（硬换行/图片）两侧的文字拼成假命中', () => {
    const editor = mk('<p>通<br>知</p>');
    editor.commands.setSearchTerm('通知');
    expect(hits(editor).results.length).toBe(0);
    editor.destroy();
  });

  it('大小写：默认不敏感，开关打开后只匹配同大小写', () => {
    const editor = mk('<p>Mail mail MAIL</p>');
    editor.commands.setSearchTerm('mail');
    expect(hits(editor).results.length).toBe(3);
    // 敏感后只剩完全同形的那个小写 mail
    editor.commands.setCaseSensitive(true);
    expect(hits(editor).results.length).toBe(1);
    expect(hitTexts(editor)).toEqual(['mail']);
    // UI 的受控 checkbox 读的是 storage，必须跟着命令一起翻
    expect(hits(editor).caseSensitive).toBe(true);
    editor.commands.setCaseSensitive(false);
    expect(hits(editor).caseSensitive).toBe(false);
    expect(hits(editor).results.length).toBe(3);
    editor.destroy();
  });
});

describe('Search 与文档改动同步', () => {
  it('正文改动后命中位置仍指向正确的文字', () => {
    const editor = mk('<p>通知</p>');
    editor.commands.setSearchTerm('通知');
    // 在命中前插入一段文字，旧的位置会整体后移
    editor.commands.insertContentAt(1, '前面加一句。');
    expect(hits(editor).results.length).toBe(1);
    expect(hitTexts(editor)).toEqual(['通知']);
    editor.destroy();
  });

  it('命中被删掉后不再残留', () => {
    const editor = mk('<p>通知</p>');
    editor.commands.setSearchTerm('通知');
    editor.commands.selectAll();
    editor.commands.deleteSelection();
    expect(hits(editor).results.length).toBe(0);
    editor.destroy();
  });

  it('关闭查找栏后改动正文不会重新点亮高亮', () => {
    const editor = mk('<p>通知</p>');
    editor.commands.setSearchTerm('通知');
    editor.commands.clearSearch();
    editor.commands.insertContentAt(1, '再写一句');
    expect(hits(editor).results.length).toBe(0);
    expect(hits(editor).searchTerm).toBe('');
    editor.destroy();
  });

  it('「下一个」在命中重算后不会越界', () => {
    const editor = mk('<p>通知 通知 通知</p>');
    editor.commands.setSearchTerm('通知');
    expect(hits(editor).results.length).toBe(3);
    editor.commands.nextSearch();
    editor.commands.nextSearch();
    expect(hits(editor).current).toBe(2);
    // 删掉一个命中后，游标被夹回最后一个有效下标
    const first = hits(editor).results[2];
    editor.commands.deleteRange({ from: first!.from, to: first!.to });
    expect(hits(editor).current).toBeLessThan(hits(editor).results.length);
    editor.destroy();
  });
});
