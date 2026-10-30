import { parentPort } from 'node:worker_threads';
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, ListResponse, MailboxObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { EmailAddress, SyncCapabilityLevel } from '../../../shared/types';
import {
  isAuthFailure,
  isTransientFailure,
  nextLevel,
  shouldDowngrade,
  type ImapFailureLike,
} from './capability-ladder';
import { discoverFolders, sortFolders, type SpecialUseCapability } from './folder-discovery';
import { imapFailureText, isFolderUnselectable } from './imap-error';
import { disposeImapClient } from './resource-cleanup';
import { embeddedImageSizes, isInlineAttachment, referencedCids } from '../inline-parts';
import type {
  FolderDTO,
  ImapAccountConfig,
  RawEmailSummary,
  WorkerCommand,
  WorkerResponse,
} from './protocol';

/**
 * 账户同步 worker（§7.6）。
 * 每个账户一个独立 worker 线程；主进程只负责持久化，不直接持有 IMAP socket。
 */

if (!parentPort) {
  throw new Error('account-worker must be started as a worker thread');
}
const port = parentPort;

let client: ImapFlow | null = null;
let accountConfig: ImapAccountConfig | null = null;

function post(response: WorkerResponse): void {
  port.postMessage(response);
}

function postError(id: number, error: unknown): void {
  const failure = error as ImapFailureLike & { code?: string };
  const transient = isTransientFailure(failure);
  post({
    id,
    type: 'error',
    code: failure.code ?? 'unknown',
    // imapflow 只给「Command failed」，这里补上服务器原文与状态码
    message: imapFailureText(error),
    transient,
    authFailed: isAuthFailure(failure),
    fatal: !transient,
  });
}

function mapAddresses(list: unknown): EmailAddress[] {
  if (!Array.isArray(list)) return [];
  const result: EmailAddress[] = [];
  for (const item of list) {
    const record = item as { name?: string; address?: string };
    const address = record.address?.trim();
    if (!address) continue;
    result.push({
      ...(record.name ? { name: record.name } : {}),
      address,
    });
  }
  return result;
}

function structureHasAttachment(node: unknown, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 12) return false;
  const record = node as {
    disposition?: string;
    dispositionParameters?: Record<string, string>;
    parameters?: Record<string, string>;
    childNodes?: unknown[];
    /** Content-ID：有它说明是正文内嵌图（签名 Logo 等），不该算成附件。 */
    id?: string;
  };
  const disposition = (record.disposition ?? '').toLowerCase();
  const contentId = typeof record.id === 'string' ? record.id.trim() : '';
  const filename =
    record.dispositionParameters?.filename ?? record.parameters?.name ?? record.parameters?.filename;

  // 明确声明为附件、且没有 Content-ID → 真实附件。
  // 有 Content-ID 的即使被某些客户端错写成 attachment，也是正文里引用的内嵌图。
  if (disposition === 'attachment' && !contentId) return true;
  // 没写 disposition 的普通附件：有文件名、没有 Content-ID、也不是 inline。
  if (filename && !contentId && disposition !== 'inline') return true;

  if (Array.isArray(record.childNodes)) {
    return record.childNodes.some((child) => structureHasAttachment(child, depth + 1));
  }
  return false;
}

function toSummary(message: FetchMessageObject): RawEmailSummary {
  const envelope = message.envelope ?? {};
  const rawDate = envelope.date;
  const dateMs = rawDate ? new Date(rawDate).getTime() : Date.now();
  const flags = message.flags ?? new Set<string>();
  const subject = envelope.subject ?? '(无主题)';

  return {
    uid: message.uid,
    messageId: envelope.messageId ?? null,
    subject,
    from: mapAddresses(envelope.from),
    to: mapAddresses(envelope.to),
    dateMs: Number.isFinite(dateMs) ? dateMs : Date.now(),
    snippet: subject.slice(0, 180),
    hasAttachments: structureHasAttachment(message.bodyStructure),
    unread: !flags.has('\\Seen'),
    starred: flags.has('\\Flagged'),
  };
}

function detectSpecialUseCapability(flow: ImapFlow): SpecialUseCapability {
  if (flow.capabilities.has('SPECIAL-USE')) return 'special-use';
  if (flow.capabilities.has('XLIST')) return 'xlist';
  return 'none';
}

