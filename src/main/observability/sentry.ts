import * as Sentry from '@sentry/electron/main';
import { app } from 'electron';
import { log, redact } from './logger';

/**
 * 崩溃报告（§25.1 / §25.6）。
 *  - 未配置 DSN 时完全关闭，默认不收集任何遥测
 *  - beforeSend 统一剥离邮件内容、附件数据、凭据
 */

const SENSITIVE_HEADER = /(authorization|cookie|token|key|secret)/i;

interface ScrubbableEvent {
  request?: {
    data?: unknown;
    cookies?: unknown;
    headers?: Record<string, string>;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  breadcrumbs?: Array<{ data?: Record<string, unknown> }>;
}

function scrubEvent<T>(event: T): T {
  const record = event as T & ScrubbableEvent;

  if (record.request) {
    delete record.request.data;
    delete record.request.cookies;
    if (record.request.headers) {
      for (const key of Object.keys(record.request.headers)) {
        if (SENSITIVE_HEADER.test(key)) {
          delete record.request.headers[key];
        }
      }
    }
  }

  if (record.extra) {
    record.extra = redact(record.extra) as Record<string, unknown>;
  }

  if (record.contexts) {
    record.contexts = redact(record.contexts) as Record<string, unknown>;
  }

  if (record.breadcrumbs) {
    record.breadcrumbs = record.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      ...(breadcrumb.data
        ? { data: redact(breadcrumb.data) as Record<string, unknown> }
        : {}),
    }));
  }

  return event;
}

let initialized = false;

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    log.info('sentry', '未配置 SENTRY_DSN，崩溃上报保持关闭');
    return false;
  }

  Sentry.init({
    dsn,
    release: `${app.getName()}@${app.getVersion()}`,
    environment: app.isPackaged ? 'production' : 'development',
    beforeSend(event) {
      return scrubEvent(event);
    },
  });

  initialized = true;
  log.info('sentry', '崩溃上报已启用');
  return true;
}

export function captureCrash(message: string, detail: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.captureException(new Error(message), {
    extra: redact(detail) as Record<string, unknown>,
  });
}

export function isSentryEnabled(): boolean {
  return initialized;
}
