import tls from 'node:tls';

/**
 * IMAP METADATA（RFC 5464，§8.8）。
 * imapflow 未暴露自定义命令，这里用独立的短连接完成 GETMETADATA/SETMETADATA。
 * 只在用户显式同步时使用，不参与常规同步循环；不可用时静默降级。
 */

export const NOTIFICATION_ENTRY = '/private/mailforge/notification-prefs';
export const MAX_METADATA_BYTES = 8192;

export function supportsMetadata(capabilities: string[]): boolean {
  return capabilities.some((capability) => capability.toUpperCase() === 'METADATA');
}

/** IMAP quoted string：转义反斜杠与引号；拒绝控制字符。 */
export function quoteImap(value: string): string {
  if (/[\r\n\u0000]/.test(value)) throw new Error('METADATA 值包含非法字符');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildGetMetadataCommand(mailbox: string, entry = NOTIFICATION_ENTRY): string {
  return `GETMETADATA ${quoteImap(mailbox)} (${entry})`;
}

export function buildSetMetadataCommand(
  mailbox: string,
  value: string,
  entry = NOTIFICATION_ENTRY,
): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error('METADATA 值超过大小上限');
  }
  return `SETMETADATA ${quoteImap(mailbox)} (${entry} ${quoteImap(value)})`;
}

/** 从 untagged 响应与字面量中取出条目值。 */
export function parseMetadataValue(lines: string[], literals: Buffer[] = []): string | null {
  if (literals.length > 0) {
    return literals[literals.length - 1]!.toString('utf8');
  }

  for (const line of lines) {
    if (!/^\* METADATA/i.test(line)) continue;
    const quoted = /\((?:\/[^\s)]+)\s+"((?:[^"\\]|\\.)*)"\)/.exec(line);
    if (quoted?.[1] !== undefined) {
      return quoted[1].replace(/\\(.)/g, '$1');
    }
    const literalMatch = /\{(\d+)\}\s*$/.exec(line);
    if (literalMatch) return '';
  }

  return null;
}

interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

class ImapSession {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private tag = 0;

  async connect(config: ImapConfig): Promise<string> {
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const created = tls.connect(
        {
          host: config.host,
          port: config.port,
          servername: config.host,
          rejectUnauthorized: true,
        },
        () => {
          created.off('error', onConnectError);
          resolve(created);
        },
      );
      const onConnectError = (error: Error): void => reject(error);
      created.once('error', onConnectError);
      // 连接建立后的错误由 ensureData 的监听器处理，这里保留一个兜底避免未捕获
      created.on('error', () => undefined);
      created.setTimeout(15_000, () => created.destroy(new Error('IMAP METADATA 连接超时')));
    });

    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    });

    const greeting = await this.readLine();
    if (!/^\* OK/i.test(greeting)) throw new Error('IMAP 服务器未返回 OK 问候');
    return greeting;
  }

  private async ensureData(): Promise<void> {
    if (!this.socket) throw new Error('IMAP 未连接');
    if (this.buffer.length > 0) return;
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;
      const onData = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error('IMAP 连接已关闭'));
      };
      const cleanup = (): void => {
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      socket.once('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  private async readLine(): Promise<string> {
    while (true) {
      const index = this.buffer.indexOf('\r\n');
      if (index >= 0) {
        const line = this.buffer.subarray(0, index).toString('utf8');
        this.buffer = this.buffer.subarray(index + 2);
        return line;
      }
      await this.ensureData();
    }
  }

  private async readExact(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      await this.ensureData();
    }
    const data = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return Buffer.from(data);
  }

  async command(command: string): Promise<{ lines: string[]; literals: Buffer[]; status: string }> {
    if (!this.socket) throw new Error('IMAP 未连接');
    this.tag += 1;
    const tag = `mf${this.tag}`;
    this.socket.write(`${tag} ${command}\r\n`);

    const lines: string[] = [];
    const literals: Buffer[] = [];

    while (true) {
      let line = await this.readLine();
      const literalMatch = /\{(\d+)\}$/.exec(line);
      if (literalMatch) {
        const literal = await this.readExact(Number(literalMatch[1]));
        literals.push(literal);
        line = await this.readLine();
      }

      if (line.startsWith(`${tag} `)) {
        return { lines, literals, status: line.slice(tag.length + 1) };
      }
      lines.push(line);
      if (lines.length > 500) throw new Error('IMAP 响应过长');
    }
  }

  async logout(): Promise<void> {
    if (!this.socket) return;
    try {
      await this.command('LOGOUT');
    } catch {
      // ignore
    }
    this.socket.destroy();
    this.socket = null;
  }
}

async function withSession<T>(config: ImapConfig, task: (session: ImapSession) => Promise<T>): Promise<T> {
  const session = new ImapSession();
  await session.connect(config);
  try {
    const login = await session.command(`LOGIN ${quoteImap(config.user)} ${quoteImap(config.pass)}`);
    if (!/^OK\b/i.test(login.status)) throw new Error('IMAP 登录失败');
    return await task(session);
  } finally {
    await session.logout();
  }
}

export async function readMetadataValue(
  config: ImapConfig,
  mailbox = 'INBOX',
  entry = NOTIFICATION_ENTRY,
): Promise<string | null> {
  return withSession(config, async (session) => {
    const capability = await session.command('CAPABILITY');
    const capabilities = capability.lines
      .filter((line) => line.startsWith('* CAPABILITY'))
      .flatMap((line) => line.replace('* CAPABILITY', '').trim().split(/\s+/));
    if (!supportsMetadata(capabilities)) return null;

    const result = await session.command(buildGetMetadataCommand(mailbox, entry));
    if (!/^OK\b/i.test(result.status)) return null;
    return parseMetadataValue(result.lines, result.literals);
  });
}

export async function writeMetadataValue(
  config: ImapConfig,
  value: string,
  mailbox = 'INBOX',
  entry = NOTIFICATION_ENTRY,
): Promise<boolean> {
  return withSession(config, async (session) => {
    const capability = await session.command('CAPABILITY');
    const capabilities = capability.lines
      .filter((line) => line.startsWith('* CAPABILITY'))
      .flatMap((line) => line.replace('* CAPABILITY', '').trim().split(/\s+/));
    if (!supportsMetadata(capabilities)) return false;

    await session.command('ENABLE METADATA');
    const result = await session.command(buildSetMetadataCommand(mailbox, value, entry));
    return /^OK\b/i.test(result.status);
  });
}