function recentRange(uidNext: number, limit: number): string {
  const start = Math.max(1, uidNext - limit);
  return `${start}:*`;
}

async function connect(config: ImapAccountConfig): Promise<void> {
  accountConfig = config;
  client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    // MAILFORGE_IMAP_TRACE=1 时把 IMAP 协议日志（命令与响应码，不含正文）打进应用日志
    logger:
      process.env.MAILFORGE_IMAP_TRACE === '1'
        ? {
            debug: (data: unknown) =>
              port.postMessage({
                id: 0,
                type: 'worker-log',
                level: 'info',
                message: `IMAP ${JSON.stringify(data)}`,
              }),
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
          }
        : false,
    clientInfo: { name: 'MailForge', version: '0.1.0', vendor: 'MailForge' },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    greetingTimeout: 20_000,
    socketTimeout: 120_000,
  });

  client.on('error', (error: Error) => {
    port.postMessage({ id: 0, type: 'worker-log', level: 'error', message: error.message });
  });

  // 服务器在 IDLE 期间推来的 EXISTS = 有新邮件；同步命令自己触发的 EXISTS 不算（会造成回环）
  client.on('exists', (data: { path?: string }) => {
    if (!idleActive) return;
    if ((data.path ?? '').toUpperCase() !== 'INBOX') return;
    port.postMessage({
      id: 0,
      type: 'worker-log',
      level: 'info',
      message: 'IDLE 推送：收件箱有新邮件',
    });
    post({ id: 0, type: 'mailbox-changed', folder: 'INBOX' });
  });

  await client.connect();
  idleSupported = client.capabilities.has('IDLE');
  port.postMessage({
    id: 0,
    type: 'worker-log',
    level: 'info',
    message: `IDLE 能力：${idleSupported ? '支持' : '不支持'}`,
  });
}

async function listFolders(id: number): Promise<void> {
  if (!client) throw new Error('IMAP 未连接');
  const mailboxes = (await client.list()) as ListResponse[];
  const capability = detectSpecialUseCapability(client);

  const { folders, warnings } = discoverFolders(
    mailboxes.map((mailbox) => ({
      path: mailbox.path,
      name: mailbox.name,
      delimiter: mailbox.delimiter,
      specialUse: mailbox.specialUse ?? null,
      specialUseSource: mailbox.specialUseSource,
    })),
    { specialUseCapability: capability },
  );

  const namespacePrefix = client.namespace?.prefix;
  const delimiter = client.namespace?.delimiter ?? mailboxes[0]?.delimiter;

  const dtos: FolderDTO[] = sortFolders(folders).map((folder) => ({
    path: folder.path,
    name: folder.name,
    delimiter: folder.delimiter,
    ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
    ...(folder.specialUseSource ? { specialUseSource: folder.specialUseSource } : {}),
  }));

  post({
    id,
    type: 'folders',
    folders: dtos,
    warnings,
    ...(namespacePrefix ? { namespacePrefix } : {}),
    ...(delimiter ? { delimiter } : {}),
  });

  if (capability === 'none') {
    port.postMessage({
      id: 0,
      type: 'worker-log',
      level: 'warn',
      message: '服务器未声明 SPECIAL-USE/XLIST，文件夹语义依赖名称启发式',
    });
  }
}

async function fetchSummaries(
  flow: ImapFlow,
  range: string,
  options: { uid: boolean; changedSince?: bigint | number },
): Promise<RawEmailSummary[]> {
  const summaries: RawEmailSummary[] = [];
  for await (const message of flow.fetch(
    range,
    { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true },
    options,
  )) {
    summaries.push(toSummary(message as FetchMessageObject));
  }
  return summaries;
}

/**
 * 打开文件夹。服务器回 NO（\Noselect 容器目录，或已被删除/改名）时不抛错，
 * 而是回一条 sync-skipped 让主进程跳过——否则整轮刷新会被一个容器目录打断，
 * 界面只显示一句「Command failed」。
 */
