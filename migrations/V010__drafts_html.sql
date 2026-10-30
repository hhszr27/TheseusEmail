-- 富文本写信（Part A）：本地草稿增加 html 字段。
-- 用 NOT NULL DEFAULT '' 兼容已存在的草稿行，旧行 html 为空串。
ALTER TABLE drafts ADD COLUMN body_html TEXT NOT NULL DEFAULT '';
