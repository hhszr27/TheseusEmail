/**
 * IMAP 命令失败的报文提取。
 *
 * imapflow 对服务器返回的 `NO`/`BAD` 只抛一个 `Error('Command failed')`，
 * 真正的服务器原因藏在 `responseStatus` / `responseText` / `response.attributes` 里。
 * 不把这些带出来，用户界面上就只剩一句「Command failed」，既看不懂也没法排查。
 *
 * 纯函数、无依赖，便于单测（worker 模块本身在 import 时就要 parentPort，不能直接测）。
 */

export interface ImapCommandFailure {
  message?: string;
  /** 服务器对命令的状态：NO / BAD / BYE。 */
  responseStatus?: string;
  /** 部分 imapflow 路径直接给出的人读文本。 */
  responseText?: string;
  /** 解析后的服务器响应（tagged 失败时才有）。 */
  response?: { attributes?: Array<{ value?: unknown }> };
}

/** 服务器拒绝打开该文件夹（多为 \Noselect 容器目录，或已被删除/改名）。 */
export function isFolderUnselectable(error: unknown): boolean {
  return (error as ImapCommandFailure | null)?.responseStatus === 'NO';
}

/** 把 IMAP 失败的服务器原文拼进错误文案，避免只显示「Command failed」。 */
export function imapFailureText(error: unknown): string {
  const failure = (error ?? {}) as ImapCommandFailure;
  const base =
    typeof failure.message === 'string' && failure.message ? failure.message : String(error);
  const status = typeof failure.responseStatus === 'string' ? failure.responseStatus : '';
  const text = responseTextOf(failure);

  if (status && text) return `${base}（${status}: ${text}）`;
  if (text && text !== base) return `${base}（${text}）`;
  return base;
}

function responseTextOf(failure: ImapCommandFailure): string {
  if (typeof failure.responseText === 'string' && failure.responseText.trim()) {
    return failure.responseText.trim();
  }
  const attributes = failure.response?.attributes;
  if (!Array.isArray(attributes)) return '';
  return attributes
    .map((attribute) => (typeof attribute?.value === 'string' ? attribute.value.trim() : ''))
    .filter(Boolean)
    .join(' ');
}
