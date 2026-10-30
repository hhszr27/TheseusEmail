#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reader-document.ts（阅读区 iframe 文档构建 + color-scheme 推导）的变异验证。

每个变异体都是「把修好的那处再改坏」，对应测试必须变红；
任何一个变异体没被检出，说明那条断言只是装饰品。

还原策略（与 mutate-inline-parts.py 一致，都踩过坑）：
 1. `new` 必须含唯一标记 MUTANT_MARK。绝不用会在文件里出现多次的串做还原锚点。
 2. 不用空串当 `new`（"x".replace("", y, 1) 是插入到文件开头，不是删除）。
 3. 只做定点字符串替换与回退——本机工作区存在并发编辑，整文件还原会抹掉别人同时写进去的改动。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ["tests/reader-document.test.ts"]

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
        "name": "colorSchemeFor 永远返回 light（暗色主题失效）",
        "file": "src/renderer/lib/reader-document.ts",
        "old": "  return luminance < 0.5 ? 'dark' : 'light';",
        "new": "  return 'light'; " + MUTANT_MARK,
    },
    {
        "name": "colorSchemeFor 阈值取反（中灰/纯黑翻成 light）",
        "file": "src/renderer/lib/reader-document.ts",
        "old": "  return luminance < 0.5 ? 'dark' : 'light';",
        "new": "  return luminance >= 0.5 ? 'dark' : 'light'; " + MUTANT_MARK,
    },
    {
        "name": "allowRemoteImages 失效（永远只 data:，远程图被拦）",
        "file": "src/renderer/lib/reader-document.ts",
        "old": "  const imgSrc = options.allowRemoteImages ? 'data: https: http:' : 'data:';",
        "new": "  const imgSrc = 'data:'; " + MUTANT_MARK,
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
            if after != original:
                raise SystemExit(f"源码未完全还原，已停止：{mutant['name']}")

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
