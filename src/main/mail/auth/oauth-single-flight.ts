/**
 * OAuth 令牌刷新单飞协调器（§7.5）。
 *
 * 硬性要求：
 *  - 同一账户的刷新必须是单飞的，否则 refresh token rotation 会被服务商判定"重用"
 *  - 刷新成功后、返回给调用方之前，必须先持久化轮换后的 refresh token
 *  - invalid_grant 不是"重试"，而是 requires_reauth 并停止后台刷新
 */

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType?: string;
}

export interface TokenPersistence {
  loadRefreshToken(accountId: string): Promise<string | null>;
  saveRefreshToken(accountId: string, refreshToken: string): Promise<void>;
  markRequiresReauth(accountId: string): Promise<void>;
}

export type RefreshFn = (accountId: string, refreshToken: string) => Promise<TokenSet>;

export class RequiresReauthError extends Error {
  readonly code = 'requires_reauth';
  constructor(message = '需要重新登录') {
    super(message);
    this.name = 'RequiresReauthError';
  }
}

export function isInvalidGrant(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; error?: unknown; message?: unknown };
  if (record.code === 'invalid_grant' || record.error === 'invalid_grant') return true;
  return typeof record.message === 'string' && /invalid_grant/i.test(record.message);
}

export class OAuthRefreshCoordinator {
  private readonly inflight = new Map<string, Promise<TokenSet>>();

  constructor(
    private readonly refreshFn: RefreshFn,
    private readonly persistence: TokenPersistence,
  ) {}

  /** 单飞刷新：并发调用共享同一个 Promise。 */
  refresh(accountId: string): Promise<TokenSet> {
    const existing = this.inflight.get(accountId);
    if (existing) return existing;

    const promise = this.run(accountId).finally(() => {
      this.inflight.delete(accountId);
    });
    this.inflight.set(accountId, promise);
    return promise;
  }

  isRefreshing(accountId: string): boolean {
    return this.inflight.has(accountId);
  }

  private async run(accountId: string): Promise<TokenSet> {
    const refreshToken = await this.persistence.loadRefreshToken(accountId);
    if (!refreshToken) {
      await this.persistence.markRequiresReauth(accountId);
      throw new RequiresReauthError('缺少 refresh token');
    }

    try {
      const tokens = await this.refreshFn(accountId, refreshToken);

      // 关键顺序：先落盘，再返回；进程若在此后崩溃也不会用旧 token 触发重用检测
      if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
        await this.persistence.saveRefreshToken(accountId, tokens.refreshToken);
      }

      return tokens;
    } catch (error) {
      if (isInvalidGrant(error)) {
        await this.persistence.markRequiresReauth(accountId);
        throw new RequiresReauthError('授权已失效或令牌被判定重用');
      }
      throw error;
    }
  }
}
