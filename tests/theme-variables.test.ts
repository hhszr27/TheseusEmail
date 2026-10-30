import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_VARIABLES,
  LIGHT_THEME_VARIABLES,
  themeVariablesFor,
} from '../src/shared/theme';

/**
 * 插件视图拿不到宿主 DOM，只能靠 getThemeVariables() 下发变量。
 * 曾经无论宿主明暗都返回深色集合，导致浅色界面里弹出一块深色面板。
 */
describe('插件主题变量', () => {
  it('两套变量的键完全一致（缺键会让面板残留上一个主题的颜色）', () => {
    expect(Object.keys(LIGHT_THEME_VARIABLES).sort()).toEqual(
      Object.keys(DEFAULT_THEME_VARIABLES).sort(),
    );
  });

  it('未设置 / builtin:light 下发浅色（v3.3 默认主题）', () => {
    expect(themeVariablesFor(null)).toBe(LIGHT_THEME_VARIABLES);
    expect(themeVariablesFor(undefined)).toBe(LIGHT_THEME_VARIABLES);
    expect(themeVariablesFor('builtin:light')).toBe(LIGHT_THEME_VARIABLES);
    expect(LIGHT_THEME_VARIABLES['--mf-color-bg']).toBe('#f3f4f6');
  });

  it('builtin:dark 与插件主题下发深色', () => {
    expect(themeVariablesFor('builtin:dark')).toBe(DEFAULT_THEME_VARIABLES);
    expect(themeVariablesFor('theme-nord')).toBe(DEFAULT_THEME_VARIABLES);
    expect(DEFAULT_THEME_VARIABLES['--mf-color-bg']).toBe('#0f1419');
  });
});
