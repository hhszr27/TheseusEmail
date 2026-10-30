#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
托盘设置（tray-settings.ts）不变量的变异验证。

每个变异体都是「把锁死的那处不变量再改坏」，对应测试必须变红；
任何一个变异体没被检出，说明那条断言只是装饰品。

做法上刻意不采用「整文件备份/还原」：本机工作区存在并发编辑，
整文件还原会把别人同时写进去的改动一起抹掉。这里只做定点字符串替换与回退。
还原锚点统一带唯一标记 MUTANT_MARK，替换/回退都不会误伤别处。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ["tests/tray-settings.test.ts"]

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
        "name": "normalizeUnread 不再归零/取整（负未读/小数漏网）",
        "file": "src/main/app/tray-settings.ts",
        "old": "  return Math.max(0, Math.floor(Number.isFinite(unread) ? unread : 0));",
        "new": "  return Number.isFinite(unread) ? unread : 0; /* MUTANT */",
    },
    {
        "name": "徽章阈值 <=9 改成 <9（第 9 封落到 9+）",
        "file": "src/main/app/tray-settings.ts",
        "old": "  if (unread <= 9) return `tray-badge-${unread}.png`;",
        "new": "  if (unread < 9) return `tray-badge-${unread}.png`; /* MUTANT */",
    },
    {
        "name": "shouldHideOnClose 退出时不再放行（应用无法退出）",
        "file": "src/main/app/tray-settings.ts",
        "old": "  if (quitting) return false;",
        "new": "  if (quitting) return true; /* MUTANT */",
    },
    {
        "name": "trayTooltip 零未读仍拼封数（口径漂移）",
        "file": "src/main/app/tray-settings.ts",
        "old": "  if (count === 0) return 'MailForge';",
        "new": "  if (count === 0) return 'MailForge · 0 封未读'; /* MUTANT */",
    },
    {
        "name": "parseTraySettings 空串不再回落默认（脏数据逃逸）",
        "file": "src/main/app/tray-settings.ts",
        "old": "  if (!raw) return { ...DEFAULT_TRAY_SETTINGS };",
        "new": "  if (!raw) return { ...DEFAULT_TRAY_SETTINGS, enabled: false }; /* MUTANT */",
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
