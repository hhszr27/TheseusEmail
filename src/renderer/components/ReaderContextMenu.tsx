import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { t } from '../../shared/i18n';
import { useMailStore } from '../stores/mail-store';

/** 正文右键的落点信息（由 ReaderView 在 iframe 文档里采集）。 */
export interface ReaderMenuTarget {
  /** 视口坐标（已加上 iframe 的偏移）。 */
  x: number;
  y: number;
  /** 命中图片时的地址信息：src 为可操作的地址，blockedSrc 为被拦截的远程地址。 */
  image: { src: string; blockedSrc: string; alt: string } | null;
  /** iframe 里当前选中的文本。 */
  selection: string;
  /** 正文里是否存在被拦截的远程图片。 */
  hasBlockedImages: boolean;
}

interface ReaderContextMenuProps {
  target: ReaderMenuTarget;
  onClose(): void;
  onSelectAll(): void;
  onShowRemoteImages(): void;
}

function isRemoteUrl(url: string): boolean {
  return /^(?:https?:)?\/\//i.test(url.trim());
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * 正文右键菜单：图片可复制/另存为/复制地址/浏览器打开；空白处可复制选中文本、全选。
 *
 * 菜单渲染在宿主文档里（正文 iframe 无脚本权限），定位用 fixed，靠落点夹取避免出屏。
 */
export function ReaderContextMenu({
  target,
  onClose,
  onSelectAll,
  onShowRemoteImages,
}: ReaderContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ x: target.x, y: target.y });

  // 贴边时往回收，别让菜单跑到窗口外
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.max(margin, Math.min(target.x, window.innerWidth - rect.width - margin)),
      y: Math.max(margin, Math.min(target.y, window.innerHeight - rect.height - margin)),
    });
  }, [target]);

  useEffect(() => {
    firstItemRef.current?.focus();

    const handlePointerDown = (event: PointerEvent): void => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    const handleBlur = (): void => onClose();

    // 捕获阶段：点正文/工具栏任何位置都先关掉菜单
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [onClose]);

  const toast = (message: string): void => {
    useMailStore.getState().showToast(message);
  };

  const run = (action: () => Promise<void> | void): void => {
    onClose();
    void Promise.resolve(action());
  };

  const copyImage = (src: string, alt: string): void => {
    void window.api.copyReaderImage({ src, alt }).then((result) => {
      toast(result.ok ? t('reader.menu.copiedImage') : t('reader.menu.copyFailed', { reason: result.error.message }));
    });
  };

  const saveImage = (src: string, alt: string): void => {
    void window.api.saveReaderImage({ src, alt }).then((result) => {
      if (!result.ok) {
        toast(t('reader.menu.saveFailed', { reason: result.error.message }));
        return;
      }
      if (result.data.saved && result.data.path) {
        toast(t('reader.menu.saved', { name: fileNameOf(result.data.path) }));
      }
    });
  };

  const copyText = (text: string): void => {
    void window.api.copyText(text).then((result) => {
      toast(result.ok ? t('reader.menu.copiedText') : t('reader.menu.copyFailed', { reason: result.error.message }));
    });
  };

  const openInBrowser = (url: string): void => {
    void window.api.openExternal(url).then((result) => {
      if (!result.ok) toast(t('reader.menu.openFailed', { reason: result.error.message }));
    });
  };

  const item = (
    label: string,
    action: () => void,
    options: { disabled?: boolean; first?: boolean } = {},
  ): JSX.Element => (
    <button
      key={label}
      ref={options.first ? firstItemRef : undefined}
      type="button"
      role="menuitem"
      className="reader-menu-item"
      aria-disabled={options.disabled || undefined}
      onClick={() => {
        if (options.disabled) return;
        action();
      }}
    >
      {label}
    </button>
  );

  const separator = (key: string): JSX.Element => (
    <div key={key} className="reader-menu-sep" role="separator" />
  );

  const groups: JSX.Element[][] = [];

  if (target.image) {
    const image = target.image;
    const alt = image.alt;
    const canUsePixels = image.src !== '';

    // 第一组：能拿到像素时才有复制/另存为
    groups.push([
      item(t('reader.menu.copyImage'), () => run(() => copyImage(image.src, alt)), {
        disabled: !canUsePixels,
        first: true,
      }),
      item(t('reader.menu.saveImage'), () => run(() => saveImage(image.src, alt)), {
        disabled: !canUsePixels,
      }),
    ]);

    // 第二组：只有远程地址才谈得上「地址」——data: 内联图复制出来是一长串 base64，没有意义
    const address = canUsePixels ? image.src : image.blockedSrc;
    const extra: JSX.Element[] = [];
    if (address && isRemoteUrl(address)) {
      extra.push(item(t('reader.menu.copyAddress'), () => run(() => copyText(address))));
      extra.push(item(t('reader.menu.openImage'), () => run(() => openInBrowser(address))));
    }
    if (image.blockedSrc) {
      extra.push(item(t('reader.menu.showRemote'), () => run(onShowRemoteImages)));
    }
    if (extra.length > 0) groups.push(extra);
  } else {
    const textGroup: JSX.Element[] = [
      item(t('reader.menu.copy'), () => run(() => copyText(target.selection)), {
        disabled: !target.selection,
        first: true,
      }),
      item(t('reader.menu.selectAll'), () => run(onSelectAll)),
    ];
    groups.push(textGroup);
    if (target.hasBlockedImages) {
      groups.push([item(t('reader.menu.showRemote'), () => run(onShowRemoteImages))]);
    }
  }

  // 组之间插分隔线：第一组的首项已经在上面标了 first
  const rows: JSX.Element[] = [];
  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) rows.push(separator(`sep-${groupIndex}`));
    rows.push(...group);
  });

  return (
    <div
      ref={ref}
      className="reader-menu"
      role="menu"
      aria-label={t('reader.menu.label')}
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {rows}
    </div>
  );
}
