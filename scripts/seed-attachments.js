/**
 * 开发辅助：为演示邮件写入附件样本（Phase 3 界面验收用）。
 * 运行前请先启动过一次应用（确保 V004 迁移已执行）。
 *
 *   ./node_modules/electron/dist/electron.exe scripts/seed-attachments.js
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Database = require('better-sqlite3-multiple-ciphers');

app.setName('MailForge');
if (process.platform === 'win32') app.setAppUserModelId('com.mailforge.desktop');
app.disableHardwareAcceleration();

const userData = path.join(app.getPath('appData'), 'MailForge');
app.setPath('userData', userData);

const ACCOUNT = 'acc-qq';
const FOLDER = 'INBOX';
const EMAIL_ID = `${ACCOUNT}|${FOLDER}|1`;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 生成一张纯色 PNG，避免依赖外部素材。 */
function makePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = rgb[0];
    row[2 + x * 3] = rgb[1];
    row[3 + x * 3] = rgb[2];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 生成一页最小 PDF（不含任何 JavaScript）。 */
function makePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 76 >>\nstream\nBT /F1 26 Tf 72 700 Td (MailForge PDF Preview) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let index = 1; index <= objects.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function attachmentId(index, sha) {
  const prefix = crypto.createHash('sha256').update(`${EMAIL_ID}\n${index}`).digest('hex').slice(0, 16);
  return `att-${prefix}-${sha.slice(0, 12)}`;
}

app.whenReady().then(() => {
  const keyPayload = JSON.parse(fs.readFileSync(path.join(userData, 'db-key.json'), 'utf8'));
  const keyHex =
    keyPayload.protection === 'safeStorage'
      ? safeStorage.decryptString(Buffer.from(keyPayload.data, 'base64'))
      : keyPayload.protection === 'master'
        ? null
        : Buffer.from(keyPayload.data, 'base64').toString('hex');

  if (!keyHex) {
    console.error('主密码已启用，无法用脚本写入演示附件。请先在应用内关闭主密码。');
    app.quit();
    return;
  }

  const db = new Database(path.join(userData, 'mailforge.db'));
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma('foreign_keys = ON');

  const email = db.prepare('SELECT id FROM emails WHERE id = ?').get(EMAIL_ID);
  if (!email) {
    console.error('找不到演示邮件，请先运行 scripts/seed-demo.js');
    db.close();
    app.quit();
    return;
  }

  // 四个附件对应四种风险等级（§11.3），用于界面验收
  const samples = [
    {
      filename: 'Q4_合同_最终版.pdf',
      mimeType: 'application/pdf',
      content: makePdf(),
    },
    {
      filename: 'Q4_合同_批注版.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: Buffer.from('PK-not-a-real-docx', 'utf8'),
    },
    {
      filename: '合同查看器_安装包.exe',
      mimeType: 'application/octet-stream',
      content: Buffer.from('MZ-not-a-real-executable', 'utf8'),
    },
    {
      filename: '附录B_数据安全条款.zip',
      mimeType: 'application/zip',
      content: Buffer.from('PK-not-a-real-zip', 'utf8'),
    },
  ];

  const root = path.join(userData, 'attachments');
  fs.mkdirSync(root, { recursive: true });

  const insert = db.prepare(
    `INSERT OR REPLACE INTO attachments
       (id, email_id, filename, mime_type, size, ext, sha256, local_path, content_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  samples.forEach((sample, index) => {
    const sha = crypto.createHash('sha256').update(sample.content).digest('hex');
    const ext = path.extname(sample.filename).toLowerCase();
    const filePath = path.join(root, `${sha}${ext}`);
    fs.writeFileSync(filePath, sample.content);
    insert.run(
      attachmentId(index, sha),
      EMAIL_ID,
      sample.filename,
      sample.mimeType,
      sample.content.byteLength,
      ext,
      sha,
      filePath,
      sha,
    );
  });

  db.prepare('UPDATE emails SET has_attachments = 1 WHERE id = ?').run(EMAIL_ID);

  const count = db.prepare('SELECT COUNT(*) AS c FROM attachments WHERE email_id = ?').get(EMAIL_ID);
  console.log('seeded attachments:', count.c);
  db.close();
  app.quit();
});
