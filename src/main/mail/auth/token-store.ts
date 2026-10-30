import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from '../../observability/logger';
import { writeFileAtomic } from '../../security/atomic-file';

/**
 * 凭证存储（§7.5）：safeStorage 加密后落盘，SQLite 只保存 ref。
 * 凭证绝不进入渲染进程、日志或崩溃报告。
 */

export class SecretStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? path.join(app.getPath('userData'), 'secrets');
  }

  private fileFor(ref: string): string {
    const hash = createHash('sha256').update(ref).digest('hex').slice(0, 32);
    return path.join(this.dir, `${hash}.bin`);
  }

  async set(ref: string, value: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const encrypted = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(value)
      : Buffer.from(value, 'utf8');
    // 原子写：凭证写一半的后果是「登录态莫名丢失」且看不出原因
    await writeFileAtomic(this.fileFor(ref), encrypted);
  }

  async get(ref: string): Promise<string | null> {
    try {
      const buffer = await fs.readFile(this.fileFor(ref));
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buffer);
      }
      return buffer.toString('utf8');
    } catch {
      return null;
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      await fs.unlink(this.fileFor(ref));
    } catch {
      // ignore
    }
  }

  async has(ref: string): Promise<boolean> {
    try {
      await fs.access(this.fileFor(ref));
      return true;
    } catch {
      return false;
    }
  }

  async logPresence(ref: string): Promise<void> {
    log.info('secrets', 'secret presence check', { ref, present: await this.has(ref) });
  }
}