async function openFolder(id: number, folder: string): Promise<MailboxObject | null> {
  if (!client) throw new Error('IMAP 未连接');
  try {
    return (await client.mailboxOpen(folder)) as MailboxObject;
  } catch (error) {
    if (!isFolderUnselectable(error)) throw error;
    post({ id, type: 'sync-skipped', folder, reason: imapFailureText(error) });
    return null;
  }
}

async function syncFolder(
  id: number,
  command: Extract<WorkerCommand, { type: 'sync-folder' }>,
): Promise<void> {
  if (!client) throw new Error('IMAP 未连接');

  const mailbox = await openFolder(id, command.folder);
  if (!mailbox) return;

  const rawUidValidity = Number(mailbox.uidValidity);
  // 少数服务器对特殊文件夹不返回 UIDVALIDITY：直接用会写成 NULL，
  // 撞上 emails.uidvalidity 的 NOT NULL 约束，于是「刷新报错」。
  const uidValidity =
    Number.isFinite(rawUidValidity) && rawUidValidity > 0
      ? rawUidValidity
      : (command.uidValidity ?? 0);
  const uidNext = Number(mailbox.uidNext ?? 0);
  const highestModseq = mailbox.highestModseq ? Number(mailbox.highestModseq) : undefined;

  const reset = command.uidValidity > 0 && command.uidValidity !== uidValidity;
  const limit = Math.max(1, command.limit);

  let level: SyncCapabilityLevel = command.capabilityLevel;
  let downgraded: { from: SyncCapabilityLevel; to: SyncCapabilityLevel; reason: string } | undefined;
  let emails: RawEmailSummary[] = [];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (level === 'L1_CHANGEDSINCE') {
        if (!reset && command.highestModseq && command.highestModseq > 0) {
          emails = await fetchSummaries(client, '1:*', {
            uid: true,
            changedSince: BigInt(command.highestModseq),
          });
        } else {
          emails = await fetchSummaries(client, recentRange(uidNext, limit), { uid: true });
        }
      } else if (level === 'L2_SEARCH_SINCE') {
        const sinceMs = command.lastSyncAt > 0 ? command.lastSyncAt - 2 * 86_400_000 : Date.now() - 30 * 86_400_000;
        const found = await client.search({ since: new Date(sinceMs) }, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        const selected = uids.slice(-limit);
        if (selected.length > 0) {
          emails = await fetchSummaries(client, selected.join(','), { uid: true });
        } else {
          emails = [];
        }
      } else {
        const start = reset ? Math.max(1, uidNext - limit) : Math.max(1, (command.highestUid ?? 0) + 1);
        emails = await fetchSummaries(client, `${start}:*`, { uid: true });
      }
      break;
    } catch (error) {
      const verdict = shouldDowngrade(error as ImapFailureLike);
      const down = nextLevel(level);
      if (verdict.downgrade && down) {
        downgraded = { from: level, to: down, reason: verdict.reason };
        level = down;
        continue;
      }
      throw error;
    }
  }

  // 初装/重置时只保留最近 limit 封，避免一次写入过多
  if (emails.length > limit) {
    emails = emails.slice(-limit);
  }

  post({
    id,
    type: 'sync-result',
    folder: command.folder,
    uidValidity,
    ...(highestModseq !== undefined ? { highestModseq } : {}),
    uidNext,
    capabilityLevel: level,
    ...(downgraded ? { downgraded } : {}),
    reset,
    emails,
  });
}

