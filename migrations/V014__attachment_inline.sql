-- 正文内嵌图（签名 Logo、正文里的图片）不应出现在附件列表里。
-- 之前只能靠「请求附件列表时正文是否已缓存 + cid 是否匹配」在运行时判断，
-- 首次打开邮件（正文尚未缓存）时会把它们当成普通附件列出来；改为解析时落库标记。
ALTER TABLE attachments ADD COLUMN inline INTEGER NOT NULL DEFAULT 0;

-- 存量数据回填：只标记「带 Content-ID 且正文确实用 cid: 引用了它」的图片，
-- 避免把用户真的附了一张带 Content-ID 的图片误藏起来。
UPDATE attachments
SET inline = 1
WHERE mime_type LIKE 'image/%'
  AND content_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM email_bodies b
    WHERE b.email_id = attachments.email_id
      AND b.html LIKE '%cid:' || attachments.content_id || '%'
  );

-- 只含内嵌图的邮件不再显示回形针。
-- 有真实附件、或还没抓过正文（没有附件行）的邮件保持原样。
UPDATE emails
SET has_attachments = 0
WHERE has_attachments = 1
  AND EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = emails.id)
  AND NOT EXISTS (
    SELECT 1 FROM attachments a WHERE a.email_id = emails.id AND a.inline = 0
  );
