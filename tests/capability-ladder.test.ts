import { describe, expect, it } from 'vitest';
import {
  initialLevel,
  isAuthFailure,
  isTransientFailure,
  nextLevel,
  shouldDowngrade,
} from '../src/main/mail/sync/capability-ladder';

describe('同步能力阶梯（§8.3）', () => {
  it('L1 → L2 → L3 → 终止', () => {
    expect(nextLevel('L1_CHANGEDSINCE')).toBe('L2_SEARCH_SINCE');
    expect(nextLevel('L2_SEARCH_SINCE')).toBe('L3_UIDNEXT');
    expect(nextLevel('L3_UIDNEXT')).toBeNull();
  });

  it('按服务器能力选择初始级别', () => {
    expect(initialLevel(['CONDSTORE'])).toBe('L1_CHANGEDSINCE');
    expect(initialLevel(['QRESYNC'])).toBe('L1_CHANGEDSINCE');
    expect(initialLevel(['SEARCH'])).toBe('L2_SEARCH_SINCE');
    expect(initialLevel([])).toBe('L3_UIDNEXT');
  });

  it('网络/临时性失败绝不降级', () => {
    expect(isTransientFailure({ code: 'ECONNRESET' })).toBe(true);
    expect(shouldDowngrade({ code: 'ETIMEDOUT', message: 'Connection timeout' }).downgrade).toBe(false);
    expect(shouldDowngrade({ message: 'socket hang up' }).downgrade).toBe(false);
    expect(shouldDowngrade({ responseStatus: 'NO', responseText: 'Mailbox is locked, try again' }).downgrade).toBe(false);
  });

  it('不可解析响应触发降级', () => {
    const verdict = shouldDowngrade({ message: 'Cannot parse FETCH response' });
    expect(verdict.downgrade).toBe(true);
    expect(verdict.reason).toContain('Cannot parse');
  });

  it('BAD 响应触发降级', () => {
    expect(shouldDowngrade({ responseStatus: 'BAD', responseText: 'Invalid arguments' }).downgrade).toBe(true);
  });

  it('明确的 NO（不支持/未知参数）才降级', () => {
    expect(shouldDowngrade({ responseStatus: 'NO', responseText: 'CHANGEDSINCE not supported' }).downgrade).toBe(true);
    expect(shouldDowngrade({ responseStatus: 'NO', responseText: 'Mailbox does not exist' }).downgrade).toBe(false);
  });

  it('无方言证据不降级', () => {
    expect(shouldDowngrade({ message: 'Something odd happened' }).downgrade).toBe(false);
  });

  it('识别认证失败', () => {
    expect(isAuthFailure({ responseStatus: 'NO', responseText: 'AUTHENTICATIONFAILED' })).toBe(true);
    expect(isAuthFailure({ message: 'Invalid credentials' })).toBe(true);
    expect(isAuthFailure({ message: 'Cannot parse response' })).toBe(false);
  });
});