async function fetchBody(id: number, folder: string, uid: number): Promise<void> {
  if (!client) throw new Error('IMAP 未连接');
  const flow = client;
  // 必须持有邮箱锁：worker 的命令处理是并发的（见 port.on('message') 的 void handle），
  // 裸 mailboxOpen 之后若被并发的 sync-folder 切走当前邮箱，
  // 紧接着的 fetchOne 就在另一个邮箱上执行，会把「同 uid 的别的邮件」正文
  // 缓存成这封邮件的正文——而且是持久错缓存，只能靠重建索引/重取纠正。
  const lock = await flow.getMailboxLock(folder);
  let source: Buffer | undefined;
  try {
    const message = (await flow.fetchOne(String(uid), { source: true }, { uid: true })) as
      | FetchMessageObject
      | false;
    if (message && message.source) source = message.source;
  } finally {
    lock.release();
  }
  if (!source) {
    throw new Error(`邮件正文不可用：uid=${uid}`);
  }

  const parsed = await simpleParser(source);
  const parsedHtml = typeof parsed.html === 'string' ? parsed.html : '';
  // 正文用 cid: 引用了哪些图：被引用的一律视为正文内嵌图，不进附件列表。
  const referenced = new Set(referencedCids(parsedHtml));
  // 正文里已用 data URI 内嵌的同尺寸图片：对应 part 只是副本，不进附件列表
  const embedded = embeddedImageSizes(parsedHtml);
  const attachments = (parsed.attachments ?? []).map((attachment) => {
    // Content-ID 必须留住：丢了它，multipart/related 的内嵌图片在接收侧就再也找不回
    // 对应的那个 part，正文里的 `<img src="cid:...">` 只能显示成空图。
    const rawCid = typeof attachment.contentId === 'string' ? attachment.contentId.trim() : '';
    const contentId = rawCid
      ? rawCid.replace(/^<(.*)>$/, '$1').replace(/^cid:/i, '').trim() || undefined
      : undefined;
    const mimeType = attachment.contentType ?? 'application/octet-stream';
    const size = attachment.size ?? attachment.content.byteLength;
    const inline = isInlineAttachment(
      {
        mimeType,
        contentDisposition: attachment.contentDisposition,
        contentId: rawCid,
        size,
      },
      referenced,
      embedded,
    );
    return {
      filename: attachment.filename ?? 'attachment',
      mimeType,
      size,
      content: new Uint8Array(attachment.content),
      ...(contentId ? { contentId } : {}),
      ...(inline ? { inline: true } : {}),
    };
  });

  post({
    id,
    type: 'body',
    folder,
    uid,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    text: parsed.text ?? null,
    attachments,
  });
}

/** 读取/未读、星标等标志写入（§8）。 */
async function applyFlags(
  id: number,
  folder: string,
  uid: number,
  add: string[],
  remove: string[],
): Promise<void> {
  const flow = client;
  if (!flow) throw new Error('IMAP 未连接，无法修改邮件标志');
  const lock = await flow.getMailboxLock(folder);
  try {
    if (add.length > 0) await flow.messageFlagsAdd({ uid }, add, { uid: true });
    if (remove.length > 0) await flow.messageFlagsRemove({ uid }, remove, { uid: true });
  } finally {
    lock.release();
  }
  post({ id, type: 'action-done', action: 'set-flags', uid });
}

/** 归档/移动：服务端不支持 MOVE 时 imapflow 会自动退化为 COPY + STORE \Deleted。 */
async function moveMessage(id: number, folder: string, uid: number, target: string): Promise<void> {
  const flow = client;
  if (!flow) throw new Error('IMAP 未连接，无法移动邮件');
  const lock = await flow.getMailboxLock(folder);
  try {
    await flow.messageMove({ uid }, target, { uid: true });
  } finally {
    lock.release();
  }
  post({ id, type: 'action-done', action: 'move', uid, targetFolder: target });
}

async function deleteMessage(id: number, folder: string, uid: number): Promise<void> {
  const flow = client;
  if (!flow) throw new Error('IMAP 未连接，无法删除邮件');
  const lock = await flow.getMailboxLock(folder);
  try {
    await flow.messageDelete({ uid }, { uid: true });
  } finally {
    lock.release();
  }
  post({ id, type: 'action-done', action: 'delete', uid });
}

/** 把 RFC822 草稿写入服务器 Drafts 文件夹（§草稿同步）。imapflow 要求先打开目标邮箱。 */
async function appendDraft(id: number, folder: string, raw: string, flags?: string[]): Promise<void> {
  const flow = client;
  if (!flow) throw new Error('IMAP 未连接，无法写入草稿');
  // 与 fetchBody 同理：并发命令会切走当前邮箱，append 前必须持有目标邮箱锁
  const lock = await flow.getMailboxLock(folder);
  let uid = -1;
  try {
    const res = await flow.append(folder, raw, flags ?? ['\\Draft', '\\Seen']);
    uid = res === false || res.uid == null ? -1 : Number(res.uid);
  } finally {
    lock.release();
  }
  post({ id, type: 'append-done', uid });
}

