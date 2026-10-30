import { describe, expect, it } from 'vitest';
import {
  OAuthRefreshCoordinator,
  RequiresReauthError,
  type TokenPersistence,
  type TokenSet,
} from '../src/main/mail/auth/oauth-single-flight';

class FakePersistence implements TokenPersistence {
  tokens = new Map<string, string>();
  saved: string[] = [];
  reauth: string[] = [];

  async loadRefreshToken(accountId: string): Promise<string | null> {
    return this.tokens.get(accountId) ?? null;
  }

  async saveRefreshToken(accountId: string, refreshToken: string): Promise<void> {
    this.tokens.set(accountId, refreshToken);
    this.saved.push(refreshToken);
  }

  async markRequiresReauth(accountId: string): Promise<void> {
    this.reauth.push(accountId);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('OAuth 单飞刷新（§7.5）', () => {
  it('并发刷新只触发一次网络请求', async () => {
    const persistence = new FakePersistence();
    persistence.tokens.set('acc', 'r1');

    let calls = 0;
    const coordinator = new OAuthRefreshCoordinator(async () => {
      calls += 1;
      await delay(30);
      return { accessToken: 'a1', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 };
    }, persistence);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => coordinator.refresh('acc')),
    );

    expect(calls).toBe(1);
    expect(results.every((item) => item.accessToken === 'a1')).toBe(true);
    expect(persistence.saved).toEqual(['r2']);
  });

  it('轮换后的 refresh token 先持久化，再返回调用方', async () => {
    const persistence = new FakePersistence();
    persistence.tokens.set('acc', 'old');

    const order: string[] = [];
    const coordinator = new OAuthRefreshCoordinator(async (): Promise<TokenSet> => {
      order.push('refresh');
      await delay(5);
      return { accessToken: 'a', refreshToken: 'new', expiresAt: Date.now() + 1000 };
    }, {
      loadRefreshToken: (id) => persistence.loadRefreshToken(id),
      saveRefreshToken: async (id, token) => {
        order.push('save');
        await persistence.saveRefreshToken(id, token);
      },
      markRequiresReauth: (id) => persistence.markRequiresReauth(id),
    });

    const tokens = await coordinator.refresh('acc').then((value) => {
      order.push('resolved');
      return value;
    });

    expect(tokens.refreshToken).toBe('new');
    expect(order).toEqual(['refresh', 'save', 'resolved']);
  });

  it('invalid_grant 标记 requires_reauth 且不再重试', async () => {
    const persistence = new FakePersistence();
    persistence.tokens.set('acc', 'r1');

    let calls = 0;
    const coordinator = new OAuthRefreshCoordinator(async () => {
      calls += 1;
      throw Object.assign(new Error('invalid_grant: token revoked'), { code: 'invalid_grant' });
    }, persistence);

    await expect(coordinator.refresh('acc')).rejects.toBeInstanceOf(RequiresReauthError);
    expect(calls).toBe(1);
    expect(persistence.reauth).toEqual(['acc']);
  });

  it('缺少 refresh token 时直接要求重新登录', async () => {
    const persistence = new FakePersistence();
    const coordinator = new OAuthRefreshCoordinator(async () => {
      throw new Error('should not be called');
    }, persistence);

    await expect(coordinator.refresh('missing')).rejects.toBeInstanceOf(RequiresReauthError);
    expect(persistence.reauth).toEqual(['missing']);
  });

  it('服务商未轮换时保留原 refresh token', async () => {
    const persistence = new FakePersistence();
    persistence.tokens.set('acc', 'r1');

    const coordinator = new OAuthRefreshCoordinator(async () => ({
      accessToken: 'a',
      expiresAt: Date.now() + 1000,
    }), persistence);

    await coordinator.refresh('acc');
    expect(persistence.saved).toEqual([]);
    expect(persistence.tokens.get('acc')).toBe('r1');
  });
});
