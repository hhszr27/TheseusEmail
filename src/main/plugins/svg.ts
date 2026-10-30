/**
 * 插件 SVG 图标净化（§13.6）。
 *
 * 图标最终以 data:image/svg+xml 形式放进 <img>，脚本不会执行；
 * 仍先剥离 <script>、<foreignObject>、on* 属性与 javascript: 链接，
 * 避免污染 DOM 内联使用或未来被误用。
 */

export interface SvgSanitizeResult {
  ok: boolean;
  svg: string;
  reason?: string;
}

const MAX_SVG_BYTES = 100 * 1024;

function stripBlocks(input: string, tag: string): string {
  const pattern = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi');
  let output = input;
  // 处理嵌套/连续块，最多迭代 8 次，避免恶意深层嵌套
  for (let index = 0; index < 8; index += 1) {
    const next = output.replace(pattern, '');
    if (next === output) break;
    output = next;
  }
  return output;
}

export function sanitizePluginSvg(raw: string): SvgSanitizeResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SVG_BYTES) {
    return { ok: false, svg: '', reason: 'SVG 超过 100 KB 上限' };
  }

  let svg = raw.trim();
  if (!/^<svg[\s>]/i.test(svg)) {
    return { ok: false, svg: '', reason: '文件不是以 <svg> 开头' };
  }

  svg = stripBlocks(svg, 'script');
  svg = stripBlocks(svg, 'foreignObject');
  svg = stripBlocks(svg, 'style');
  svg = svg.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, '');
  svg = svg.replace(/<(object|embed)\b[^>]*\/?>/gi, '');

  // 事件属性：onclick="..." / onload='...' / onerror=foo
  svg = svg.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // javascript: 链接
  svg = svg.replace(
    /\s(href|xlink:href|src)\s*=\s*("[^"]*javascript:[^"]*"|'[^']*javascript:[^']*')/gi,
    '',
  );

  // 去除注释中的条件注释技巧
  svg = svg.replace(/<!--[\s\S]*?-->/g, '');

  return { ok: true, svg };
}

export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}