/** 删除服务器 Drafts 文件夹里的草稿（复用 deleteMessage 的 IMAP 删除能力）。 */
async function deleteDraft(id: number, folder: string, uid: number): Promise<void> {
  await deleteMessage(id, folder, uid);
}

/**
 * 等 IMAP 真正可用再执行文件夹写操作。
 *
 * 启动瞬间 worker 已经存在、client 也已经创建，但连接还没握完手：
 * 这时直接 mailboxCreate 会抛 `Connection not available`（真实账户上撞到过）。
 * 用户刚启动就点右键，不该看到这种底层报错。
 */
async function waitForUsableClient(timeoutMs = 20_000): Promise<ImapFlow> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client?.usable) return client;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('IMAP 连接尚未就绪，请稍后重试');
}

let idleActive = false;
let idleSupported = false;

/**
 * 进入 IMAP IDLE，停在 INBOX 上等服务器推 NOTIFY。
 *
 * 任何其他命令都会打断 IDLE，所以每次处理完请求都要重新进来（见 handle 的 finally）。
 * IDLE 期间服务器推 EXISTS → 通知主进程立刻增量同步收件箱，这就是「秒收」的来源；
 * 服务器不支持 IDLE 或连接断了就置 idleSupported=false，主进程那边的 60 秒轮询兜底。
 */
function startIdle(): void {
  const flow = client;
  if (!flow || !flow.usable || idleActive || !idleSupported) return;
  idleActive = true;
  void (async () => {
    try {
      const current = flow.mailbox ? flow.mailbox.path.toUpperCase() : '';
      if (current !== 'INBOX') {
        await flow.mailboxOpen('INBOX');
      }
      if (!flow.usable) return;
      port.postMessage({
        id: 0,
        type: 'worker-log',
        level: 'info',
        message: 'IDLE 已进入，等待服务器推送',
      });
      await flow.idle();
    } catch (error) {
      idleSupported = false;
      port.postMessage({
        id: 0,
        type: 'worker-log',
        level: 'warn',
        message: `IDLE 不可用，回落定时轮询：${(error as Error).message}`,
      });
    } finally {
      idleActive = false;
    }
  })();
}

/** 新建文件夹。imapflow 在服务器拒绝时直接抛错；CREATE 的返回值各家服务器不一定给，不能强依赖。 */
async function createFolder(id: number, path: string): Promise<void> {
  const flow = await waitForUsableClient();
  const created = await flow.mailboxCreate(path);
  post({
    id,
    type: 'folder-done',
    path: created?.path || path,
    existed: created?.created === false,
  });
}

/** 服务端改名/移动文件夹。改名成功后再由主进程做本地级联。 */
async function renameFolder(id: number, path: string, newPath: string): Promise<void> {
  const flow = await waitForUsableClient();
  const renamed = await flow.mailboxRename(path, newPath);
  post({ id, type: 'folder-done', path: renamed?.path ?? newPath });
}

/** 服务端删除文件夹。不可撤销，主进程此时已经拿到用户的确认。 */
async function deleteFolder(id: number, path: string): Promise<void> {
  const flow = await waitForUsableClient();
  await flow.mailboxDelete(path);
  post({ id, type: 'folder-done' });
}

/**
 * 清空文件夹（右键「全部删除」）：不传 uids 就是整箱删。
 * 用一条 STORE+EXPUNGE 完成，不做 N 次往返；服务器把邮件移进「已删除」时仍可恢复。
 */
async function clearFolder(id: number, folder: string, uids?: number[]): Promise<void> {
  const flow = await waitForUsableClient();
  const lock = await flow.getMailboxLock(folder);
  let removed = 0;
  try {
    const total = flow.mailbox ? flow.mailbox.exists : 0;
    if (Array.isArray(uids)) {
      if (uids.length > 0) {
        await flow.messageDelete(uids, { uid: true });
        removed = uids.length;
      }
    } else if (total > 0) {
      await flow.messageDelete('1:*', { uid: false });
      removed = total;
    }
  } finally {
    lock.release();
  }
  post({ id, type: 'folder-done', removed });
}

