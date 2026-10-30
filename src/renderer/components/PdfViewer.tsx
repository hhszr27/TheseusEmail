import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import { PDF_MAX_CANVAS_PIXELS, fitWithinPixelBudget } from '../../shared/attachments';

/**
 * PDF 预览（§11.2）：
 * pdf.js 渲染到 canvas；isEvalSupported=false；每页等比缩放到 800 万像素以内；
 * 不使用 <embed>/<iframe>，因此 PDF 内的脚本没有执行环境。
 */

let workerReady = false;
function ensureWorker(): void {
  if (workerReady) return;
  pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker();
  workerReady = true;
}

interface PdfViewerProps {
  dataBase64: string;
  filename: string;
}

const MAX_PAGES = 12;

export function PdfViewer({ dataBase64, filename }: PdfViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    setStatus('loading');
    setError(null);

    void (async () => {
      try {
        ensureWorker();
        const binary = atob(dataBase64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }

        const loadingTask = pdfjs.getDocument({
          data: bytes,
          isEvalSupported: false,
          useSystemFonts: true,
          disableAutoFetch: true,
        });
        const pdfDocument = await loadingTask.promise;
        if (cancelled) {
          await pdfDocument.destroy();
          return;
        }

        setPages(pdfDocument.numPages);
        const count = Math.min(pdfDocument.numPages, MAX_PAGES);

        for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
          if (cancelled) break;
          const page = await pdfDocument.getPage(pageNumber);
          const base = page.getViewport({ scale: 1 });
          const fit = fitWithinPixelBudget(base.width, base.height, PDF_MAX_CANVAS_PIXELS);
          // 在像素预算内尽量放大，便于阅读
          const targetWidth = Math.min(1100, fit.width * 1.6);
          const scale = Math.max(0.4, Math.min(3, targetWidth / base.width));
          const viewport = page.getViewport({ scale });

          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-page';
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.setAttribute('aria-label', `${filename} 第 ${pageNumber} 页`);

          const context = canvas.getContext('2d');
          if (!context) throw new Error('无法创建画布上下文');

          container.appendChild(canvas);
          await page.render({ canvasContext: context, viewport }).promise;
        }

        if (!cancelled) setStatus('ready');
      } catch (caught) {
        if (cancelled) return;
        setError((caught as Error).message);
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [dataBase64, filename]);

  return (
    <div className="pdf-viewer">
      {status === 'loading' ? <p className="hint">正在渲染 PDF…</p> : null}
      {status === 'error' ? (
        <p className="error-banner">PDF 预览失败：{error ?? '未知错误'}</p>
      ) : null}
      <div ref={containerRef} className="pdf-pages" />
      {status === 'ready' && pages > MAX_PAGES ? (
        <p className="hint">为控制内存，仅渲染前 {MAX_PAGES} 页（共 {pages} 页）。</p>
      ) : null}
    </div>
  );
}
