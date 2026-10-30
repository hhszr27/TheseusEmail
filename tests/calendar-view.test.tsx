// @vitest-environment jsdom
/**
 * 日历必须内嵌在右侧主区域，而不是弹窗。
 *
 * 用户明确要求「点日历后右边变成日历，而不是弹窗窗口」。这里锁住两条：
 *  1) 渲染结果里没有 .overlay / .modal，只有 .main-view.calendar-view；
 *  2) 「返回邮件」按钮回调 onBack。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import { CalendarPanel } from '../src/renderer/components/CalendarPanel';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

let container: HTMLDivElement;
let root: Root;
let createdPayloads: Array<Record<string, unknown>>;
/** app_settings 里的工作时间原文（null = 没设置过 → 默认 9–18）。 */
let workHoursValue: string | null;
/** 时间格式设置原文（null = 没设置过 → 24 小时制）。 */
let timeFormatValue: string | null;
/** 当前返回的事件列表（用于「点击事件打开编辑」等用例）。 */
let eventsFixture: Array<Record<string, unknown>>;
let updatedPatches: Array<Record<string, unknown>>;
let deletedIds: string[];
/** 删除请求原文（用于断言 scope / occurrenceStart）。 */
let deletedRequests: Array<Record<string, unknown>>;

/** React 受控输入：走原生 setter 再派发 input 事件。 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** React 受控 select：走原生 setter 再派发 change 事件。 */
function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function mount(onBack: () => void): Promise<void> {
  await act(async () => {
    root.render(createElement(CalendarPanel, { onBack }));
  });
}

/** 今天 14:00 的本地事件（保证落在当前月视图的 42 格内）。 */
function localEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date();
  const startsAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 0).getTime();
  return {
    id: 'local-1',
    calendarId: 'local',
    uid: 'u',
    summary: '项目评审',
    startsAt,
    endsAt: startsAt + 60 * 60 * 1000,
    allDay: false,
    kind: 'meeting',
    location: '会议室',
    ...overrides,
  };
}

