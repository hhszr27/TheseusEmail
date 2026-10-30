/**
 * 开发辅助：写入与产品原型一致的演示数据。
 * 4 个账户（3 启用 / 1 禁用）、7 封邮件（2 封置顶 / 5 封普通）。
 *
 * 运行（应用需先启动过一次，确保迁移已执行）：
 *   ./node_modules/electron/dist/electron.exe scripts/seed-demo.js
 *
 * 注意：本脚本 INSERT OR REPLACE 会级联清空这些邮件的附件，
 * 因此附件样本必须在它之后运行 scripts/seed-attachments.js。
 */
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3-multiple-ciphers');

app.setName('MailForge');
if (process.platform === 'win32') app.setAppUserModelId('com.mailforge.desktop');
app.disableHardwareAcceleration();

const userData = path.join(app.getPath('appData'), 'MailForge');
app.setPath('userData', userData);

const FOLDER = 'INBOX';

const ACCOUNTS = [
  {
    id: 'acc-qq',
    name: 'QQ 邮箱',
    email: 'qq@example.com',
    preset: 'qq',
    imap: ['imap.qq.com', 993],
    smtp: ['smtp.qq.com', 465],
    color: '#10b981',
    enabled: 1,
    order: 0,
  },
  {
    id: 'acc-gmail',
    name: 'Gmail',
    email: 'gmail@example.com',
    preset: 'gmail',
    imap: ['imap.gmail.com', 993],
    smtp: ['smtp.gmail.com', 465],
    color: '#dc2626',
    enabled: 1,
    order: 1,
  },
  {
    id: 'acc-netease',
    name: '网易 163',
    email: 'netease@example.com',
    preset: 'netease',
    imap: ['imap.163.com', 993],
    smtp: ['smtp.163.com', 465],
    color: '#f59e0b',
    enabled: 1,
    order: 2,
  },
  {
    id: 'acc-work',
    name: '公司 Exchange',
    email: 'work@example.com',
    preset: 'outlook',
    imap: ['outlook.office365.com', 993],
    smtp: ['smtp.office365.com', 587],
    color: '#7c3aed',
    enabled: 0,
    order: 3,
  },
];

const bodyOf = (paragraphs) => `<!DOCTYPE html>
<html><body style="font-family: system-ui, sans-serif; color: #1a1a1a; font-size: 14px; line-height: 1.7;">
${paragraphs}
</body></html>`;

const CONTRACT_HTML = bodyOf(`
  <p>你好，</p>
  <p>附件是修改后的 Q4 合同最终版。相比上一版，主要变化在第 3 条付款条款——账期从 60 天调整为 45 天，预付比例从 30% 提高到 40%。</p>
  <p><strong>关键变更点：</strong></p>
  <ul>
    <li>第 3.1 条：预付比例 30% → 40%</li>
    <li>第 3.2 条：账期 60 天 → 45 天</li>
    <li>第 7 条：增加数据安全条款（见附录 B）</li>
  </ul>
  <p>请在今天下班前确认，法务那边需要提前走审批流程。</p>
  <img src="https://tracker.example/pixel.png" alt="远程图片" />
  <p>谢谢，<br />张</p>
`);

const SECURITY_HTML = bodyOf(`
  <h2>安全渲染验收样本</h2>
  <p>如果你能看到这段文字，说明主进程净化与无脚本沙箱 iframe 都在正常工作。</p>
  <p>下面这些内容应当被移除或阻断：</p>
  <ul>
    <li>&lt;script&gt;alert(1)&lt;/script&gt; 中的脚本</li>
    <li>&lt;img onerror=...&gt; 事件属性</li>
    <li>&lt;iframe&gt; 内嵌页面</li>
    <li>javascript: 链接</li>
  </ul>
  <p><a href="https://example.com/path?q=1">一个正常的 https 链接</a></p>
  <p><a href="javascript:alert('js-link')">一个 javascript: 链接</a></p>
  <blockquote>引用段落：正文样式应保持可读。</blockquote>
  <table><tr><th>列 A</th><th>列 B</th></tr><tr><td>1</td><td>2</td></tr></table>
  <script>alert('XSS-SCRIPT')</script>
  <iframe src="https://evil.example/frame"></iframe>
  <img src="x" onerror="alert('XSS-ONERROR')">
`);

