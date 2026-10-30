#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
elevation.css（抬升与动效令牌应用层 · §美化）的变异验证。

每个变异体都是「把应用层再改回硬编码」，对应 elevation 测试必须变红；
任何一个变异体没被检出，说明那条断言只是装饰品。

还原策略（与 mutate-theme-contract.py / mutate-reader-document.py 一致，都踩过坑）：
 1. `new` 必须含唯一标记 MUTANT_MARK。绝不用会在文件里出现多次的串做还原锚点。
 2. 只做定点字符串替换与回退——本机工作区存在并发编辑，整文件还原会抹掉别人同时写进去的改动。
 3. 本脚本只动新建的冷文件 elevation.css，不碰 styles.css 这个并发热区。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ["tests/elevation-layer.test.ts"]

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
        "name": ".dialog-card 退回硬编码面板阴影（丢失三级抬升令牌）",
        "file": "src/renderer/theme/elevation.css",
        "old": "  box-shadow: var(--mf-shadow-3);",
        "new": "  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2); " + MUTANT_MARK,
    },
    {
        "name": ".btn 过渡硬编码 120ms（丢失快速时长令牌）",
        "file": "src/renderer/theme/elevation.css",
        "old": "  transition: background var(--mf-duration-fast) var(--mf-easing-standard),\n"
        "    border-color var(--mf-duration-fast) var(--mf-easing-standard);",
        "new": "  transition: background 120ms var(--mf-easing-standard),\n"
        "    border-color 120ms var(--mf-easing-standard); " + MUTANT_MARK,
    },
    {
        "name": ".mail-item 过渡退回 ease（丢失标准缓动令牌）",
        "file": "src/renderer/theme/elevation.css",
        "old": "  transition: background var(--mf-duration-fast) var(--mf-easing-standard);",
        "new": "  transition: background var(--mf-duration-fast) ease; " + MUTANT_MARK,
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
