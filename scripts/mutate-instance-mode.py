#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
instance-mode.ts 变异测试（§36 单实例开关口径）。

对每个变异体：
  1) 确认锚点在源码中唯一出现（count == 1），否则立即失败（防错位改写）
  2) 注入变异 -> 运行 tests/instance-mode.test.ts
  3) 断言测试「变红」（退出码非 0），即不变量的回归保护有效
  4) 立即还原源码为原始字节

全部变异体跑完后，校验源码 md5 与开始时完全一致（字节级还原）。

用法：python3 scripts/mutate-instance-mode.py
依赖：项目根目录下可运行 `npx vitest run`。
"""
import hashlib
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src", "main", "app", "instance-mode.ts")
TEST = os.path.join(ROOT, "tests", "instance-mode.test.ts")

# (名称, 锚点原文, 变异后)
MUTANTS = [
    ("M1-ne-false->eq-false",
     "return parsed.singleInstance !== false;",
     "return parsed.singleInstance === false;"),
    ("M2-ne-false->ne-true",
     "return parsed.singleInstance !== false;",
     "return parsed.singleInstance !== true;"),
    ("M3-ne-false->typeof",
     "return parsed.singleInstance !== false;",
     "return typeof parsed.singleInstance !== 'undefined';"),
    ("M4-ne-false->eq-true",
     "return parsed.singleInstance !== false;",
     "return parsed.singleInstance === true;"),
    ("M5-catch-true->false",
     "    return true;",
     "    return false;"),
    ("M6-write-wrong-key",
     "JSON.stringify({ singleInstance }, null, 2)",
     "JSON.stringify({ singleInstanceMode: singleInstance }, null, 2)"),
]


def run_tests():
    # 走系统 shell，确保 npx(.cmd) 能在 Windows 上被正确解析
    cmd = "npx vitest run tests/instance-mode.test.ts"
    proc = subprocess.run(
        cmd,
        cwd=ROOT,
        capture_output=True,
        text=True,
        shell=True,
    )
    out = proc.stdout + proc.stderr
    return proc.returncode, out


def main():
    with open(SRC, "rb") as f:
        original = f.read()
    orig_md5 = hashlib.md5(original).hexdigest()
    print(f"original md5: {orig_md5}")

    results = []
    for name, find, repl in MUTANTS:
        text = original.decode("utf-8")
        count = text.count(find)
        if count != 1:
            print(f"[FAIL] {name}: 锚点出现 {count} 次（应为 1），中止以防错位改写")
            # 确保源码未被动
            with open(SRC, "rb") as f:
                if hashlib.md5(f.read()).hexdigest() != orig_md5:
                    open(SRC, "wb").write(original)
            sys.exit(1)

        mutated = text.replace(find, repl, 1)
        # 写变异体
        with open(SRC, "w", encoding="utf-8") as f:
            f.write(mutated)

        rc, out = run_tests()

        # 无论如何先还原
        with open(SRC, "wb") as f:
            f.write(original)

        caught = rc != 0
        marker = "CAUGHT" if caught else "MISSED"
        print(f"[{marker}] {name} (vitest rc={rc})")
        if not caught:
            # 把失败的测试名打出来，方便定位「等价变异体」
            for line in out.splitlines():
                if "FAIL" in line or "Tests " in line:
                    print("    " + line.strip())
        results.append((name, caught))

    # 最终字节级还原校验
    with open(SRC, "rb") as f:
        final_md5 = hashlib.md5(f.read()).hexdigest()
    restored = final_md5 == orig_md5
    print(f"final md5:   {final_md5}  restored={restored}")
    if not restored:
        print("[FAIL] 源码未还原为原始字节，请立即检查！")
        sys.exit(1)

    missed = [n for n, c in results if not c]
    if missed:
        print(f"[FAIL] 以下变异体未被测试捕获：{missed}")
        sys.exit(1)

    print(f"[OK] 全部 {len(MUTANTS)} 个变异体均被测试捕获，源码已字节级还原。")


if __name__ == "__main__":
    main()
