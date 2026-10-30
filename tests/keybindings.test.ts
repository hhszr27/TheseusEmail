import { describe, expect, it } from 'vitest';
import {
  HOST_COMMANDS,
  bindingFromEvent,
  bindingSignature,
  detectConflicts,
  formatBinding,
  matchesKeyboardEvent,
  mergeBindings,
} from '../src/shared/keybindings';

describe('快捷键注册表（§21.1）', () => {
  it('签名与修饰键顺序无关', () => {
    expect(bindingSignature({ key: 'K', modifiers: ['ctrl', 'shift'] })).toBe('ctrl+shift+k');
    expect(bindingSignature({ key: 'k', modifiers: ['shift', 'ctrl'] })).toBe('ctrl+shift+k');
    expect(bindingSignature({ key: ' ' })).toBe('space');
  });

  it('检测冲突', () => {
    const conflicts = detectConflicts([
      { command: 'a', binding: { key: 'k', modifiers: ['ctrl'] } },
      { command: 'b', binding: { key: 'k', modifiers: ['ctrl'] } },
      { command: 'c', binding: { key: 'j' } },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.commands.sort()).toEqual(['a', 'b']);
  });

  it('覆盖与解除绑定', () => {
    const merged = mergeBindings(
      [
        { command: 'a', binding: { key: 'a' } },
        { command: 'b', binding: { key: 'b' } },
      ],
      { b: { key: 'x', modifiers: ['alt'] }, a: null },
    );
    expect(merged.find((entry) => entry.command === 'a')?.binding).toBeNull();
    expect(merged.find((entry) => entry.command === 'b')?.binding).toEqual({
      key: 'x',
      modifiers: ['alt'],
    });
  });

  it('键盘事件精确匹配修饰键', () => {
    const binding = { key: 'k', modifiers: ['ctrl'] };
    expect(
      matchesKeyboardEvent(binding, {
        key: 'k',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(true);
    expect(
      matchesKeyboardEvent(binding, {
        key: 'k',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe(false);
  });

  it('录制时忽略纯修饰键，并格式化展示', () => {
    expect(
      bindingFromEvent({
        key: 'Control',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    expect(
      bindingFromEvent({
        key: 'K',
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toEqual({ key: 'k', modifiers: ['ctrl'] });
    expect(formatBinding({ key: 'k', modifiers: ['ctrl'] })).toBe('Ctrl + K');
    expect(formatBinding(null)).toBe('未设置');
  });
});

describe('宿主命令注册表', () => {
  it('命令 id 唯一', () => {
    const ids = HOST_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('默认绑定之间没有冲突', () => {
    const bindings = HOST_COMMANDS.filter(
      (command): command is typeof command & { defaultKeybinding: { key: string } } =>
        command.defaultKeybinding !== undefined,
    ).map((command) => ({ command: command.id, binding: command.defaultKeybinding }));

    // 期望值由测试自己给出：默认绑定必须两两不同
    const signatures = bindings.map((entry) => bindingSignature(entry.binding));
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(detectConflicts(bindings)).toEqual([]);
  });

  it('邮件操作快捷键都已注册', () => {
    const ids = HOST_COMMANDS.map((command) => command.id);
    for (const id of ['mail.archive', 'mail.delete', 'mail.star', 'mail.toggleRead', 'mail.reply']) {
      expect(ids).toContain(id);
    }
    // 归档/删除/星标/已读都是无修饰单键，回复用 R，不能与 Ctrl+R 刷新混为一谈
    const byId = new Map(HOST_COMMANDS.map((command) => [command.id, command.defaultKeybinding]));
    expect(bindingSignature(byId.get('mail.archive')!)).toBe('e');
    expect(bindingSignature(byId.get('mail.delete')!)).toBe('delete');
    expect(bindingSignature(byId.get('mail.reply')!)).toBe('r');
    expect(bindingSignature(byId.get('mail.refresh')!)).toBe('ctrl+r');
  });
});