/** 双击某个事件块打开编辑弹窗（单击只定位，不弹窗）。 */
function openEvent(summary: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('.calendar-event')].find(
    (item) => item.textContent?.includes(summary),
  );
  expect(button, `找不到事件：${summary}`).toBeTruthy();
  act(() => {
    button!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  (window as unknown as { api: unknown }).api = {
    getSetting: async (key: string) => ({
      ok: true,
      data: key === 'calendar.timeFormat' ? timeFormatValue : workHoursValue,
    }),
    setSetting: async () => ({ ok: true, data: true }),
    listCalendarEvents: async () => ({ ok: true, data: eventsFixture }),
    listCalendarAccounts: async () => ({ ok: true, data: [] }),
    syncCalendar: async () => ({ ok: true, data: [] }),
    addCalendarAccount: async () => ({ ok: true, data: { id: 'cal-1' } }),
    removeCalendarAccount: async () => ({ ok: true, data: true }),
    createCalendarEvent: async (input: Record<string, unknown>) => {
      createdPayloads.push(input);
      return { ok: true, data: { id: 'local-1', calendarId: 'local', uid: 'u', summary: '', startsAt: 0, endsAt: 0, allDay: false } };
    },
    updateCalendarEvent: async (patch: Record<string, unknown>) => {
      updatedPatches.push(patch);
      return {
        ok: true,
        data: { id: String(patch.id), calendarId: 'local', uid: 'u', summary: '', startsAt: 0, endsAt: 0, allDay: false },
      };
    },
    deleteCalendarEvent: async (request: Record<string, unknown>) => {
      deletedIds.push(String(request.id));
      deletedRequests.push(request);
      return { ok: true, data: true };
    },
  };
  createdPayloads = [];
  workHoursValue = null;
  timeFormatValue = null;
  eventsFixture = [];
  updatedPatches = [];
  deletedIds = [];
  deletedRequests = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('日历视图', () => {
  it('内嵌在右侧主区域，没有弹窗遮罩', async () => {
    await mount(() => undefined);

    expect(container.querySelector('.overlay')).toBeNull();
    expect(container.querySelector('.modal')).toBeNull();

    const view = container.querySelector('.main-view.calendar-view');
    expect(view).not.toBeNull();
    expect(view?.querySelector('.view-title')?.textContent).toContain('日历');
    expect(container.querySelector('.calendar-grid')).not.toBeNull();
  });

  it('点「返回邮件」触发 onBack', async () => {
    let backed = 0;
    await mount(() => {
      backed += 1;
    });

    const back = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('返回邮件'),
    );
    expect(back).toBeTruthy();
    act(() => {
      back!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(backed).toBe(1);
  });

  it('「今天」按钮把视图拉回当前月份', async () => {
    await mount(() => undefined);
    const monthTitle = (): string =>
      container.querySelector('.calendar-toolbar strong')?.textContent?.trim() ?? '';

    const now = new Date();
    const thisMonth = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月`;
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonth = `${next.getFullYear()} 年 ${next.getMonth() + 1} 月`;

    expect(monthTitle()).toBe(thisMonth);

    const nextBtn = container.querySelector<HTMLButtonElement>('button[aria-label="下个月"]');
    expect(nextBtn).not.toBeNull();
    act(() => {
      nextBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(monthTitle()).toBe(nextMonth);

    const today = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '今天',
    );
    expect(today).toBeTruthy();
    act(() => {
      today!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(monthTitle()).toBe(thisMonth);
  });

  it('上/下月是纯图标按钮（无障碍名保留）', async () => {
    await mount(() => undefined);

    const prev = container.querySelector<HTMLButtonElement>('button[aria-label="上个月"]');
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="下个月"]');
    expect(prev?.querySelector('svg')).not.toBeNull();
    expect(next?.querySelector('svg')).not.toBeNull();
    // 不再有「上个月 / 下个月」文字
    expect(prev?.textContent?.trim()).toBe('');
    expect(next?.textContent?.trim()).toBe('');
  });

  async function switchToWeek(): Promise<void> {
    const week = [...container.querySelectorAll<HTMLButtonElement>('.calendar-mode')].find(
      (button) => button.textContent?.trim() === '周',
    );
    expect(week).toBeTruthy();
    await act(async () => {
      week!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // 切视图会重新 load(events)；只等一个 microtask 不够，事件还没回来
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** 周视图里跳到本周（cursor 初始是月初，不一定包含今天）。 */
  async function goToday(): Promise<void> {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === '今天',
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('月 / 周 可切换，周视图是 7 列 × 48 个半小时格', async () => {
    await mount(() => undefined);
    expect(container.querySelector('.calendar-grid')).not.toBeNull();
    expect(container.querySelector('.calendar-time')).toBeNull();

    await switchToWeek();

    expect(container.querySelector('.calendar-time')).not.toBeNull();
    expect(container.querySelector('.calendar-grid')).toBeNull();
    expect(container.querySelectorAll('.calendar-time-col')).toHaveLength(7);
    // 每天 24 小时 × 上下两个半小时 = 48 格
    expect(container.querySelectorAll('.calendar-half-hour')).toHaveLength(7 * 48);
  });

  it('周视图单击列头选中一整天', async () => {
    await mount(() => undefined);
    await switchToWeek();

    const head = container.querySelectorAll('.calendar-time-dayhead')[0] as HTMLElement;
    const col = container.querySelectorAll('.calendar-time-col')[0] as HTMLElement;
    act(() => {
      head.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(head.className).toContain('is-selected');
    expect(col.className).toContain('is-selected');
  });

  it('周视图单击半小时格：只选中该格，不选整天', async () => {
    await mount(() => undefined);
    await switchToWeek();

    const slot = container.querySelector<HTMLElement>(
      '.calendar-half-hour[data-hour="14"][data-minute="30"]',
    )!;
    const col = slot.closest('.calendar-time-col') as HTMLElement;
    expect(col.className).not.toContain('is-selected');

    act(() => {
      slot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(slot.className).toContain('is-selected');
    expect(slot.getAttribute('aria-selected')).toBe('true');
    // 关键：单击不能冒泡成「选了这一天」，否则蓝框又回到整列上
    expect(col.className).not.toContain('is-selected');
  });

  it('非工作小时灰底：默认 9–18 之外都灰', async () => {
    await mount(() => undefined);
    await switchToWeek();
    // 0–8 共 9 小时 + 18–23 共 6 小时 = 15 小时/天，每小时两个半小时格
    expect(container.querySelectorAll('.calendar-half-hour.is-off-hours')).toHaveLength(
      15 * 2 * 7,
    );
  });

  it('灰底跟随设置的工作时间（10–12）', async () => {
    workHoursValue = '10-12';
    await mount(() => undefined);
    await switchToWeek();
    // 工作时间只有 2 小时，其余 22 小时都灰
    expect(container.querySelectorAll('.calendar-half-hour.is-off-hours')).toHaveLength(
      22 * 2 * 7,
    );
  });

  it('12 小时制下时间轴显示 AM/PM', async () => {
    timeFormatValue = '12';
    await mount(() => undefined);
    await switchToWeek();

    const labels = [...container.querySelectorAll('.calendar-time-label')].map((element) =>
      element.textContent?.trim(),
    );
    expect(labels).toHaveLength(24);
    expect(labels[0]).toBe('12 AM');
    expect(labels[12]).toBe('12 PM');
    expect(labels[14]).toBe('2 PM');
  });

  it('12 小时制下事件时刻显示 PM', async () => {
    const now = new Date();
    const startsAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 30).getTime();
    eventsFixture = [localEvent({ startsAt, endsAt: startsAt + 60 * 60 * 1000 })];
    timeFormatValue = '12';
    await mount(() => undefined);
    await switchToWeek();
    // cursor 初始在月初，先跳到本周才能看到今天 14:30 的事件
    await goToday();

    const time = container.querySelector('.calendar-time-event-time')?.textContent?.trim();
    expect(time).toBe('2:30 PM');
  });

  it('设置变化广播后，已挂载的日历立即切换时间格式', async () => {
    await mount(() => undefined);
    await switchToWeek();
    expect(container.querySelector('.calendar-time-label')?.textContent?.trim()).toBe('00:00');

    // 用户在设置页改了格式：同窗口事件应让已经挂载的日历立刻跟着变
    act(() => {
      window.dispatchEvent(new CustomEvent('mf:time-format-changed', { detail: '12' }));
    });

    expect(container.querySelector('.calendar-time-label')?.textContent?.trim()).toBe('12 AM');
  });

  it('周视图双击半小时格，新建窗口默认落在该半小时', async () => {
    await mount(() => undefined);
    await switchToWeek();

    const slot = container.querySelector<HTMLElement>(
      '.calendar-half-hour[data-hour="14"][data-minute="30"]',
    );
    expect(slot).not.toBeNull();
    act(() => {
      slot!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(container.querySelector('.calendar-dialog')).not.toBeNull();
    const startHour = container.querySelector<HTMLSelectElement>('select[aria-label="开始时间-小时"]');
    const startMinute = container.querySelector<HTMLSelectElement>('select[aria-label="开始时间-分钟"]');
    const endHour = container.querySelector<HTMLSelectElement>('select[aria-label="结束时间-小时"]');
    const endMinute = container.querySelector<HTMLSelectElement>('select[aria-label="结束时间-分钟"]');
    expect([startHour?.value, startMinute?.value]).toEqual(['14', '30']);
    expect([endHour?.value, endMinute?.value]).toEqual(['15', '30']);
  });

  it('单击日期选中', async () => {
    await mount(() => undefined);
    const cell = container.querySelectorAll('.calendar-cell')[10] as HTMLElement;
    expect(cell.className).not.toContain('is-selected');

    act(() => {
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(cell.className).toContain('is-selected');
    expect(cell.getAttribute('aria-selected')).toBe('true');
  });

  it('双击日期打开新建弹窗，含四种类型', async () => {
    await mount(() => undefined);
    expect(container.querySelector('.calendar-dialog')).toBeNull();

    const cell = container.querySelectorAll('.calendar-cell')[10];
    act(() => {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(container.querySelector('.calendar-dialog')).not.toBeNull();
    const kinds = [...container.querySelectorAll('.calendar-kind-tab')].map((button) =>
      button.textContent?.trim(),
    );
    expect(kinds).toEqual(['日程', '会议', '纪念日', '生日']);
  });

  it('弹窗提交时带上类型与标题，成功后关闭', async () => {
    await mount(() => undefined);
    const cell = container.querySelectorAll('.calendar-cell')[10];
    act(() => {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const title = container.querySelector<HTMLInputElement>('input[aria-label="标题"]')!;
    act(() => setInputValue(title, '项目评审'));

    const meeting = [...container.querySelectorAll<HTMLButtonElement>('.calendar-kind-tab')].find(
      (button) => button.textContent?.trim() === '会议',
    )!;
    act(() => {
      meeting.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '保存',
    )!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]).toMatchObject({
      kind: 'meeting',
      summary: '项目评审',
      allDay: false,
    });
    expect(container.querySelector('.calendar-dialog')).toBeNull();
  });

  it('单击事件只定位，不打开弹窗', async () => {
    eventsFixture = [localEvent()];
    await mount(() => undefined);

    const button = [...container.querySelectorAll<HTMLButtonElement>('.calendar-event')].find(
      (item) => item.textContent?.includes('项目评审'),
    )!;
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.calendar-dialog')).toBeNull();
  });

  it('双击本地事件打开编辑弹窗并回填字段', async () => {
    eventsFixture = [localEvent()];
    await mount(() => undefined);

    openEvent('项目评审');

    const dialog = container.querySelector('.calendar-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('.modal-title')?.textContent).toBe('编辑');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="标题"]')?.value).toBe(
      '项目评审',
    );
    const dialogStartHour = container.querySelector<HTMLSelectElement>(
      'select[aria-label="开始时间-小时"]',
    );
    const dialogStartMinute = container.querySelector<HTMLSelectElement>(
      'select[aria-label="开始时间-分钟"]',
    );
    expect([dialogStartHour?.value, dialogStartMinute?.value]).toEqual(['14', '0']);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="地点"]')?.value).toBe(
      '会议室',
    );
  });

  it('编辑保存调用 updateCalendarEvent，而不是再新建一条', async () => {
    eventsFixture = [localEvent()];
    await mount(() => undefined);
    openEvent('项目评审');

    const title = container.querySelector<HTMLInputElement>('input[aria-label="标题"]')!;
    act(() => setInputValue(title, '项目评审（改）'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '保存',
    )!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(updatedPatches).toHaveLength(1);
    expect(updatedPatches[0]).toMatchObject({ id: 'local-1', summary: '项目评审（改）' });
    expect(createdPayloads).toHaveLength(0);
    expect(container.querySelector('.calendar-dialog')).toBeNull();
  });

  it('删除需要二次确认，确认后才调用 deleteCalendarEvent', async () => {
    eventsFixture = [localEvent()];
    await mount(() => undefined);
    openEvent('项目评审');

    const first = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '删除',
    )!;
    act(() => {
      first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 第一次点击只是把按钮变成「确认删除？」，不能真删
    expect(deletedIds).toEqual([]);

    const confirm = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '确认删除？',
    );
    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(deletedIds).toEqual(['local-1']);
    expect(container.querySelector('.calendar-dialog')).toBeNull();
  });

  it('远程订阅事件双击也不打开编辑（只读）', async () => {
    eventsFixture = [
      localEvent({ id: 'acc-1|/cal/x.ics|1', calendarId: 'acc-1', summary: '远程会议' }),
    ];
    await mount(() => undefined);

    openEvent('远程会议');

    expect(container.querySelector('.calendar-dialog')).toBeNull();
  });

  it('24 小时制下新建弹窗的时间控件是 00–23，且没有 AM/PM', async () => {
    await mount(() => undefined);
    const cell = container.querySelectorAll('.calendar-cell')[10];
    act(() => {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const hour = container.querySelector<HTMLSelectElement>('select[aria-label="开始时间-小时"]');
    expect(hour).not.toBeNull();
    // 默认 9:00，24 小时制就是 9，不是 09 AM
    expect(hour?.value).toBe('9');
    const values = [...hour!.options].map((option) => option.value);
    expect(values).toHaveLength(24);
    expect(values[0]).toBe('0');
    expect(values[23]).toBe('23');
    expect(container.querySelector('select[aria-label="开始时间-时段"]')).toBeNull();
  });

  it('12 小时制下新建弹窗用 1–12 + AM/PM', async () => {
    timeFormatValue = '12';
    await mount(() => undefined);
    const cell = container.querySelectorAll('.calendar-cell')[10];
    act(() => {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const hour = container.querySelector<HTMLSelectElement>('select[aria-label="开始时间-小时"]');
    const values = [...hour!.options].map((option) => option.value);
    expect(values).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    expect(hour?.value).toBe('9');
    expect(container.querySelector('select[aria-label="开始时间-时段"]')).not.toBeNull();
  });

  it('新建时选择重复频率，保存带上 rrule', async () => {
    await mount(() => undefined);
    const cell = container.querySelectorAll('.calendar-cell')[10];
    act(() => {
      cell.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const title = container.querySelector<HTMLInputElement>('input[aria-label="标题"]')!;
    act(() => setInputValue(title, '每周站会'));

    const repeat = container.querySelector<HTMLSelectElement>('select[aria-label="重复"]');
    expect(repeat).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )?.set;
      setter?.call(repeat, 'WEEKLY');
      repeat!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '保存',
    )!;
    await act(async () => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createdPayloads[0]).toMatchObject({ rrule: { freq: 'WEEKLY', interval: 1 } });
  });

  it('编辑重复事件时回填重复频率', async () => {
    eventsFixture = [localEvent({ rrule: { freq: 'WEEKLY', interval: 1 } })];
    await mount(() => undefined);
    openEvent('项目评审');

    const repeat = container.querySelector<HTMLSelectElement>('select[aria-label="重复"]');
    expect(repeat?.value).toBe('WEEKLY');
  });

  it('删除重复事件时弹出 6 种范围，按所选范围提交', async () => {
    const fixture = localEvent({ rrule: { freq: 'WEEKLY', interval: 1 } });
    eventsFixture = [fixture];
    await mount(() => undefined);
    openEvent('项目评审');

    const del = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '删除',
    )!;
    act(() => {
      del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.calendar-scope-dialog')).not.toBeNull();
    const labels = [...container.querySelectorAll('.calendar-scope-option')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual([
      '仅删除这个',
      '删除这个和之后的',
      '删除之后的',
      '删除之前的',
      '删除之前和这个',
      '删除全部',
    ]);

    const onlyThis = [...container.querySelectorAll<HTMLButtonElement>('.calendar-scope-option')].find(
      (button) => button.textContent?.trim() === '仅删除这个',
    )!;
    await act(async () => {
      onlyThis.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(deletedRequests[0]).toMatchObject({ scope: 'this' });
    expect(deletedRequests[0]?.occurrenceStart).toBe(fixture.startsAt);
  });

  it('修改重复事件时间时弹出 3 种范围（仅此 / 此及后续 / 全部）', async () => {
    const fixture = localEvent({ rrule: { freq: 'WEEKLY', interval: 1 } });
    eventsFixture = [fixture];
    await mount(() => undefined);
    openEvent('项目评审');

    const startHour = container.querySelector<HTMLSelectElement>(
      'select[aria-label="开始时间-小时"]',
    )!;
    // 13:00 仍在结束时间（15:00）之前，避免先触发「结束要晚于开始」的校验
    act(() => setSelectValue(startHour, '13'));

    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === '保存',
    )!;
    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const labels = [...container.querySelectorAll('.calendar-scope-option')].map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).toEqual(['仅修改这个', '修改这个和之后的', '修改全部（整个系列）']);

    const onlyThis = [...container.querySelectorAll<HTMLButtonElement>('.calendar-scope-option')].find(
      (button) => button.textContent?.trim() === '仅修改这个',
    )!;
    await act(async () => {
      onlyThis.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(updatedPatches[0]).toMatchObject({ scope: 'this' });
    expect(updatedPatches[0]?.occurrenceStart).toBe(fixture.startsAt);
  });
});