const SIMPLE_HTML = (title, text) => bodyOf(`<h3>${title}</h3><p>${text}</p>`);

const EMAILS = [
  {
    accountId: 'acc-qq',
    uid: 1,
    subject: 'Q4 合同最终版 — 请审阅',
    from: { name: '张总', address: 'zhang@company.cn' },
    to: 'qq@example.com',
    minutesAgo: 6,
    snippet: '附件是修改后的合同，重点看第 3 条付款条款…',
    unread: 1,
    pinned: 1,
    hasAttachments: 1,
    html: CONTRACT_HTML,
    text: 'Q4 合同最终版，请审阅第 3 条付款条款。',
  },
  {
    accountId: 'acc-gmail',
    uid: 1,
    subject: '你本周的行业动态',
    from: { name: 'LinkedIn 团队', address: 'updates@linkedin.com' },
    to: 'gmail@example.com',
    minutesAgo: 26 * 60,
    snippet: '3 篇你关注的话题更新…',
    unread: 0,
    pinned: 1,
    hasAttachments: 0,
    html: SIMPLE_HTML('你本周的行业动态', '3 篇你关注的话题更新，包含产品设计与桌面应用架构。'),
    text: '3 篇你关注的话题更新。',
  },
  {
    accountId: 'acc-qq',
    uid: 2,
    subject: '新版设计稿反馈汇总',
    from: { name: '设计团队 · 李工', address: 'li@company.cn' },
    to: 'qq@example.com',
    minutesAgo: 42,
    snippet: '根据昨天的评审会，整理了 8 条修改意见…',
    unread: 1,
    pinned: 0,
    hasAttachments: 1,
    html: SECURITY_HTML,
    text: '根据昨天的评审会，整理了 8 条修改意见。',
  },
  {
    accountId: 'acc-gmail',
    uid: 2,
    subject: '本月账单已生成',
    from: { name: 'AWS 通知', address: 'no-reply@aws.amazon.com' },
    to: 'gmail@example.com',
    minutesAgo: 55,
    snippet: '你的 10 月账单为 $284.50，点击查看明细…',
    unread: 0,
    pinned: 0,
    hasAttachments: 0,
    html: SIMPLE_HTML('本月账单已生成', '你的 10 月账单为 $284.50，可在控制台查看明细。'),
    text: '本月账单为 $284.50。',
  },
  {
    accountId: 'acc-netease',
    uid: 1,
    subject: '10 月报销审批已通过',
    from: { name: '财务 · 王会计', address: 'wang@company.cn' },
    to: 'netease@example.com',
    minutesAgo: 2 * 60,
    snippet: '你提交的差旅报销已审批，预计 3 个工作日内到账…',
    unread: 1,
    pinned: 0,
    hasAttachments: 0,
    html: SIMPLE_HTML('10 月报销审批已通过', '你提交的差旅报销已审批，预计 3 个工作日内到账。'),
    text: '差旅报销已审批。',
  },
  {
    accountId: 'acc-gmail',
    uid: 3,
    subject: '[mailforge/core] PR #142 已合并',
    from: { name: 'GitHub', address: 'notifications@github.com' },
    to: 'gmail@example.com',
    minutesAgo: 3 * 60,
    snippet: 'feat: 增加账户级插件启用支持…',
    unread: 0,
    pinned: 0,
    hasAttachments: 0,
    html: SIMPLE_HTML('PR #142 已合并', 'feat: 增加账户级插件启用支持。'),
    text: 'PR #142 已合并。',
  },
  {
    accountId: 'acc-netease',
    uid: 2,
    subject: '你的订单已发货',
    from: { name: '京东', address: 'order@jd.com' },
    to: 'netease@example.com',
    minutesAgo: 30 * 60,
    snippet: '订单号 301 已从北京仓发出…',
    unread: 0,
    pinned: 0,
    hasAttachments: 0,
    html: SIMPLE_HTML('你的订单已发货', '订单号 301 已从北京仓发出，预计明天送达。'),
    text: '订单号 301 已从北京仓发出。',
  },
];

