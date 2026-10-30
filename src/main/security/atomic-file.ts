import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 原子写文件：先写同目录临时文件，再 rename 覆盖目标。
 *
 * 为什么必须这样：`fs.writeFile(目标)` 是「先截断、再落盘」。数据库密钥
 * （db-key.json）、凭证这类「丢了就彻底解不开本地数据」的文件，只要在
 * 这期间进程崩溃/断电，目标文件就是空的或半截 JSON——而设计约定是
 * 「密钥不可解密时库未初始化→重建、有数据→报错停止」，用户于是既打不开
 * 库也拿不回数据。rename 在同一文件系统上是原子的，要么旧内容、要么新内容。
 */

/** 同目录临时名：带 pid 与自增计数，避免并发写同一个文件时互相覆盖。 */
let tempCounter = 0;

function tempPathFor(target: string): string {
  tempCounter += 1;
  return `${target}.tmp-${process.pid}-${tempCounter}`;
}

export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = tempPathFor(target);
  try {
    await fs.writeFile(temp, data, { mode });
    // rename 覆盖：同目录同文件系统，原子替换
    await fs.rename(temp, target);
  } catch (error) {
    // 别把半截临时文件留在用户数据目录里
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
