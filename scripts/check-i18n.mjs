#!/usr/bin/env node
/**
 * i18n 伪本地化检查（§28.3）。
 *
 * 规则：
 *  - 扫描 src 下所有 t('key') 字面量，缺 key 直接失败（构建阻断）
 *  - 生成伪本地化目录 out/i18n/pseudo.json，供视觉回归检查布局溢出
 *  - 目录中出现空值同样视为错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'src', 'shared', 'i18n', 'zh-CN.json');
const OUTPUT = path.join(ROOT, 'out', 'i18n', 'pseudo.json');

const PSEUDO_MAP = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ',
  k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'q', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
};

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function pseudo(text) {
  const mapped = text.replace(/[a-z]/gi, (char) => PSEUDO_MAP[char.toLowerCase()] ?? char);
  return `⟦${mapped}⟧`;
}

function main() {
  if (!fs.existsSync(CATALOG)) {
    console.error(`[i18n] 缺少目录文件：${CATALOG}`);
    process.exit(1);
  }

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  } catch (error) {
    console.error(`[i18n] 目录文件不是合法 JSON：${error.message}`);
    process.exit(1);
  }

  const errors = [];
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`空文案：${key}`);
    }
  }

  const used = new Set();
  for (const file of walk(path.join(ROOT, 'src'))) {
    const source = fs.readFileSync(file, 'utf8');
    const pattern = /\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      used.add(match[1]);
      if (!Object.prototype.hasOwnProperty.call(catalog, match[1])) {
        errors.push(`缺少 key：${match[1]}（${path.relative(ROOT, file)}）`);
      }
    }
  }

  for (const key of Object.keys(catalog)) {
    if (!used.has(key)) {
      console.warn(`[i18n] 未使用的 key：${key}`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`[i18n] ${error}`);
    console.error(`[i18n] 检查失败：${errors.length} 个问题`);
    process.exit(1);
  }

  const pseudoCatalog = {};
  for (const [key, value] of Object.entries(catalog)) {
    pseudoCatalog[key] = pseudo(value);
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(pseudoCatalog, null, 2), 'utf8');

  console.log(
    `[i18n] 通过：${Object.keys(catalog).length} 个 key，${used.size} 个被引用；伪本地化已写入 ${path.relative(ROOT, OUTPUT)}`,
  );
}

main();
