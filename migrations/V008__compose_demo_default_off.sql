-- 示例插件 compose-note 会整体接管撰写窗口，宿主写信表单被完全遮住。
-- 它的清单已改为 defaultEnabled = false；这里把已有安装一次性关闭，
-- 让「撰写邮件」默认回到宿主界面（用户仍可在插件页重新启用）。
UPDATE plugins SET enabled = 0 WHERE id = 'compose-note';