function emailId(accountId, uid) {
  return `${accountId}|${FOLDER}|${uid}`;
}

app.whenReady().then(() => {
  const keyPayload = JSON.parse(fs.readFileSync(path.join(userData, 'db-key.json'), 'utf8'));
  const keyHex =
    keyPayload.protection === 'safeStorage'
      ? safeStorage.decryptString(Buffer.from(keyPayload.data, 'base64'))
      : Buffer.from(keyPayload.data, 'base64').toString('hex');

  const db = new Database(path.join(userData, 'mailforge.db'));
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma('foreign_keys = ON');

  const now = Date.now();

  // 旧版单账户演示数据已被新版四账户取代，避免侧栏出现多余条目
  db.prepare('DELETE FROM accounts WHERE id = ?').run('demo-account');

  const insertAccount = db.prepare(
    `INSERT OR REPLACE INTO accounts
       (id, display_name, email, protocol, provider_preset, imap_host, imap_port, imap_secure,
        smtp_host, smtp_port, smtp_secure, auth_type, secret_ref, auth_state, created_at,
        enabled, sort_order, color, last_sync_at, settings_json)
     VALUES (?, ?, ?, 'imap-smtp', ?, ?, ?, 1, ?, ?, 1, 'password', ?, 'ok', ?, ?, ?, ?, ?, ?)`,
  );

  for (const account of ACCOUNTS) {
    insertAccount.run(
      account.id,
      account.name,
      account.email,
      account.preset,
      account.imap[0],
      account.imap[1],
      account.smtp[0],
      account.smtp[1],
      `${account.id}:password`,
      now,
      account.enabled,
      account.order,
      account.color,
      account.enabled ? now - 3 * 60 * 1000 : null,
      JSON.stringify({ demoMode: true }),
    );
  }

  const insertFolder = db.prepare(
    `INSERT OR REPLACE INTO folder_sync_state
       (account_id, folder, delimiter, uidvalidity, capability_level, last_sync_at)
     VALUES (?, ?, '/', 1, 'L1_CHANGEDSINCE', ?)`,
  );
  for (const account of ACCOUNTS) insertFolder.run(account.id, FOLDER, now);

  const insertEmail = db.prepare(
    `INSERT OR REPLACE INTO emails
       (id, account_id, folder, uid, uidvalidity, message_id, subject, from_json, to_json,
        date, snippet, has_attachments, unread, starred, pinned, body_fetched)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)`,
  );
  const insertBody = db.prepare(
    `INSERT OR REPLACE INTO email_bodies (email_id, html, text, fetched_at) VALUES (?, ?, ?, ?)`,
  );

  for (const email of EMAILS) {
    const id = emailId(email.accountId, email.uid);
    insertEmail.run(
      id,
      email.accountId,
      FOLDER,
      email.uid,
      `<${email.uid}.${email.accountId}@demo.mailforge>`,
      email.subject,
      JSON.stringify([email.from]),
      JSON.stringify([{ address: email.to }]),
      now - email.minutesAgo * 60 * 1000,
      email.snippet,
      email.hasAttachments,
      email.unread,
      email.pinned,
    );
    insertBody.run(id, email.html, email.text, now);
  }

  // 清掉旧演示账户遗留的邮件，避免与新版数据混在一起
  db.prepare('DELETE FROM emails WHERE account_id = ?').run('demo-account');

  const count = db.prepare('SELECT COUNT(*) AS c FROM emails').get();
  const accounts = db.prepare('SELECT COUNT(*) AS c FROM accounts').get();
  console.log('seeded accounts:', accounts.c, 'emails:', count.c);
  db.close();

  app.quit();
});
