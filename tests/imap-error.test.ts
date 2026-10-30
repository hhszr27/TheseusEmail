import { describe, expect, it } from 'vitest';
import { imapFailureText, isFolderUnselectable } from '../src/main/mail/sync/imap-error';

/**
 * imapflow 对服务器的 NO/BAD 只抛 `Error('Command failed')`，
 * 真实原因在 responseStatus / responseText / response.attributes 里。
 * 这些用例锁死「把原因带出来」这件事——否则用户界面永远只有一句 Command failed。
 */
describe('IMAP 失败报文（imap-error.ts）', () => {
  it('把服务器原文拼到「Command failed」后面', () => {
    const error = {
      message: 'Command failed',
      responseStatus: 'NO',
      response: { attributes: [{ value: 'Mailbox does not exist' }] },
    };
    expect(imapFailureText(error)).toBe('Command failed（NO: Mailbox does not exist）');
  });

  it('优先使用 responseText', () => {
    expect(
      imapFailureText({
        message: 'Command failed',
        responseStatus: 'BAD',
        responseText: 'Invalid arguments',
      }),
    ).toBe('Command failed（BAD: Invalid arguments）');
  });

  it('多个属性片段拼成一句，忽略非字符串', () => {
    const error = {
      message: 'Command failed',
      responseStatus: 'NO',
      response: { attributes: [{ value: ' [TRYCREATE]' }, { value: 42 }, { value: 'Try again' }] },
    };
    expect(imapFailureText(error)).toBe('Command failed（NO: [TRYCREATE] Try again）');
  });

  it('没有服务器文本时退回原始 message', () => {
    expect(imapFailureText(new Error('socket hang up'))).toBe('socket hang up');
    expect(imapFailureText({ message: 'Command failed', responseStatus: 'NO' })).toBe('Command failed');
  });

  it('只有 NO 才判定为「文件夹不可选」', () => {
    expect(isFolderUnselectable({ responseStatus: 'NO' })).toBe(true);
    expect(isFolderUnselectable({ responseStatus: 'BAD' })).toBe(false);
    expect(isFolderUnselectable(new Error('Command failed'))).toBe(false);
    expect(isFolderUnselectable(null)).toBe(false);
  });
});
