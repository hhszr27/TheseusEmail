#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
contract.css（视觉契约 · 抬升与动效令牌层）的变异验证。

每个变异体都是「把补上的令牌层再改坏」，对应 contract 测试必须变红；
任何一个变异体没被检出，说明那条断言只是装饰品。

还原策略（与 mutate-reader-document.py 一致，都踩过坑）：
 1. `new` 必须含唯一标记 MUTANT_MARK。绝不用会在文件里出现多次的串做还原锚点。
 2. 只做定点字符串替换与回退——本机工作区存在并发编辑，整文件还原会抹掉别人同时写进去的改动。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ["tests/theme-contract.test.ts", "tests/theme-view.test.tsx"]

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
        "name": "浅色 --mf-shadow-2 被删（抬升层缺失）",
        "file": "src/renderer/theme/contract.css",
        "old": "  --mf-shadow-2: 0 2px 6px rgba(16, 24, 40, 0.08), 0 4px 12px rgba(16, 24, 40, 0.12);",
        "new": "  " + MUTANT_MARK,
    },
    {
        "name": "深色阴影比浅色更弱（违反「深色更实」不变量）",
        "file": "src/renderer/theme/contract.css",
        "old": "  --mf-shadow-2: 0 2px 6px rgba(0, 0, 0, 0.55), 0 4px 12px rgba(0, 0, 0, 0.6);",
        "new": "  --mf-shadow-2: 0 2px 6px rgba(0, 0, 0, 0.01), 0 4px 12px rgba(0, 0, 0, 0.02); " + MUTANT_MARK,
    },
    {
        "name": "--mf-motion 硬编码时长、不再引用 --mf-duration-base",
        "file": "src/renderer/theme/contract.css",
        "old": "  --mf-motion: var(--mf-duration-base) var(--mf-easing-standard);",
        "new": "  --mf-motion: 200ms var(--mf-easing-standard); " + MUTANT_MARK,
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
