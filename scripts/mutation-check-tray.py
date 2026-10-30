#!/usr/bin/env python3
"""变异验证：对托盘/通知关键断言注入缺陷，确认测试变红后还原。

用法：python scripts/mutation-check-tray.py
纪律：try/finally 保证还原；任何一处未按预期变红都算失败。
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (文件, 原文, 变异体, 必须变红的测试文件)
MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        "src/main/app/tray-settings.ts",
        "  if (quitting) return false;",
        "  if (false) return false;",
        "tests/tray.test.ts",
    ),
    (
        "src/main/app/tray-settings.ts",
        "  if (!settings.enabled) return false;\n  return settings.closeToTray;",
        "  return settings.closeToTray;",
        "tests/tray.test.ts",
    ),
    (
        "src/main/app/tray-settings.ts",
        "  if (unread <= 9) return `tray-badge-${unread}.png`;",
        "  if (unread <= 99) return `tray-badge-${unread}.png`;",
        "tests/tray.test.ts",
    ),
    (
        "src/main/notifications/settings.ts",
        "  return Math.min(MAX_REMINDER_MINUTES, Math.max(0, Math.round(num)));",
        "  return Math.round(num);",
        "tests/notifications-settings.test.ts",
    ),
    (
        "src/main/notifications/policy.ts",
        "  if (isDndActive(dnd, now)) return false;\n  return action === 'notify';",
        "  return action === 'notify';",
        "tests/notifications.test.ts",
    ),
    (
        "src/main/notifications/reminders.ts",
        "    if (delta < -REMINDER_GRACE_MS) {",
        "    if (delta < 0) {",
        "tests/reminders.test.ts",
    ),
    (
        "src/main/notifications/reminders.ts",
        "  date.setHours(9, 0, 0, 0);",
        "  date.setHours(0, 0, 0, 0);",
        "tests/reminders.test.ts",
    ),
]


def run_tests(test_file: str) -> bool:
    # Windows 上 npx 是 npx.cmd，必须经 shell 调用
    result = subprocess.run(
        f"npx vitest run {test_file}",
        cwd=ROOT,
        capture_output=True,
        text=True,
        shell=True,
    )
    return result.returncode == 0


def main() -> int:
    failures: list[str] = []
    for rel_path, old, new, test_file in MUTATIONS:
        path = ROOT / rel_path
        original = path.read_text(encoding="utf-8")
        backup = Path(tempfile.mktemp(suffix=path.name))
        shutil.copy2(path, backup)
        try:
            if old not in original:
                failures.append(f"{rel_path}: 找不到变异点（代码已变？）")
                print(f"  SKIP {rel_path} :: {old.strip()[:40]}")
                continue
            path.write_text(original.replace(old, new, 1), encoding="utf-8")

            passed = run_tests(test_file)
            if passed:
                failures.append(f"{rel_path} :: {old.strip()[:50]} -> 测试仍然全绿（断言无效）")
                print(f"  RED?  {rel_path} :: {old.strip()[:40]} —— 未变红！")
            else:
                print(f"  OK    {rel_path} :: {old.strip()[:40]} -> 变红")
        finally:
            shutil.copy2(backup, path)
            backup.unlink()

        # 还原后必须恢复绿
        if not run_tests(test_file):
            failures.append(f"{rel_path}: 还原后测试未恢复绿色（还原失败？）")
            print(f"  RED   {rel_path} 还原后仍红！")

    print()
    if failures:
        print("变异验证失败：")
        for item in failures:
            print(" -", item)
        return 1
    print(f"变异验证通过：{len(MUTATIONS)} 处注入全部按预期变红并还原。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
