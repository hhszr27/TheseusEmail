import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  extractInlineImages,
  restoreUnstagedInlineImages,
} from '../src/main/mail/inline-images';
import { ComposeAttachmentStore } from '../src/main/mail/compose-attachments';
import { SmtpSender } from '../src/main/mail/smtp-sender';
import type { Account } from '../src/shared/types';
import type { SecretStore } from '../src/main/mail/auth/token-store';

/**
 * 正文内嵌图片 → CID 附件：
 *  - 抽取：src 改写、同图去重、超限/坏数据原样保留、不误伤别的属性；
 *  - 落盘：写进暂存目录，内容与 cid 都能对上；
 *  - 发送：带 cid 的 part 必须是 inline + Content-ID，普通附件不受影响。
 *
 * 期望值一律写在测试这一侧（自己拼 data URI、自己数字节），不与被测代码同源。
 */

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, close: vi.fn() }));
  return { sendMail, createTransport };
});

vi.mock('nodemailer', () => ({ default: { createTransport } }));

/** 自己造一张确定内容的 PNG，不复用被测代码的任何东西。 */
function makeDataImage(bytes: string, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(bytes, 'utf8').toString('base64')}`;
}

function img(src: string, quote = '"'): string {
  return `<p><img src=${quote}${src}${quote} alt="x"></p>`;
}

const PNG_A = makeDataImage('AAAA-png-bytes');
const PNG_B = makeDataImage('BBBB-png-bytes');

describe('内嵌图片抽取', () => {
  it('把 data URI 图片抽成附件，正文改写为 cid 引用', () => {
    const result = extractInlineImages(img(PNG_A));

    expect(result.images).toHaveLength(1);
    const image = result.images[0]!;
    expect(result.html).toBe(img(`cid:${image.cid}`));
    // 解码出来的字节必须和原图一致，不能有 base64 残留
    expect(image.content.toString('utf8')).toBe('AAAA-png-bytes');
    expect(image.contentType).toBe('image/png');
    expect(image.filename.endsWith('.png')).toBe(true);
  });

  it('同一张图出现多次只产出一份附件，多处共享同一个 cid', () => {
    const html = `<div>${img(PNG_A)}${img(PNG_A)}</div>`;
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(1);
    const cid = result.images[0]!.cid;
    expect(result.html.match(new RegExp(`cid:${cid}`, 'g'))).toHaveLength(2);
  });

  it('不同图片各自一个 cid，文件名互不相同', () => {
    const result = extractInlineImages(img(PNG_A) + img(PNG_B));

    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.cid).not.toBe(result.images[1]!.cid);
    expect(result.images[0]!.filename).not.toBe(result.images[1]!.filename);
  });

  it('jpg 的 MIME 归一为 image/jpeg，扩展名是 .jpg', () => {
    const result = extractInlineImages(img(makeDataImage('J', 'image/jpg')));

    expect(result.images[0]!.contentType).toBe('image/jpeg');
    expect(result.images[0]!.filename.endsWith('.jpg')).toBe(true);
  });

  it('远程图片与非图片的 data URI 一律不动', () => {
    const remote = img('https://example.com/a.png');
    const textUri = img('data:text/html;base64,PHBoPg==');

    expect(extractInlineImages(remote).images).toHaveLength(0);
    expect(extractInlineImages(remote).html).toBe(remote);
    expect(extractInlineImages(textUri).images).toHaveLength(0);
  });

  it('单引号写法也能识别', () => {
    const result = extractInlineImages(img(PNG_A, "'"));

    expect(result.images).toHaveLength(1);
    expect(result.html).toContain(`cid:${result.images[0]!.cid}`);
  });

  it('data-src 之类的属性不被误伤', () => {
    const html = `<img data-src="${PNG_A}" src="https://example.com/a.png">`;
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(0);
    expect(result.html).toBe(html);
  });

  it('单张超过上限时原样保留，并计入 oversized', () => {
    const big = makeDataImage('x'.repeat(64), 'image/png');
    const result = extractInlineImages(img(big), 16, MAX_INLINE_TOTAL_BYTES);

    expect(result.images).toHaveLength(0);
    expect(result.oversized).toBe(1);
    expect(result.html).toContain(big);
  });

  it('总量超限时第二张保留原样，第一张照常抽取', () => {
    const one = makeDataImage('y'.repeat(64), 'image/png');
    const two = makeDataImage('z'.repeat(64), 'image/png');
    const html = img(one) + img(two);
    const result = extractInlineImages(html, MAX_INLINE_IMAGE_BYTES, 100);

    expect(result.images).toHaveLength(1);
    expect(result.oversized).toBe(1);
    expect(result.html).toContain(`cid:${result.images[0]!.cid}`);
    expect(result.html).toContain(two);
  });

  it('解不出字节的坏数据原样保留，不产出空附件', () => {
    // 只有填充符：形态上仍是合法 data URI（会被识别），但解码出来是 0 字节
    const broken = 'data:image/png;base64,====';
    const result = extractInlineImages(img(broken));

    expect(result.images).toHaveLength(0);
    expect(result.html).toContain(broken);
  });

  it('没有图片的 HTML 原样返回', () => {
    const html = '<p>纯文本邮件</p>';
    expect(extractInlineImages(html).html).toBe(html);
    expect(extractInlineImages(html).images).toHaveLength(0);
  });
});

describe('落盘失败的兜底', () => {
  it('没落盘的 cid 还原成原来的 data URI', () => {
    const result = extractInlineImages(img(PNG_A) + img(PNG_B));
    const restored = restoreUnstagedInlineImages(
      result.html,
      result.images,
      new Set([result.images[0]!.cid]),
    );

    expect(restored).toContain(`cid:${result.images[0]!.cid}`);
    expect(restored).toContain(PNG_B);
    expect(restored).not.toContain(`cid:${result.images[1]!.cid}`);
  });

  it('全部落盘时正文一个 data URI 都不留', () => {
    const result = extractInlineImages(img(PNG_A) + img(PNG_B));
    const restored = restoreUnstagedInlineImages(
      result.html,
      result.images,
      new Set(result.images.map((item) => item.cid)),
    );

    expect(restored).not.toContain('data:image/');
  });
});

describe('内嵌图片落盘', () => {
  let root = '';
  let store: ComposeAttachmentStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-inline-'));
    store = new ComposeAttachmentStore(path.join(root, 'stage'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('写成真实文件，内容、cid、MIME 都能对上', async () => {
    const result = extractInlineImages(img(PNG_A) + img(PNG_B));
    const staged = await store.stageInlineImages(result.images);

    expect(staged).toHaveLength(2);
    for (const item of staged) {
      expect(fs.existsSync(item.path)).toBe(true);
      expect(path.resolve(item.path).startsWith(path.resolve(root, 'stage'))).toBe(true);
    }
    const first = result.images[0]!;
    const stagedFirst = staged.find((item) => item.cid === first.cid)!;
    expect(fs.readFileSync(stagedFirst.path).toString('utf8')).toBe('AAAA-png-bytes');
    expect(stagedFirst.contentType).toBe('image/png');
  });
});

describe('发送时的附件映射', () => {
  function makeAccount(): Account {
    return {
      id: 'acc-1',
      displayName: 'Demo',
      email: 'demo@example.com',
      protocol: 'imap-smtp',
      imap: { host: 'imap.example.com', port: 993, secure: true },
      smtp: { host: 'smtp.example.com', port: 465, secure: true },
      auth: { type: 'password', secretRef: 'acc-1:password' },
      authState: 'ok',
      createdAt: Date.now(),
      enabled: true,
      order: 0,
      settings: {},
    } as unknown as Account;
  }

  const secrets = { get: vi.fn().mockResolvedValue('pw') } as unknown as SecretStore;

  beforeEach(() => {
    sendMail.mockClear();
  });

  it('带 cid 的附件走 inline + Content-ID，普通附件不带 cid', async () => {
    const sender = new SmtpSender(secrets);
    await sender.send(makeAccount(), {
      to: ['a@example.com'],
      subject: 's',
      text: 't',
      html: '<p><img src="cid:abc@mailforge.inline"></p>',
      attachments: [
        { filename: 'report.pdf', path: '/tmp/report.pdf' },
        { filename: 'inline-1.png', path: '/tmp/inline-1.png', cid: 'abc@mailforge.inline', contentType: 'image/png' },
      ],
    });

    const arg = sendMail.mock.calls[0]![0];
    expect(arg.attachments[0]).toEqual({ filename: 'report.pdf', path: '/tmp/report.pdf' });
    expect(arg.attachments[1]).toMatchObject({
      filename: 'inline-1.png',
      cid: 'abc@mailforge.inline',
      contentType: 'image/png',
      contentDisposition: 'inline',
    });
  });
});
