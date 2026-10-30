#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
内嵌图片（cid）修复的变异验证。

每个变异体都是「把修好的那处再改坏」，对应测试必须变红；
任何一个变异体没被检出，说明那条断言只是装饰品。

做法上刻意不采用「整文件备份/还原」：本机工作区存在并发编辑，
整文件还原会把别人同时写进去的改动一起抹掉。这里只做定点字符串替换与回退。
"""
"""
还原策略有两条硬规矩（都踩过坑，别改回去）：
 1. `new` 必须含唯一标记 MUTANT_MARK。原来直接用 `return match;` 这种在文件里出现
    多次的串做还原锚点，str.replace 只替换第一次出现，结果把两个相邻分支的返回值
    调了个——变异脚本本身把源码改坏了，而且 md5 之前完全看不出来。
 2. 不要用空串当 `new`：`"x".replace("", y, 1)` 会把 y 插到文件开头，不是「删掉」。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ["tests/inline-parts.test.ts", "tests/inline-attachments.test.ts"]

MUTANT_MARK = "/* MUTANT */"


def read(path: Path) -> str:
    # 统一按 LF 处理，避免 write_text 把整份文件转成 CRLF 制造无用 diff
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def write(path: Path, text: str) -> None:
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def run_tests() -> bool:
    """返回 True 表示测试通过（对变异体来说就是「没被检出」）。"""
    proc = subprocess.run(
        # Windows 上的 npx 是 .cmd，必须经 shell 解析（直接 CreateProcess 会 FileNotFoundError）
        ["npx", "vitest", "run", "--reporter=dot", *TESTS],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=True,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if "failed" in out or "FAIL" in out or proc.returncode != 0:
        return False
    return "passed" in out


MUTANTS = [
    {
        "name": "解析后不再改写 src（还原形同虚设）",
        "file": "src/main/mail/inline-parts.ts",
        "old": "    return `src=${quote}data:${part.mimeType};base64,${base64}${quote}`;",
        "new": f"    {{ {MUTANT_MARK} return match; }}",
    },
    {
        "name": "cid 匹配去掉 (?<![\\w-]) 前缀（会误伤 data-src）",
        "file": "src/main/mail/inline-parts.ts",
        "old": "  return /(?<![\\w-])src\\s*=\\s*([\"'])(cid:[^\"'\\s]+)\\1/gi;",
        "new": f"  return /src\\s*=\\s*([\"'])(cid:[^\"'\\s]+)\\1/gi; {MUTANT_MARK}",
    },
    {
        "name": "Content-ID 不再剥离尖括号",
        "file": "src/main/mail/inline-parts.ts",
        "old": "  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();",
        "new": MUTANT_MARK,
    },
    {
        "name": "不限 MIME，任何 part 都当内嵌图",
        "file": "src/main/mail/inline-parts.ts",
        "old": "  if (!INLINABLE_IMAGE.test(type)) return false;",
        "new": f"  if (!type) return false; {MUTANT_MARK}",
    },
    {
        "name": "content_id 回退成写 sha256（原缺陷）",
        "file": "src/main/attachments/store.ts",
        "old": "          normalizeContentId(item.contentId),",
        "new": f"          sha256, {MUTANT_MARK}",
    },
    {
        "name": "listVisible 不再隐藏已内联的图",
        "file": "src/main/attachments/store.ts",
        "old": "        return !cid || !referenced.has(cid) || !isInlinablePart(row.mime_type, row.size);",
        "new": f"        return true; {MUTANT_MARK}",
    },
    {
        "name": "inlineParts 不再过滤非光栅图",
        "file": "src/main/attachments/store.ts",
        "old": "      (row) => row.content_id && isInlinablePart(row.mime_type, row.size),",
        "new": f"      (row) => row.content_id, {MUTANT_MARK}",
    },
]


def main() -> int:
    if run_tests() is False:
        print("基线就没过：先用干净源码跑通再谈变异。")
        return 1

    detected = 0
    failures = []
    for mutant in MUTANTS:
        path = ROOT / mutant["file"]
        original = read(path)
        if mutant["old"] not in original:
            print(f"[SKIP] 找不到锚点：{mutant['name']} ({mutant['file']})")
            failures.append(mutant["name"] + " (锚点缺失)")
            continue
        if original.count(mutant["new"]) > 0:
            print(f"[SKIP] 变异体已存在，拒绝重复注入：{mutant['name']}")
            failures.append(mutant["name"] + " (已变异)")
            continue
        try:
            write(path, original.replace(mutant["old"], mutant["new"], 1))
            caught = not run_tests()
            if caught:
                detected += 1
                print(f"[OK]   已检出：{mutant['name']}")
            else:
                print(f"[MISS] 没检出：{mutant['name']}")
                failures.append(mutant["name"] + " (未被检出)")
        finally:
            # 按「变异体原文」精确回退：new 带唯一标记，不可能替换到别的地方
            current = read(path)
            if current.count(mutant["new"]) != 1:
                raise SystemExit(f"还原锚点不唯一，已停止：{mutant['name']}")
            write(path, current.replace(mutant["new"], mutant["old"], 1))
            after = read(path)
            if MUTANT_MARK in after:
                raise SystemExit(f"仍有变异残留，已停止：{mutant['name']}")

    total = len(MUTANTS)
    print(f"\n变异检出 {detected}/{total}")
    if failures:
        print("未通过：")
        for item in failures:
            print(f"  - {item}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
