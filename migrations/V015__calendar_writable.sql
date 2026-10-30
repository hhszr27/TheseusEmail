-- V015：本地新建的日历事件可以写回服务器。
-- ICS 订阅永远只读（只是抓一个 .ics 文件），CalDAV 才可写。
UPDATE calendar_accounts SET read_only = 0 WHERE kind = 'caldav';
