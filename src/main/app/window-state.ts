import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../observability/logger';
import {
  defaultWindowState,
  normalizeWindowBounds,
  type SavedWindowState,
} from './window-bounds';

const STATE_FILE = 'window-state.json';

function stateFilePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

export function loadWindowState(): SavedWindowState {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SavedWindowState>;
    if (
      typeof parsed.width !== 'number' ||
      typeof parsed.height !== 'number' ||
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number'
    ) {
      return defaultWindowState();
    }
    return {
      x: parsed.x,
      y: parsed.y,
      width: parsed.width,
      height: parsed.height,
      isMaximized: parsed.isMaximized === true,
    };
  } catch {
    return defaultWindowState();
  }
}

function persist(state: SavedWindowState): void {
  try {
    fs.mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    log.warn('window-state', '保存窗口状态失败', { message: (error as Error).message });
  }
}

export function restoreWindowBounds(window: BrowserWindow): void {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const primaryIndex = Math.max(
    0,
    displays.findIndex((display) => display.id === primary.id),
  );

  const normalized = normalizeWindowBounds(
    loadWindowState(),
    displays.map((display) => ({ bounds: display.bounds, workArea: display.workArea })),
    primaryIndex,
  );

  window.setBounds(normalized.bounds);
  if (normalized.isMaximized) window.maximize();

  if (normalized.relocated) {
    log.info('window-state', '保存的位置不在可见区域，已重新居中');
  }
}

export function trackWindowState(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;

  const save = (): void => {
    if (window.isDestroyed()) return;
    const normal = window.getNormalBounds();
    persist({
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      isMaximized: window.isMaximized(),
    });
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
