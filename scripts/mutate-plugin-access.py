#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
账户级插件启用边界（shared/plugin-access.ts）不变量的变异验证。

每个变异体都是「把锁死的那处不变量再改坏」，对应测试必须变红；
任何一个变异体没被检出，说明那条断言只是装饰品。

做法上刻意不采用「整文件备份/还原」：本机工作区存在并发编辑，
整文件还原会把别人同时写进去的改动一起抹掉。这里只做定点字符串替换与回退。
还原锚点统一带唯一标记 MUTANT_MARK，替换/回退都不会误伤别处。
"""
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ["tests/plugin-access.test.ts"]

MUTANT_MARK = "/* MUTANT */"


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def read(path: Path) -> str:
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def write(path: Path, text: str) -> None:
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def run_tests() -> bool:
    """返回 True 表示测试通过（对变异体来说就是「没被检出」）。"""
    proc = subprocess.run(
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
        "name": "无账户上下文不再回落全局（一律视为禁用）",
        "file": "src/shared/plugin-access.ts",
        "old": "  if (!accountId) return globalEnabled;",
        "new": "  if (!accountId) return false; /* MUTANT */",
    },
    {
        "name": "账户级覆盖被整体忽略（永远继承全局）",
        "file": "src/shared/plugin-access.ts",
        "old": "  return typeof override === 'boolean' ? override : globalEnabled;",
        "new": "  return globalEnabled; /* MUTANT */",
    },
    {
        "name": "非布尔覆盖的防御性校验被削弱（typeof 改 string）",
        "file": "src/shared/plugin-access.ts",
        "old": "  return typeof override === 'boolean' ? override : globalEnabled;",
        "new": "  return typeof override === 'string' ? override : globalEnabled; /* MUTANT */",
    },
    {
        "name": "explicitOverride 不再拦截非布尔脏数据（原值泄漏）",
        "file": "src/shared/plugin-access.ts",
        "old": "  return typeof value === 'boolean' ? value : null;",
        "new": "  return value; /* MUTANT */",
    },
    {
        "name": "withoutAccount 删除条件取反而保留了被删账户、丢掉了其余",
        "file": "src/shared/plugin-access.ts",
        "old": "    if (key === accountId) continue;",
        "new": "    if (key !== accountId) continue; /* MUTANT */",
    },
    {
        "name": "全局禁用硬开关被移除（账户覆盖可重新启用已停用插件）",
        "file": "src/shared/plugin-access.ts",
        "old": "  if (!globalEnabled) return false;",
        "new": "  if (!globalEnabled) { /* MUTANT */ }",
    },
]


def main() -> int:
    src = ROOT / "src/shared/plugin-access.ts"
    baseline_md5 = md5(src)
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
            current = read(path)
            if current.count(mutant["new"]) != 1:
                raise SystemExit(f"还原锚点不唯一，已停止：{mutant['name']}")
            write(path, current.replace(mutant["new"], mutant["old"], 1))
            after = read(path)
            if MUTANT_MARK in after:
                raise SystemExit(f"仍有变异残留，已停止：{mutant['name']}")
            if md5(path) != baseline_md5:
                raise SystemExit(f"md5 不符，源码可能被改坏：{mutant['name']}")

    total = len(MUTANTS)
    print(f"\n变异检出 {detected}/{total}")
    if failures:
        print("未通过：")
        for item in failures:
            print(f"  - {item}")
        return 1
    if md5(src) != baseline_md5:
        print("源码最终未还原到基线 md5，已停止。")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