/** 复制文件夹：建目标 + 把源里所有邮件 COPY 过去（子文件夹由调用方拦住）。 */
async function copyFolder(id: number, from: string, to: string): Promise<void> {
  const flow = await waitForUsableClient();
  await flow.mailboxCreate(to);
  const lock = await flow.getMailboxLock(from);
  let copied = 0;
  try {
    const total = flow.mailbox ? flow.mailbox.exists : 0;
    if (total > 0) {
      const result = await flow.messageCopy('1:*', to);
      copied = total;
      if (result === false) throw new Error('服务器未完成复制');
    }
  } finally {
    lock.release();
  }
  post({ id, type: 'folder-done', path: to, copied });
}

/** 整文件夹标为已读：先查未读 uid，再一次性 STORE \Seen（一条命令，不做 N 次往返）。 */
async function markFolderRead(id: number, folder: string): Promise<void> {
  const flow = client;
  if (!flow) throw new Error('IMAP 未连接');
  // search + STORE 两步都要在同一个邮箱上完成：中间被并发命令切箱会标错邮件
  const lock = await flow.getMailboxLock(folder);
  try {
    const found = await flow.search({ seen: false }, { uid: true });
    const uids = Array.isArray(found) ? found : [];
    if (uids.length > 0) {
      await flow.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
  }
  post({ id, type: 'folder-done' });
}

async function close(): Promise<void> {
  const flow = client;
  client = null;
  if (flow) {
    try {
      await flow.logout();
    } catch {
      // 连接可能已断开
    }
    disposeImapClient(flow);
  }
  port.postMessage({ id: 0, type: 'worker-log', level: 'info', message: 'account worker closed' });
}

async function handle(command: WorkerCommand): Promise<void> {
  switch (command.type) {
    case 'connect': {
      await connect(command.config);
      const flow = client as ImapFlow;
      const personal = flow.namespace;
      post({
        id: command.id,
        type: 'connected',
        capabilities: [...flow.capabilities.keys()],
        ...(personal?.prefix ? { namespacePrefix: personal.prefix } : {}),
        ...(personal?.delimiter ? { delimiter: personal.delimiter } : {}),
        specialUseCapability: detectSpecialUseCapability(flow),
      });
      return;
    }
    case 'list-folders':
      await listFolders(command.id);
      return;
    case 'sync-folder':
      await syncFolder(command.id, command);
      return;
    case 'fetch-body':
      await fetchBody(command.id, command.folder, command.uid);
      return;
    case 'set-flags':
      await applyFlags(command.id, command.folder, command.uid, command.add, command.remove);
      return;
    case 'move':
      await moveMessage(command.id, command.folder, command.uid, command.target);
      return;
    case 'delete':
      await deleteMessage(command.id, command.folder, command.uid);
      return;
    case 'append-draft':
      await appendDraft(command.id, command.folder, command.raw, command.flags);
      return;
    case 'delete-draft':
      await deleteDraft(command.id, command.folder, command.uid);
      return;
    case 'create-folder':
      await createFolder(command.id, command.path);
      return;
    case 'rename-folder':
      await renameFolder(command.id, command.path, command.newPath);
      return;
    case 'delete-folder':
      await deleteFolder(command.id, command.path);
      return;
    case 'clear-folder':
      await clearFolder(command.id, command.folder, command.uids);
      return;
    case 'copy-folder':
      await copyFolder(command.id, command.from, command.to);
      return;
    case 'mark-folder-read':
      await markFolderRead(command.id, command.folder);
      return;
    case 'close':
      await close();
      return;
    default: {
      const exhaustive: never = command;
      throw new Error(`未知命令 ${JSON.stringify(exhaustive)}`);
    }
  }
}

port.on('message', (message: WorkerCommand) => {
  void handle(message)
    .catch((error: unknown) => {
      postError(message.id, error);
    })
    .finally(() => {
      // 命令打断了 IDLE（切箱/取信都会），处理完马上回到推送状态
      if (message.type !== 'close') startIdle();
    });
});

process.on('uncaughtException', (error) => {
  port.postMessage({ id: 0, type: 'worker-log', level: 'error', message: `uncaught: ${error.message}` });
});
process.on('unhandledRejection', (reason) => {
  port.postMessage({
    id: 0,
    type: 'worker-log',
    level: 'error',
    message: `unhandledRejection: ${String(reason)}`,
  });
});

void accountConfig;
