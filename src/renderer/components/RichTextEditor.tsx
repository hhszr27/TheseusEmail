import { useEffect, useReducer, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import CharacterCount from '@tiptap/extension-character-count';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import { Indent } from '../extensions/indent';
import { Search, type SearchStorage } from '../extensions/search';
import { ALLOWED_HTML_TAGS } from '../../shared/constants';

/**
 * 富文本编辑器（Tiptap 3 内核，Outlook 风格工具栏）。
 *
 * 选型约束（见架构备忘）：内核跑在渲染进程里没问题，但**边界必须干净**——
 *  - 图片：粘贴的截图读字节转 data URL 内联（沙箱里拿不到真实路径）；
 *  - 净化：这里的 DOMPurify 只做「即时预览/防手滑」，**发送前主进程还会用
 *    `sanitizeComposeHtml()` 再净化一次**（渲染进程的净化可被绕过，主进程才是边界）；
 *  - 文件、剪贴板路径、网络抓图都不在这里做，留给 IPC / 主进程。
 *
 * props 与原自研版本一致，写信框与草稿阅读区无需改动。
 */

/** 与主进程共用同一份标签白名单，避免「编辑器里能看到的，发出去被剥掉」。 */
const ALLOWED_ATTR = [
  'href',
  'target',
  'rel',
  'src',
  'alt',
  'width',
  'height',
  'colspan',
  'rowspan',
  'style',
  'align',
];

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_HTML_TAGS],
    ALLOWED_ATTR,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

/** 粘贴图片：拿不到真实路径，只能把字节读成 data URL 内联。 */
function handleImagePaste(event: ClipboardEvent, editorRef: MutableRefObject<Editor | null>): boolean {
  const images = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith('image/'),
  );
  if (images.length === 0) return false;
  event.preventDefault();
  for (const file of images) {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : '';
      if (!src.startsWith('data:image/')) return;
      editorRef.current?.chain().focus().setImage({ src, alt: file.name }).run();
    };
    reader.readAsDataURL(file);
  }
  return true;
}

const FONT_FAMILIES = [
  { label: '默认字体', value: '' },
  { label: '微软雅黑', value: '"Microsoft YaHei", "微软雅黑", sans-serif' },
  { label: '宋体', value: 'SimSun, "宋体", serif' },
  { label: '楷体', value: 'KaiTi, "楷体", serif' },
  { label: '黑体', value: 'SimHei, "黑体", sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Consolas', value: 'Consolas, monospace' },
];

const FONT_SIZES = [
  { label: '默认', value: '' },
  { label: '小 (12px)', value: '12px' },
  { label: '正文 (14px)', value: '14px' },
  { label: '中 (16px)', value: '16px' },
  { label: '大 (18px)', value: '18px' },
  { label: '特大 (20px)', value: '20px' },
  { label: '标题 (24px)', value: '24px' },
  { label: '更大 (28px)', value: '28px' },
  { label: '最大 (32px)', value: '32px' },
];

const EMOJIS = ['😊', '👍', '🎉', '❤️', '🚀', '✅', '⚠️', '📌', '💡', '🔥', '📈', '🙏', '😂', '🤔', '👏', '💪'];

const SIGNATURE_HTML =
  '<p></p><p style="color:#6b7280;font-size:12px">——<br>张三 · DragonEmail 团队<br>📧 me@dragonemail.app</p>';
const TEMPLATE_HTML =
  '<p>您好，</p><p>关于______的事宜，现同步如下：</p><p>1. </p><p>2. </p><p>如有疑问请随时联系。</p><p>祝好</p>';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  /** 可选 id，用于右键菜单等定位（如 "compose-body"）。 */
  id?: string;
  placeholder?: string;
}

interface ToolButtonProps {
  title: string;
  onClick(): void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}

