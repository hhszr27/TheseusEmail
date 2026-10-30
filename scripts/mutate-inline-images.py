# -*- coding: utf-8 -*-
"""
内嵌图片（CID）链路的变异测试。

用法：python scripts/mutate-inline-images.py
每个变异体注入一处缺陷后必须让 tests/inline-images.test.ts 变红，
否则说明相应的断言是装饰品。源码用 shutil.copy2 二进制还原（不走文本读写，
避免 Windows 默认编码把 UTF-8 源码写坏）。
"""

import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "tests/inline-images.test.ts"

FILES = {
    "inline": ROOT / "src/main/mail/inline-images.ts",
    "store": ROOT / "src/main/mail/compose-attachments.ts",
    "sender": ROOT / "src/main/mail/smtp-sender.ts",
}

MUTANTS = [
    ("去重失效：同一张图产出多份附件", "inline", "const known = bySrc.get(src);", "const known = undefined;"),
    ("单张上限被跳过", "inline", "if (content.length > maxImageBytes || total + content.length > maxTotalBytes) {", "if (total + content.length > maxTotalBytes) {"),
    ("总量上限被跳过", "inline", "|| total + content.length > maxTotalBytes", "|| false"),
    ("src 不再改写成 cid", "inline", "return `src=${quote}cid:${image.cid}${quote}`;", "return match;"),
    ("落盘失败的 cid 不还原", "inline", "if (stagedCids.has(image.cid)) continue;", "continue;"),
    ("0 字节也当有效图片", "inline", "return buffer.length > 0 ? buffer : null;", "return buffer;"),
    ("jpg MIME 不归一", "inline", "return `image/${lower === 'jpg' ? 'jpeg' : lower}`;", "return `image/${lower}`;"),
    ("data-src 之类被误伤", "inline", r'''(?<![\w-])src''', r'''src'''),
    ("落盘内容写错", "store", "await fs.promises.writeFile(target, image.content);", "await fs.promises.writeFile(target, Buffer.from(''));"),
    ("落盘后丢掉 cid", "store", "staged.push({ id, filename, path: target, cid: image.cid, contentType: image.contentType });", "staged.push({ id, filename, path: target, cid: '', contentType: image.contentType });"),
    ("发送时不区分 inline 附件", "sender", "attachment.cid\n", "false\n"),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_tests() -> bool:
    """返回 True 表示测试通过（变异体应当让它返回 False）。"""
    proc = subprocess.run(
        # Windows 上的 npx 是 .cmd，必须经 shell 解析（直接 CreateProcess 会 FileNotFoundError）
        "npx vitest run " + TEST + " --reporter=dot",
        cwd=str(ROOT),
        shell=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return proc.returncode == 0


def main() -> int:
    backups = {key: path.read_bytes() for key, path in FILES.items()}
    digests = {key: md5(path) for key, path in FILES.items()}
    failures = []

    try:
        baseline = run_tests()
        if not baseline:
            print("干净源码下测试就没通过，先修基线再谈变异")
            return 1

        for index, (label, key, old, new) in enumerate(MUTANTS, start=1):
            path = FILES[key]
            text = path.read_text(encoding="utf-8")
            if old not in text:
                print(f"[{index:02d}] 跳过（找不到锚点）: {label}")
                failures.append(label)
                continue
            path.write_text(text.replace(old, new, 1), encoding="utf-8")
            try:
                passed = run_tests()
            finally:
                path.write_bytes(backups[key])
            status = "未被检出（断言无效）" if passed else "已检出"
            print(f"[{index:02d}] {status}: {label}")
            if passed:
                failures.append(label)

        # 还原核对
        for key, path in FILES.items():
            if md5(path) != digests[key]:
                print(f"源码未还原: {path}")
                return 1
    finally:
        for key, path in FILES.items():
            path.write_bytes(backups[key])

    print("---")
    if failures:
        print(f"{len(failures)}/{len(MUTANTS)} 个变异体没被检出：")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"全部 {len(MUTANTS)} 个变异体都被检出，源码已还原")
    return 0


if __name__ == "__main__":
    sys.exit(main())
