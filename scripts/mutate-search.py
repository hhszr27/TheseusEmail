"""查找/替换的变异测试：注入缺陷 -> 必须变红 -> 二进制还原。

覆盖两个文件：
  - src/renderer/extensions/search.ts     （匹配与装饰同步，逻辑层）
  - src/renderer/components/RichTextEditor.tsx（查找栏接线，UI 层）

用法：python scripts/mutate-search.py
"""
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEARCH_TS = ROOT / "src" / "renderer" / "extensions" / "search.ts"
EDITOR_TSX = ROOT / "src" / "renderer" / "components" / "RichTextEditor.tsx"
BACKUP = ROOT / "scripts" / ".mutate.orig"
TEST = "tests/search-match.test.ts"
UI_TEST = "tests/editor-find-ui.test.tsx"

# (名称, 目标文件, 被测脚本, [(old, new), ...])
MUTANTS: list[tuple[str, Path, str, list[tuple[str, str]]]] = [
    (
        "M1 退回逐 text node 匹配（跨格式搜不到）",
        SEARCH_TS,
        TEST,
        [
            (
                "    collectInline(node, pos + 1, out);",
                "    node.forEach((c) => { if (!c.isText) return; const t = c.text ?? ''; for (let i = 0; i < t.length; i++) out.map.push(pos + 1 + i); out.text += t; });",
            )
        ],
    ),
    (
        "M2 文档改动后不重算命中（高亮/位置错位）",
        SEARCH_TS,
        TEST,
        [("            if (tr.docChanged && storage.searchTerm) {", "            if (false) {")],
    ),
    (
        "M3 clearSearch 不清词（关栏后仍会点亮）",
        SEARCH_TS,
        TEST,
        [("          this.storage.searchTerm = '';", "          this.storage.searchTerm = this.storage.searchTerm;")],
    ),
    (
        "M4 内联节点不加分隔符（换行两侧拼成假命中）",
        SEARCH_TS,
        TEST,
        [("      out.text += INLINE_BREAK;", "      out.text += '';")],
    ),
    (
        "M5 大小写开关不同步到 storage（UI 复选框不翻）",
        SEARCH_TS,
        TEST,
        [("          this.storage.caseSensitive = value;", "          this.storage.caseSensitive = false;")],
    ),
    (
        "M6 跨段落拼接匹配（替换会把两段并成一段）",
        SEARCH_TS,
        TEST,
        [
            (
                "function findMatches(doc: PMNode, text: string, caseSensitive: boolean): SearchResult[] {",
                "const SHARED: { text: string; map: number[] } = { text: '', map: [] };\nfunction findMatches(doc: PMNode, text: string, caseSensitive: boolean): SearchResult[] {\n  SHARED.text = '';\n  SHARED.map = [];",
            ),
            (
                "    const out: { text: string; map: number[] } = { text: '', map: [] };",
                "    const out = SHARED;",
            ),
        ],
    ),
    (
        "M7 默认变成大小写敏感",
        SEARCH_TS,
        TEST,
        [("  addOptions() {\n    return { caseSensitive: false };", "  addOptions() {\n    return { caseSensitive: true };")],
    ),
    (
        "M8 命中计数永远显示无匹配",
        EDITOR_TSX,
        UI_TEST,
        [
            (
                "            {hitCount > 0 ? `${hitIndex}/${hitCount}` : '无匹配'}",
                "            {'无匹配'}",
            )
        ],
    ),
    (
        "M9 大小写复选框写成死值（勾不上）",
        EDITOR_TSX,
        UI_TEST,
        [("              checked={searchState?.caseSensitive ?? false}", "              checked={false}")],
    ),
    (
        "M10 查找按钮不读输入框里的词",
        EDITOR_TSX,
        UI_TEST,
        [("    editor.commands.setSearchTerm(findTerm);\n    editor.commands.setReplaceTerm(replaceTerm);\n  };\n\n  const replaceOne", "    editor.commands.setSearchTerm('');\n    editor.commands.setReplaceTerm(replaceTerm);\n  };\n\n  const replaceOne")],
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_tests(test_file: str) -> bool:
    """返回 True 表示测试通过（变异体必须让它返回 False）。"""
    proc = subprocess.run(
        ["npx", "vitest", "run", test_file],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        shell=True,
    )
    return proc.returncode == 0


def main() -> int:
    originals = {p: md5(p) for p in (SEARCH_TS, EDITOR_TSX)}
    shutil.copy2(SEARCH_TS, BACKUP.with_suffix(".ts"))
    shutil.copy2(EDITOR_TSX, BACKUP.with_suffix(".tsx"))
    failed: list[str] = []
    try:
        for name, target, test_file, pairs in MUTANTS:
            src = target.read_text(encoding="utf-8")
            missing = [old for old, _ in pairs if old not in src]
            if missing:
                failed.append(f"{name}: 变异点没找到（脚本失效）：{missing[0][:40]}")
                continue
            for old, new in pairs:
                src = src.replace(old, new, 1)
            target.write_text(src, encoding="utf-8")
            ok = run_tests(test_file)
            print(f"{'GREEN-漏检' if ok else 'RED-OK':12} {name}")
            if ok:
                failed.append(f"{name}: 变异体仍然全绿，测试没抓到")
            shutil.copy2(BACKUP.with_suffix(target.suffix), target)
            assert md5(target) == originals[target], f"还原后 md5 不一致：{target.name}"

        # 干净源码跑一遍，确认基线是绿的
        for name, test_file in (("逻辑层", TEST), ("UI 层", UI_TEST)):
            clean = run_tests(test_file)
            print(f"{'GREEN-OK' if clean else 'RED-异常'}  干净源码基线（{name}）")
            if not clean:
                failed.append(f"干净源码基线不是绿的（{name}）")
    finally:
        shutil.copy2(BACKUP.with_suffix(".ts"), SEARCH_TS)
        shutil.copy2(BACKUP.with_suffix(".tsx"), EDITOR_TSX)
        BACKUP.with_suffix(".ts").unlink(missing_ok=True)
        BACKUP.with_suffix(".tsx").unlink(missing_ok=True)

    print("-" * 60)
    ok_md5 = all(md5(p) == h for p, h in originals.items())
    print(f"md5 一致：{ok_md5}")
    for f in failed:
        print("FAIL:", f)
    print("结论：", "全部变异体被检出" if not failed else "存在漏检")
    return 1 if (failed or not ok_md5) else 0


if __name__ == "__main__":
    sys.exit(main())