function ToolButton({ title, onClick, active, disabled, children }: ToolButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`btn-icon${active ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active === true}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface PainterFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  textStyle: Record<string, unknown>;
  highlight: string | null;
}

export function RichTextEditor({
  value,
  onChange,
  disabled = false,
  id,
  placeholder,
}: RichTextEditorProps): JSX.Element {
  const editorRef = useRef<Editor | null>(null);
  /** 点颜色/字体下拉会让编辑器失焦并收起选区，先存下来，应用格式时再还原。 */
  const savedSel = useRef<{ from: number; to: number } | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  const captureSelection = (): void => {
    if (editor) savedSel.current = { from: editor.state.selection.from, to: editor.state.selection.to };
  };
  const restoreRange = (): { from: number; to: number } | null => savedSel.current;

  /** 链接/图片地址输入条（Electron 无 window.prompt，用内联条）。 */
  const [addressPrompt, setAddressPrompt] = useState<{ kind: 'link' | 'image'; value: string } | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState('');
  const [replaceTerm, setReplaceTerm] = useState('');
  const [sourceView, setSourceView] = useState(false);
  const [painter, setPainter] = useState<PainterFormat | null>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          link: {
            openOnClick: false,
            autolink: true,
            HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
          },
        }),
        TextStyle,
        Color,
        FontFamily,
        FontSize,
        Highlight.configure({ multicolor: true }),
        Subscript,
        Superscript,
        CharacterCount,
        Indent,
        Search,
        Image.configure({ allowBase64: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        Placeholder.configure({ placeholder: placeholder ?? '写点什么…' }),
      ],
      content: sanitizeHtml(value),
      editable: !disabled,
      onUpdate: ({ editor: instance }) => onChange(instance.getHTML()),
      editorProps: {
        attributes: {
          class: 'rich-editor',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': placeholder ?? '正文',
        },
        // 粘贴进来的 HTML 先过一遍白名单，别把整段网页样式/脚本带进来
        transformPastedHTML: (html) => sanitizeHtml(html),
        handlePaste: (_view, event) => handleImagePaste(event, editorRef),
      },
    },
    [],
  );

  useEffect(() => {
    editorRef.current = editor ?? null;
  }, [editor]);

  // 每次事务都重渲染，让工具栏 active 态 / 字数 / 选中格式保持同步
  useEffect(() => {
    if (!editor) return;
    const handler = (): void => force();
    // 点颜色/字体下拉会让编辑器失焦并收起选区，失焦时把选区记下来，
    // 应用格式时再还原（与 onMouseDown 捕获互为双保险）。
    const onBlur = (): void => {
      savedSel.current = { from: editor.state.selection.from, to: editor.state.selection.to };
    };
    editor.on('transaction', handler);
    editor.on('blur', onBlur);
    return () => {
      editor.off('transaction', handler);
      editor.off('blur', onBlur);
    };
  }, [editor]);

  // 外部值变化（切换草稿、回填模板）时才回写，避免输入过程中光标乱跳
  useEffect(() => {
    if (!editor) return;
    if (value === editor.getHTML()) return;
    editor.commands.setContent(sanitizeHtml(value), { emitUpdate: false });
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  const styleAttrs = editor?.getAttributes('textStyle') ?? {};
  const currentFont = (styleAttrs.fontFamily as string) ?? '';
  const currentSize = (styleAttrs.fontSize as string) ?? '';
  const currentColor = (styleAttrs.color as string) ?? '#1a1a1a';
  const highlightAttrs = editor?.getAttributes('highlight') ?? {};
  const currentHighlight = (highlightAttrs.color as string) ?? '#fde047';

  const charCount = editor ? (editor.storage.characterCount.characters() as number) : 0;
  const wordCount = editor ? (editor.storage.characterCount.words() as number) : 0;

  const openLinkPrompt = (): void => {
    if (!editor) return;
    const previous = editor.getAttributes('link').href as string | undefined;
    setAddressPrompt({ kind: 'link', value: previous ?? 'https://' });
  };

  const openImagePrompt = (): void => {
    if (!editor) return;
    setAddressPrompt({ kind: 'image', value: 'https://' });
  };

  const applyAddress = (): void => {
    if (!editor || !addressPrompt) return;
    const raw = addressPrompt.value.trim();
    setAddressPrompt(null);
    if (addressPrompt.kind === 'link') {
      if (raw === '') {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
        return;
      }
      const safe = /^(https?:|mailto:)/i.test(raw) ? raw : `https://${raw}`;
      editor.chain().focus().extendMarkRange('link').setLink({ href: safe }).run();
      return;
    }
    if (raw === '') return;
    const safe = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    editor.chain().focus().setImage({ src: safe }).run();
  };

  const setFontFamily = (value: string): void => {
    if (!editor) return;
    const range = restoreRange();
    const chain = editor.chain().focus();
    if (range) chain.setTextSelection(range);
    if (value) chain.setFontFamily(value).run();
    else chain.unsetFontFamily().run();
  };

  const setFontSize = (value: string): void => {
    if (!editor) return;
    const range = restoreRange();
    const chain = editor.chain().focus();
    if (range) chain.setTextSelection(range);
    if (value) chain.setFontSize(value).run();
    else chain.unsetFontSize().run();
  };

  const applyColor = (value: string): void => {
    if (!editor) return;
    const range = restoreRange();
    const chain = editor.chain().focus();
    if (range) chain.setTextSelection(range);
    chain.setColor(value).run();
  };

  const applyHighlight = (value: string): void => {
    if (!editor) return;
    const range = restoreRange();
    const chain = editor.chain().focus();
    if (range) chain.setTextSelection(range);
    chain.setHighlight({ color: value }).run();
  };

  const toggleFormatPainter = (): void => {
    if (!editor) return;
    if (painter) {
      const { from, to } = editor.state.selection;
      if (to > from) {
        const f = painter;
        const chain = editor.chain().focus();
        f.bold ? chain.setBold() : chain.unsetBold();
        f.italic ? chain.setItalic() : chain.unsetItalic();
        f.underline ? chain.setUnderline() : chain.unsetUnderline();
        f.strike ? chain.setStrike() : chain.unsetStrike();
        if (f.textStyle && Object.keys(f.textStyle).length) {
          chain.setMark('textStyle', f.textStyle);
        } else {
          chain.unsetMark('textStyle');
        }
        if (f.highlight) chain.setHighlight({ color: f.highlight });
        else chain.unsetHighlight();
        chain.run();
      }
      setPainter(null);
      return;
    }
    setPainter({
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      underline: editor.isActive('underline'),
      strike: editor.isActive('strike'),
      textStyle: { ...styleAttrs },
      highlight: (highlightAttrs.color as string) ?? null,
    });
  };

  /** 查找命中信息（每次事务都会 force 重渲染，读 storage 就是实时的）。 */
  const searchState = editor?.storage.search as SearchStorage | undefined;
  const hitCount = searchState?.results.length ?? 0;
  const hitIndex = hitCount > 0 ? (searchState?.current ?? 0) + 1 : 0;

  const toggleCase = (on: boolean): void => {
    editor?.commands.setCaseSensitive(on);
  };

  const runFind = (): void => {
    if (!editor) return;
    editor.commands.setSearchTerm(findTerm);
    editor.commands.setReplaceTerm(replaceTerm);
  };

  const replaceOne = (): void => {
    if (!editor) return;
    editor.commands.setSearchTerm(findTerm);
    editor.commands.setReplaceTerm(replaceTerm);
    editor.commands.replaceSearch();
  };

  const replaceAll = (): void => {
    if (!editor) return;
    editor.commands.setSearchTerm(findTerm);
    editor.commands.setReplaceTerm(replaceTerm);
    editor.commands.replaceAllSearch();
  };

  const inTable = editor?.isActive('table') === true;

  return (
    <div className="rich-editor-wrap" id={id}>
      <div className="rich-toolbar" role="toolbar" aria-label="文本格式">
        <select
          className="rich-select"
          title="字体"
          value={currentFont}
          onMouseDown={captureSelection}
          onChange={(e) => setFontFamily(e.target.value)}
          disabled={disabled}
        >
          {FONT_FAMILIES.map((f) => (
            <option key={f.label} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          className="rich-select"
          title="字号"
          value={currentSize}
          onMouseDown={captureSelection}
          onChange={(e) => setFontSize(e.target.value)}
          disabled={disabled}
        >
          {FONT_SIZES.map((s) => (
            <option key={s.label} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolButton title="撤销" disabled={!editor || !editor.can().undo()} onClick={() => editor?.chain().focus().undo().run()}>
          ↶
        </ToolButton>
        <ToolButton title="重做" disabled={!editor || !editor.can().redo()} onClick={() => editor?.chain().focus().redo().run()}>
          ↷
        </ToolButton>
        <span className="rich-toolbar-sep" aria-hidden="true" />
        <ToolButton title="加粗" active={editor?.isActive('bold')} onClick={() => editor?.chain().focus().toggleBold().run()}>
          <b>B</b>
        </ToolButton>
        <ToolButton title="斜体" active={editor?.isActive('italic')} onClick={() => editor?.chain().focus().toggleItalic().run()}>
          <i>I</i>
        </ToolButton>
        <ToolButton title="下划线" active={editor?.isActive('underline')} onClick={() => editor?.chain().focus().toggleUnderline().run()}>
          <u>U</u>
        </ToolButton>
        <ToolButton title="删除线" active={editor?.isActive('strike')} onClick={() => editor?.chain().focus().toggleStrike().run()}>
          <s>S</s>
        </ToolButton>
        <ToolButton title="下标" active={editor?.isActive('subscript')} onClick={() => editor?.chain().focus().toggleSubscript().run()}>
          x₂
        </ToolButton>
        <ToolButton title="上标" active={editor?.isActive('superscript')} onClick={() => editor?.chain().focus().toggleSuperscript().run()}>
          x²
        </ToolButton>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <label className="rich-swatch" title="字体颜色" onMouseDown={captureSelection}>
          <span className="rich-swatch-dot" style={{ background: currentColor }} />
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : '#1a1a1a'}
            onChange={(e) => applyColor(e.target.value)}
            disabled={disabled}
          />
        </label>
        <label className="rich-swatch" title="文本突出显示" onMouseDown={captureSelection}>
          <span className="rich-swatch-dot" style={{ background: currentHighlight }} />
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(currentHighlight) ? currentHighlight : '#fde047'}
            onChange={(e) => applyHighlight(e.target.value)}
            disabled={disabled}
          />
        </label>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolButton title="一级标题" active={editor?.isActive('heading', { level: 1 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>
          H1
        </ToolButton>
        <ToolButton title="二级标题" active={editor?.isActive('heading', { level: 2 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>
          H2
        </ToolButton>
        <ToolButton title="三级标题" active={editor?.isActive('heading', { level: 3 })} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}>
          H3
        </ToolButton>
        <ToolButton title="无序列表" active={editor?.isActive('bulletList')} onClick={() => editor?.chain().focus().toggleBulletList().run()}>
          •
        </ToolButton>
        <ToolButton title="有序列表" active={editor?.isActive('orderedList')} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
          1.
        </ToolButton>
        <ToolButton title="减少缩进" onClick={() => editor?.chain().focus().outdent().run()}>
          ⇤
        </ToolButton>
        <ToolButton title="增加缩进" onClick={() => editor?.chain().focus().indent().run()}>
          ⇥
        </ToolButton>
        <ToolButton title="引用" active={editor?.isActive('blockquote')} onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
          ❝
        </ToolButton>
        <ToolButton title="代码块" active={editor?.isActive('codeBlock')} onClick={() => editor?.chain().focus().toggleCodeBlock().run()}>
          {'</>'}
        </ToolButton>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolButton title="左对齐" active={editor?.isActive({ textAlign: 'left' })} onClick={() => editor?.chain().focus().setTextAlign('left').run()}>
          ⇤
        </ToolButton>
        <ToolButton title="居中" active={editor?.isActive({ textAlign: 'center' })} onClick={() => editor?.chain().focus().setTextAlign('center').run()}>
          ⇔
        </ToolButton>
        <ToolButton title="右对齐" active={editor?.isActive({ textAlign: 'right' })} onClick={() => editor?.chain().focus().setTextAlign('right').run()}>
          ⇥
        </ToolButton>

        <span className="rich-toolbar-sep" aria-hidden="true" />

        <ToolButton title="插入链接" active={editor?.isActive('link')} onClick={openLinkPrompt}>
          🔗
        </ToolButton>
        <ToolButton title="插入图片" onClick={openImagePrompt}>
          🖼
        </ToolButton>
        <ToolButton
          title="插入表格（3×3）"
          onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          ▦
        </ToolButton>
        <ToolButton title="表情" onClick={() => setEmojiOpen((v) => !v)}>
          😊
        </ToolButton>
        <ToolButton title="插入签名" onClick={() => editor?.chain().focus().insertContent(SIGNATURE_HTML).run()}>
          ✍
        </ToolButton>
        <ToolButton title="插入模板" onClick={() => editor?.chain().focus().insertContent(TEMPLATE_HTML).run()}>
          📄
        </ToolButton>
        <ToolButton title="格式刷" active={painter !== null} onClick={toggleFormatPainter}>
          🖌
        </ToolButton>
        <ToolButton title="查找 / 替换" active={findOpen} onClick={() => setFindOpen((v) => !v)}>
          🔍
        </ToolButton>
        <ToolButton title="HTML 源码" active={sourceView} onClick={() => setSourceView((v) => !v)}>
          ⟨⟩
        </ToolButton>
      </div>

      {/* 表格内操作时出现 */}
      {inTable ? (
        <div className="rich-toolbar rich-toolbar-sub" role="toolbar" aria-label="表格操作">
          <ToolButton title="在上方插入行" onClick={() => editor?.chain().focus().addRowBefore().run()}>＋行↑</ToolButton>
          <ToolButton title="在下方插入行" onClick={() => editor?.chain().focus().addRowAfter().run()}>＋行↓</ToolButton>
          <ToolButton title="在左侧插入列" onClick={() => editor?.chain().focus().addColumnBefore().run()}>＋列←</ToolButton>
          <ToolButton title="在右侧插入列" onClick={() => editor?.chain().focus().addColumnAfter().run()}>＋列→</ToolButton>
          <ToolButton title="删除行" onClick={() => editor?.chain().focus().deleteRow().run()}>－行</ToolButton>
          <ToolButton title="删除列" onClick={() => editor?.chain().focus().deleteColumn().run()}>－列</ToolButton>
          <ToolButton title="合并单元格" onClick={() => editor?.chain().focus().mergeCells().run()}>合并</ToolButton>
          <ToolButton title="拆分单元格" onClick={() => editor?.chain().focus().splitCell().run()}>拆分</ToolButton>
          <ToolButton title="切换标题行" active={editor?.isActive('tableHeader')} onClick={() => editor?.chain().focus().toggleHeaderRow().run()}>表头</ToolButton>
          <ToolButton title="删除表格" onClick={() => editor?.chain().focus().deleteTable().run()}>删表</ToolButton>
        </div>
      ) : null}

      {addressPrompt ? (
        <div className="rich-address-bar" role="dialog" aria-label="插入地址">
          <span className="rich-address-label">
            {addressPrompt.kind === 'link' ? '链接地址' : '图片地址'}
          </span>
          <input
            autoFocus
            className="rich-address-input"
            value={addressPrompt.value}
            onChange={(event) => setAddressPrompt({ ...addressPrompt, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyAddress();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setAddressPrompt(null);
              }
            }}
            placeholder="https://…"
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={applyAddress}>
            确定
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setAddressPrompt(null)}>
            取消
          </button>
        </div>
      ) : null}

      {emojiOpen ? (
        <div className="rich-address-bar" role="dialog" aria-label="插入表情">
          <span className="rich-address-label">表情</span>
          <div className="rich-emoji-list">
            {EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                className="rich-emoji"
                onClick={() => editor?.chain().focus().insertContent(em).run()}
              >
                {em}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setEmojiOpen(false)}>
            关闭
          </button>
        </div>
      ) : null}

      {findOpen ? (
        <div className="rich-address-bar" role="dialog" aria-label="查找替换">
          <span className="rich-address-label">查找</span>
          <input
            className="rich-address-input"
            value={findTerm}
            onChange={(e) => setFindTerm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runFind()}
            placeholder="要找的文字"
          />
          <span className="rich-address-label">替换</span>
          <input
            className="rich-address-input"
            value={replaceTerm}
            onChange={(e) => setReplaceTerm(e.target.value)}
            placeholder="替换成"
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={hitCount === 0}
            onClick={() => editor?.commands.prevSearch()}
          >
            上一个
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={hitCount === 0}
            onClick={() => editor?.commands.nextSearch()}
          >
            下一个
          </button>
          <label className="rich-find-toggle" title="区分大小写">
            <input
              type="checkbox"
              checked={searchState?.caseSensitive ?? false}
              onChange={(e) => toggleCase(e.target.checked)}
            />
            区分大小写
          </label>
          <span className="rich-find-count">
            {hitCount > 0 ? `${hitIndex}/${hitCount}` : '无匹配'}
          </span>
          <button type="button" className="btn btn-sm btn-primary" onClick={runFind}>
            查找
          </button>
          <button type="button" className="btn btn-sm" onClick={replaceOne}>
            替换
          </button>
          <button type="button" className="btn btn-sm" onClick={replaceAll}>
            全部替换
          </button>
          <button type="button" className="btn btn-sm" onClick={() => { editor?.commands.clearSearch(); setFindOpen(false); }}>
            关闭
          </button>
        </div>
      ) : null}

      {sourceView ? (
        <pre className="rich-source" aria-label="HTML 源码">{editor ? editor.getHTML() : ''}</pre>
      ) : (
        <div className="rich-editor-body">
          <EditorContent editor={editor} />
        </div>
      )}

      <div className="rich-status">
        字数 {charCount} · 词数 {wordCount}
        {painter ? ' · 格式刷：已拾取，选中文字后点「🖌」应用' : ''}
      </div>
    </div>
  );
}
