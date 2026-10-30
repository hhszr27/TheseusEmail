import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../src/main/attachments/store';
import {
  embeddedImageSizes,
  isInlineAttachment,
  referencedCids,
} from '../src/main/mail/inline-parts';
import { createTestDb, insertAccount, insertEmail, type TestDb } from './helpers/test-db';

/**
 * 附件落库与「哪些该出现在附件条里」。
 * 重点守住两处曾经的错：content_id 被自身 sha256 污染、以及内嵌图被当普通附件列出来。
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');

let open: TestDb | null = null;

function makeStore(): AttachmentStore {
  const testDb = createTestDb();
  open = testDb;
  insertAccount(testDb.db, 'acc-1');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailforge-att-'));
  return new AttachmentStore(testDb.db, root);
}

afterEach(() => {
  open?.cleanup();
  open = null;
});

describe('AttachmentStore.save：Content-ID 落库', () => {
  it('带 Content-ID 的 part 写到 content_id 列，而不是被哈希污染', () => {
    const store = makeStore();
    insertEmail(open!.db, { id: 'mail-1', accountId: 'acc-1', uid: 1, hasAttachments: 1 });
    store.save('mail-1', [
      {
        filename: 'logo.png',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        content: new Uint8Array(PNG_BYTES),
        contentId: '<logo@corp.example>',
      },
    ]);

    const row = open!.db
      .prepare('SELECT content_id, sha256, local_path FROM attachments WHERE email_id = ?')
      .get('mail-1') as { content_id: string | null; sha256: string; local_path: string };

    expect(row.content_id).toBe('logo@corp.example');
    // 曾经的缺陷：content_id 被写成了第二遍 sha256
    expect(row.content_id).not.toBe(row.sha256);
    expect(fs.readFileSync(row.local_path).equals(PNG_BYTES)).toBe(true);
  });

  it('没有 Content-ID 的普通附件，content_id 必须是空的', () => {
    const store = makeStore();
    insertEmail(open!.db, { id: 'mail-2', accountId: 'acc-1', uid: 2, hasAttachments: 1 });
    store.save('mail-2', [
      {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 10,
        content: new Uint8Array([1, 2, 3]),
      },
    ]);
    const row = open!.db
      .prepare('SELECT content_id FROM attachments WHERE email_id = ?')
      .get('mail-2') as { content_id: string | null };
    expect(row.content_id).toBeNull();
  });
});

describe('AttachmentStore.inlineParts', () => {
  it('只交出「带 Content-ID 且是光栅图」的那些 part，并带上真实字节', () => {
    const store = makeStore();
    insertEmail(open!.db, { id: 'mail-3', accountId: 'acc-1', uid: 3, hasAttachments: 1 });
    store.save('mail-3', [
      {
        filename: 'logo.png',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        content: new Uint8Array(PNG_BYTES),
        contentId: 'logo@x',
      },
      {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 3,
        content: new Uint8Array([1, 2, 3]),
        contentId: 'doc@x',
      },
      {
        filename: 'plain.txt',
        mimeType: 'text/plain',
        size: 3,
        content: new Uint8Array([1, 2, 3]),
      },
    ]);

    const parts = store.inlineParts('mail-3');
    expect(parts.map((item) => item.cid)).toEqual(['logo@x']);
    expect(Buffer.from(parts[0]!.content).toString('base64')).toBe(PNG_BASE64);
  });
});

describe('isInlineAttachment：签名图/正文图 vs 真实图片附件', () => {
  const referenced = new Set(referencedCids('<p><img src="cid:logo@x"></p>'));

  it('disposition=inline 的图片（即使没有 Content-ID）算正文图', () => {
    expect(
      isInlineAttachment({ mimeType: 'image/png', contentDisposition: 'inline' }, referenced),
    ).toBe(true);
  });

  it('disposition=attachment 但被正文 cid 引用，仍算正文图（有的客户端会这么写签名图）', () => {
    expect(
      isInlineAttachment(
        {
          mimeType: 'image/jpeg',
          contentDisposition: 'attachment',
          contentId: '<logo@x>',
        },
        referenced,
      ),
    ).toBe(true);
  });

  it('普通图片附件（attachment、无 cid）保持为附件', () => {
    expect(
      isInlineAttachment({ mimeType: 'image/jpeg', contentDisposition: 'attachment' }, referenced),
    ).toBe(false);
  });

  it('带 cid 但正文没引用，保持为附件（可能是用户真的附了一张图）', () => {
    expect(isInlineAttachment({ mimeType: 'image/png', contentId: 'other@x' }, referenced)).toBe(
      false,
    );
  });

  it('内联的 PDF/文本不算正文图，保留附件入口', () => {
    expect(
      isInlineAttachment({ mimeType: 'application/pdf', contentDisposition: 'inline' }, referenced),
    ).toBe(false);
  });

  it('SVG 签名图也算正文图', () => {
    expect(
      isInlineAttachment(
        { mimeType: 'image/svg+xml', contentDisposition: 'inline' },
        referenced,
      ),
    ).toBe(true);
  });

  it('正文已内嵌同尺寸 data URI → 即使 disposition=attachment、没有 cid，也算正文图', () => {
    const embedded = embeddedImageSizes(`<img src="data:image/png;base64,${PNG_BASE64}">`);
    expect(
      isInlineAttachment(
        {
          mimeType: 'image/png',
          contentDisposition: 'attachment',
          size: PNG_BYTES.byteLength,
        },
        referenced,
        embedded,
      ),
    ).toBe(true);
  });

  it('非图片 part 不会因为尺寸凑巧相同被误判', () => {
    const embedded = embeddedImageSizes(`<img src="data:image/png;base64,${PNG_BASE64}">`);
    expect(
      isInlineAttachment(
        { mimeType: 'application/pdf', size: PNG_BYTES.byteLength },
        referenced,
        embedded,
      ),
    ).toBe(false);
  });
});

describe('embeddedImageSizes：正文 data URI 图片的字节数', () => {
  it('按 base64 长度还原解码后字节数（含 padding）', () => {
    const sizes = embeddedImageSizes(`<img src="data:image/png;base64,${PNG_BASE64}">`);
    expect([...sizes]).toEqual([PNG_BYTES.byteLength]);
  });

  it('没有 data URI 时为空集', () => {
    expect(embeddedImageSizes('<img src="cid:logo@x">').size).toBe(0);
  });
});

describe('AttachmentStore：解析时标记的内嵌图永不进附件条', () => {
  it('inline=true 的图片即使正文还没缓存也不显示；真实附件照常显示', () => {
    const store = makeStore();
    insertEmail(open!.db, { id: 'mail-6', accountId: 'acc-1', uid: 6, hasAttachments: 1 });
    store.save('mail-6', [
      {
        filename: 'logo.png',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        content: new Uint8Array(PNG_BYTES),
        contentId: 'logo@x',
        inline: true,
      },
      {
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: 4,
        content: new Uint8Array([9, 9, 9, 9]),
      },
      {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 3,
        content: new Uint8Array([1, 2, 3]),
      },
    ]);

    // 关键：正文尚未缓存（null）时也不能把签名图当成附件——这正是用户遇到的时序
    expect(store.listVisible('mail-6', null).map((item) => item.filename)).toEqual([
      'photo.jpg',
      'report.pdf',
    ]);
    expect(store.list('mail-6').map((item) => item.filename)).toEqual(['photo.jpg', 'report.pdf']);

    // 正文到了也不会把真实附件误伤
    expect(
      store.listVisible('mail-6', '<img src="cid:logo@x">').map((item) => item.filename),
    ).toEqual(['photo.jpg', 'report.pdf']);

    // 内嵌图仍必须能被 inlineParts 取到，否则正文里的 cid 会还原成空图
    expect(store.inlineParts('mail-6').map((part) => part.cid)).toEqual(['logo@x']);
  });
});

describe('AttachmentStore.listVisible：正文 data URI 已内嵌的重复图片', () => {
  it('旧数据（inline=0、无 cid）里同尺寸的图片 part 不再显示；无内嵌图时照常显示', () => {
    const store = makeStore();
    insertEmail(open!.db, { id: 'mail-7', accountId: 'acc-1', uid: 7, hasAttachments: 1 });
    store.save('mail-7', [
      {
        filename: 'image001.png',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        content: new Uint8Array(PNG_BYTES),
      },
      {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 3,
        content: new Uint8Array([1, 2, 3]),
      },
    ]);

    const html = `<p><img src="data:image/png;base64,${PNG_BASE64}"></p>`;
    expect(store.listVisible('mail-7', html).map((item) => item.filename)).toEqual(['report.pdf']);
    // 没有内嵌图时不能凭尺寸猜：两份都留着
    expect(store.listVisible('mail-7', '<p>no image</p>').map((item) => item.filename)).toEqual([
      'image001.png',
      'report.pdf',
    ]);
  });
});

describe('AttachmentStore.listVisible：内嵌图不该重复出现在附件条', () => {
  it('被正文 cid 引用且已内联的 part 会被藏起来，其余照常显示', () => {
    const store = makeStore();
    insertEmail(open!.db, { id: 'mail-4', accountId: 'acc-1', uid: 4, hasAttachments: 1 });
    store.save('mail-4', [
      {
        filename: 'logo.png',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        content: new Uint8Array(PNG_BYTES),
        contentId: 'logo@x',
      },
      {
        filename: '签名档不重要.png',
        mimeType: 'image/png',
        size: PNG_BYTES.byteLength,
        content: new Uint8Array(PNG_BYTES),
        contentId: 'unused@x',
      },
      {
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        size: 3,
        content: new Uint8Array([1, 2, 3]),
      },
    ]);

    const html = '<img src="cid:logo@x">';
    const visible = store.listVisible('mail-4', html).map((item) => item.filename);
    expect(visible).not.toContain('logo.png');
    // 没被引用的、不能被内联显示的都要留着
    expect(visible).toContain('签名档不重要.png');
    expect(visible).toContain('report.pdf');

    // 没有正文时不隐藏任何东西
    expect(store.listVisible('mail-4', null).map((item) => item.filename)).toContain('logo.png');
  });

  it('引用的 cid 存在但那一 part 不是光栅图时不隐藏（用户还得能下载它）', () => {
    const store = makeStore();
    insertEmail(open!.db, { id: 'mail-5', accountId: 'acc-1', uid: 5, hasAttachments: 1 });
    store.save('mail-5', [
      {
        filename: 'chart.svg',
        mimeType: 'image/svg+xml',
        size: 3,
        content: new Uint8Array([1, 2, 3]),
        contentId: 'chart@x',
      },
    ]);
    const visible = store.listVisible('mail-5', '<img src="cid:chart@x">');
    expect(visible.map((item) => item.filename)).toEqual(['chart.svg']);
  });
});
