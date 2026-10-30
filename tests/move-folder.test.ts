import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailforgeApi } from '../src/shared/ipc';
import type { EmailSummary } from '../src/shared/types';
import { useMailStore } from '../src/renderer/stores/mail-store';

// 渲染进程通过 src/renderer/env.d.ts 声明 window.api；该声明不在 node 配置里，
// 测试侧补一份全局类型，使 store（及其依赖）在 node 类型检查下能通过。
declare global {
  interface Window {
    api: MailforgeApi;
  }
}

const moveEmailMock = vi.fn();

function makeEmail(id: string, folder: string, accountId = 'acc-1'): EmailSummary {
  return {
    id,
    uid: 1,
    folder,
    accountId,
    subject: `subject-${id}`,
    from: [{ address: 'a@example.com' }],
    to: [{ address: 'b@example.com' }],
    date: new Date(0).toISOString(),
    snippet: 'snippet',
    hasAttachments: false,
    unread: true,
    starred: false,
    pinned: false,
  };
}

beforeEach(() => {
  moveEmailMock.mockReset();
  const g = globalThis as unknown as { window?: Partial<Window> };
  g.window = { api: { moveEmail: moveEmailMock } as unknown as MailforgeApi };
  useMailStore.setState({
    emails: [],
    total: 0,
    selectedEmailId: null,
    externalSelected: null,
    body: null,
    error: null,
  });
});

describe('store.moveEmail', () => {
  it('成功后调用 window.api.moveEmail，并从 emails 移除、total 递减', async () => {
    const email = makeEmail('e1', 'INBOX');
    useMailStore.setState({
      emails: [email, makeEmail('e2', 'INBOX')],
      total: 2,
      selectedEmailId: 'e1',
      externalSelected: email,
    });
    moveEmailMock.mockResolvedValue({ ok: true, data: { ...email, folder: 'Archive' } });

    await useMailStore.getState().moveEmail('e1', 'Archive');

    expect(moveEmailMock).toHaveBeenCalledWith('e1', 'Archive');
    const state = useMailStore.getState();
    expect(state.emails.find((entry) => entry.id === 'e1')).toBeUndefined();
    expect(state.emails).toHaveLength(1);
    expect(state.total).toBe(1);
    // 选中邮件被移走：清空选中态与阅读区
    expect(state.selectedEmailId).toBeNull();
    expect(state.externalSelected).toBeNull();
    expect(state.body).toBeNull();
    expect(state.error).toBeNull();
  });

  it('失败时设置 error 并保留本地邮件与总数', async () => {
    const email = makeEmail('e1', 'INBOX');
    useMailStore.setState({ emails: [email], total: 1, error: null });
    moveEmailMock.mockResolvedValue({
      ok: false,
      error: { code: 'SERVER_FAILED', message: 'move failed' },
    });

    await useMailStore.getState().moveEmail('e1', 'Archive');

    const state = useMailStore.getState();
    expect(moveEmailMock).toHaveBeenCalledWith('e1', 'Archive');
    expect(state.emails.find((entry) => entry.id === 'e1')).toBeDefined();
    expect(state.total).toBe(1);
    expect(state.error).toBe('move failed');
  });
});
