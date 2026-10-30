import type { ConflictCode } from '../../shared/types';

/**
 * 冲突码 → 用户文案（§8.5、§8.6）。
 * 关键：folderGone 的 move 冲突不能显示"重试"，要明确告诉用户邮件仍在哪个文件夹。
 */

export type ConflictResolution = 'retry' | 'keep' | 'dismiss';

export interface ConflictDescription {
  message: string;
  resolution: ConflictResolution;
}

export function describeConflict(
  code: ConflictCode,
  payload: Record<string, unknown> = {},
): ConflictDescription {
  const folder = typeof payload.folder === 'string' ? payload.folder : '原文件夹';

  switch (code) {
    case 'folderGone':
      return {
        message: `目标文件夹已不存在，邮件保留在「${folder}」`,
        resolution: 'keep',
      };
    case 'messageGone':
      return {
        message: '邮件已被删除，本次操作无法完成',
        resolution: 'dismiss',
      };
    case 'forbidden':
      return {
        message: '服务器拒绝该操作（权限不足），未做任何修改',
        resolution: 'dismiss',
      };
    case 'quota':
      return {
        message: '邮箱空间不足，请清理后重试',
        resolution: 'retry',
      };
    case 'tooLarge':
      return {
        message: '邮件或附件超过服务商大小限制',
        resolution: 'dismiss',
      };
    case 'stateConflict':
      return {
        message: '邮件状态已在其他设备上变化，请刷新后重试',
        resolution: 'retry',
      };
    default:
      return { message: '操作失败，请稍后重试', resolution: 'retry' };
  }
}
