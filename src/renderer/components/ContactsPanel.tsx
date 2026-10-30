import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContactSuggestion } from '../../shared/ipc';

/**
 * 联系人视图（右侧主区域，不弹窗）。
 *
 * 数据来自本地邮件历史（contacts 表，按交互频率排序），只读展示 + 搜索；
 * 点「写信」直接把邮箱塞进撰写弹层并回到邮件视图。不做通讯录增删改 ——
 * 这里只解决「我知道这个人，想快速找到邮箱并写一封」这个场景。
 */
interface ContactsPanelProps {
  /** 返回邮件（右上角「返回邮件」按钮 / Esc）。 */
  onBack(): void;
  onCompose(email: string, displayName: string | null): void;
}

export function ContactsPanel({ onBack, onCompose }: ContactsPanelProps): JSX.Element {
  const [contacts, setContacts] = useState<ContactSuggestion[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.api.listContacts(500).then((result) => {
      if (cancelled) return;
      if (result.ok) setContacts(result.data);
      else setError(result.error.message);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => searchRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onBack]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter(
      (contact) =>
        contact.email.toLowerCase().includes(needle) ||
        (contact.displayName ?? '').toLowerCase().includes(needle),
    );
  }, [contacts, query]);

  return (
    <section className="main-view contacts-view" aria-label="联系人">
      <header className="view-header">
        <div>
          <h1 className="view-title" id="contacts-title">
            联系人
          </h1>
          <p className="hint">来自本地收发记录，按往来频率排序。</p>
        </div>
        <button type="button" className="btn" onClick={onBack}>
          返回邮件
        </button>
      </header>

      <div className="view-body contacts-body">
        <input
          ref={searchRef}
          className="input contacts-search"
          type="search"
          placeholder="搜索姓名或邮箱"
          aria-label="搜索联系人"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />

        {error ? <p className="error-banner">{error}</p> : null}
        {loading ? <p className="hint">正在读取联系人…</p> : null}
        {!loading && filtered.length === 0 ? (
          <p className="hint">
            {contacts.length === 0
              ? '还没有联系人记录。收发邮件后会自动收集，之后可以在这里快速找到对方。'
              : '没有匹配的联系人。'}
          </p>
        ) : null}

        {filtered.length > 0 ? (
          <ul className="contacts-list" aria-label="联系人列表">
            {filtered.map((contact) => {
              const label = contact.displayName || contact.email;
              return (
                <li className="contact-row" key={contact.email}>
                  <span className="contact-avatar" aria-hidden="true">
                    {label.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="contact-main">
                    <span className="contact-name">{label}</span>
                    {contact.displayName ? (
                      <span className="contact-email">{contact.email}</span>
                    ) : null}
                  </span>
                  <span className="contact-count" title="往来邮件数">
                    {contact.interactionCount} 次
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      onCompose(contact.email, contact.displayName);
                      // 撰写弹层挂在邮件视图上，写完信要能看见它
                      onBack();
                    }}
                  >
                    写信
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
