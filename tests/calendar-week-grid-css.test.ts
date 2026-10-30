import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 周视图的**视觉**契约（jsdom 不绘制，渲染测试只能查 class，查不出"框画不出来"）。
 *
 * 两个曾经踩过 / 极易退回的点：
 *  1) 选中蓝框如果用 `.calendar-time-col.is-selected { box-shadow: inset ... }`，
 *     会被内部不透明的半小时格整片盖住 —— 表现就是「周视图点了没有蓝框、月视图有」。
 *     必须用 `::after` 覆盖层（或 outline）。
 *  2) 一小时拆成上下两半后，整点与半点要用不同线型，否则看不出分割。
 */
const css = readFileSync(path.join(process.cwd(), 'src/renderer/styles.css'), 'utf8');

function ruleBody(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `缺少样式规则：${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  expect(open).toBeGreaterThanOrEqual(0);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

describe('周视图网格样式', () => {
  it('选中框用覆盖层 ::after，而不是会被子格遮住的 inset 阴影', () => {
    const body = ruleBody('.calendar-time-col.is-selected::after');
    expect(body).toContain('position: absolute');
    expect(body).toContain('box-shadow: inset');
    expect(body).toContain('pointer-events: none');
  });

  it('半小时格用整点实线 + 半点虚线区分上下两半', () => {
    expect(ruleBody('.calendar-half-hour.is-hour')).toContain('solid');
    expect(ruleBody('.calendar-half-hour.is-half')).toContain('dashed');
  });

  it('非工作时段用灰色底', () => {
    const body = ruleBody('.calendar-half-hour.is-off-hours');
    expect(body).toContain('background');
    expect(body).toContain('--mf-color-bg');
  });
});
