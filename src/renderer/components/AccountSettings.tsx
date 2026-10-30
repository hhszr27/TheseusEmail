import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AccountRuntimeStatus, AccountView, DownloadPreference } from '../../shared/types';
import {
  PROVIDER_PRESETS,
  presetById,
  type AccountInput,
} from '../../shared/accounts';
import { useMailStore } from '../stores/mail-store';

const STATUS_LABEL: Record<AccountRuntimeStatus, string> = {
  active: '活跃',
  first_sync: '首次同步',
  syncing: '同步中',
  offline: '离线',
  requires_reauth: '需重新登录',
  disabled: '已禁用',
  error: '同步失败',
};

/** 下载首选项选项（对齐 Outlook）：控制 IMAP 同步时正文的抓取范围。 */
const DOWNLOAD_PREFERENCE_OPTIONS: Array<{ value: DownloadPreference; label: string }> = [
  { value: 'entire', label: '下载整个项目' },
  { value: 'headers-then-item', label: '先下载邮件头，然后下载整个项目' },
  { value: 'headers-only', label: '下载邮件头' },
  { value: 'headers-only-slow', label: '低速连接时仅下载邮件头' },
];

interface FormState {
  displayName: string;
  email: string;
  password: string;
  providerPreset: string;
  imapHost: string;
  imapPort: string;
  imapSecure: boolean;
  smtpEnabled: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: boolean;
  color: string;
  downloadPreference: DownloadPreference;
}

function formFromAccount(account: AccountView): FormState {
  return {
    displayName: account.displayName,
    email: account.email,
    password: '',
    providerPreset: account.providerPreset ?? 'custom',
    imapHost: account.imapHost ?? '',
    imapPort: String(account.imapPort ?? 993),
    imapSecure: account.imapSecure !== false,
    smtpEnabled: Boolean(account.smtpHost),
    smtpHost: account.smtpHost ?? '',
    smtpPort: String(account.smtpPort ?? 465),
    smtpSecure: account.smtpSecure !== false,
    color: account.color ?? '',
    downloadPreference: account.settings.downloadPreference ?? 'headers-then-item',
  };
}

function emptyForm(presetId = 'qq'): FormState {
  const preset = presetById(presetId);
  return {
    displayName: '',
    email: '',
    password: '',
    providerPreset: presetId,
    imapHost: preset?.imap.host ?? '',
    imapPort: String(preset?.imap.port ?? 993),
    imapSecure: preset?.imap.secure ?? true,
    smtpEnabled: Boolean(preset?.smtp),
    smtpHost: preset?.smtp?.host ?? '',
    smtpPort: String(preset?.smtp?.port ?? 465),
    smtpSecure: preset?.smtp?.secure ?? true,
    color: '',
    downloadPreference: 'headers-then-item',
  };
}

export function AccountSettings(): JSX.Element {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [mode, setMode] = useState<'list' | 'add' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reauthId, setReauthId] = useState<string | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [pluginAccountId, setPluginAccountId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AccountView | null>(null);
  const [deleteInput, setDeleteInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const reloadBootstrap = useMailStore((state) => state.reloadBootstrap);
  const pluginSnapshot = useMailStore((state) => state.pluginSnapshot);

  const load = useCallback(async () => {
    const result = await window.api.listAccounts();
    if (result.ok) setAccounts(result.data);
    else setError(result.error.message);
  }, []);

  useEffect(() => {
    void load();
    return window.api.onAccountsChanged(() => {
      void load();
    });
  }, [load]);

  const startAdd = (): void => {
    setMode('add');
    setEditingId(null);
    setForm(emptyForm());
    setError(null);
    setNotice(null);
  };

  const startEdit = (account: AccountView): void => {
    setMode('edit');
    setEditingId(account.id);
    setForm(formFromAccount(account));
    setError(null);
    setNotice(null);
  };

  const cancelForm = (): void => {
    setMode('list');
    setEditingId(null);
    setError(null);
  };

  const applyPreset = (presetId: string): void => {
    const preset = presetById(presetId);
    setForm((current) => ({
      ...current,
      providerPreset: presetId,
      ...(preset
        ? {
            imapHost: preset.imap.host || current.imapHost,
            imapPort: String(preset.imap.port),
            imapSecure: preset.imap.secure,
            smtpEnabled: preset.smtp ? true : current.smtpEnabled,
            smtpHost: preset.smtp?.host ?? current.smtpHost,
            smtpPort: String(preset.smtp?.port ?? (Number(current.smtpPort) || 465)),
            smtpSecure: preset.smtp?.secure ?? current.smtpSecure,
          }
        : {}),
    }));
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const imapPort = Number(form.imapPort);
    const smtpPort = Number(form.smtpPort);
    const payload: AccountInput = {
      displayName: form.displayName.trim(),
      email: form.email.trim(),
      providerPreset: form.providerPreset as AccountInput['providerPreset'],
      imap: { host: form.imapHost.trim(), port: imapPort, secure: form.imapSecure },
      smtp: form.smtpEnabled
        ? { host: form.smtpHost.trim(), port: smtpPort, secure: form.smtpSecure }
        : null,
      ...(form.password ? { password: form.password } : {}),
      ...(form.color ? { color: form.color } : {}),
      settings: { downloadPreference: form.downloadPreference },
    };

    if (mode === 'add' && !form.password) {
      setError('请填写授权码或密码；添加账户时会立即验证登录。');
      return;
    }

    setBusy(true);
    const result =
      mode === 'add'
        ? await window.api.addAccount(payload)
        : await window.api.updateAccount(editingId as string, payload);
    setBusy(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    setNotice(mode === 'add' ? '账户已添加，正在首次同步。' : '账户已更新。');
    setMode('list');
    setEditingId(null);
    await load();
    await reloadBootstrap();
  };

  const toggleEnabled = async (account: AccountView): Promise<void> => {
    setError(null);
    setNotice(null);
    const result = await window.api.setAccountEnabled(account.id, !account.enabled);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setNotice(account.enabled ? '账户已禁用，本地数据仍可查看。' : '账户已启用，正在重新同步。');
    await load();
    await reloadBootstrap();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || deleting) return;
    setError(null);
    setNotice(null);
    setDeleting(true);
    const result = await window.api.removeAccount(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);
    setDeleteInput('');
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setNotice('账户及其本地数据已删除。');
    await load();
    await reloadBootstrap();
  };

  const setPluginForAccount = async (
    pluginId: string,
    accountId: string,
    enabled: boolean | null,
  ): Promise<void> => {
    setError(null);
    setNotice(null);
    const result = await window.api.setPluginAccountOverride(pluginId, accountId, enabled);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    await useMailStore.getState().loadPlugins();
  };

  const submitReauth = async (): Promise<void> => {
    if (!reauthId) return;
    setError(null);
    setBusy(true);
    const result = await window.api.reauthenticateAccount(reauthId, reauthPassword);
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setReauthId(null);
    setReauthPassword('');
    setNotice('重新认证成功，账户已恢复同步。');
    await load();
    await reloadBootstrap();
  };

  const presetHint = presetById(form.providerPreset)?.hint;

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3 className="settings-title">账户</h3>
        {mode === 'list' ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={startAdd}>
            添加账户
          </button>
        ) : null}
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {notice ? <p className="hint">{notice}</p> : null}

      {mode === 'list' ? (
        <>
          {accounts.length === 0 ? (
            <p className="hint">尚未添加账户。支持 QQ、网易 163/126、Gmail、Outlook 与自定义 IMAP。</p>
          ) : (
            <ul className="account-settings-list">
              {accounts.map((account) => (
                <li className="account-settings-item" key={account.id}>
                  <span
                    className="account-color"
                    style={{ backgroundColor: account.color ?? 'var(--mf-color-accent)' }}
                    aria-hidden="true"
                  />
                  <div className="account-settings-info">
                    <div className="account-settings-title">
                      <strong>{account.displayName}</strong>
                      <span className={`badge account-badge-${account.status}`}>
                        {STATUS_LABEL[account.status]}
                      </span>
                      {account.unreadCount > 0 ? (
                        <span className="hint">{account.unreadCount} 封未读</span>
                      ) : null}
                    </div>
                    <span className="hint">{account.email}</span>
                    <span className="hint">
                      IMAP {account.imapHost}:{account.imapPort}
                      {account.smtpHost ? ` · SMTP ${account.smtpHost}:${account.smtpPort}` : ' · 未配置 SMTP'}
                      {account.lastSyncAt
                        ? ` · 上次同步 ${new Date(account.lastSyncAt).toLocaleString()}`
                        : ' · 尚未同步'}
                    </span>
                    {account.lastError && account.lastError.code !== 'delete_pending' ? (
                      <span className="hint">最近错误：{account.lastError.message}</span>
                    ) : null}
                    {account.lastError?.code === 'delete_pending' ? (
                      <span className="hint">上次删除未完成，将在下次启动时重试。</span>
                    ) : null}
                  </div>
                  <div className="account-settings-actions">
                    <button type="button" className="btn btn-sm" onClick={() => startEdit(account)}>
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      aria-expanded={pluginAccountId === account.id}
                      onClick={() =>
                        setPluginAccountId((current) => (current === account.id ? null : account.id))
                      }
                    >
                      插件
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => void toggleEnabled(account)}>
                      {account.enabled ? '禁用' : '启用'}
                    </button>
                    {account.authState === 'requires_reauth' ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setReauthId(account.id);
                          setReauthPassword('');
                        }}
                      >
                        重新登录
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        setDeleteInput('');
                        setDeleteTarget(account);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {pluginAccountId ? (
            <div className="account-plugins">
              <div className="settings-section-head">
                <strong>
                  该账户启用的插件 ·{' '}
                  {accounts.find((item) => item.id === pluginAccountId)?.displayName ?? ''}
                </strong>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPluginAccountId(null)}
                >
                  收起
                </button>
              </div>
              <p className="hint">
                未设置时继承全局启用状态；在此取消勾选只影响该账户的视图、菜单与命令，插件的后台能力（如安全扫描）不变。
              </p>
              <ul className="account-plugin-list">
                {(pluginSnapshot?.plugins ?? [])
                  .filter((plugin) => plugin.status === 'ready')
                  .map((plugin) => {
                    const override = plugin.accountOverrides?.[pluginAccountId];
                    const explicit = typeof override === 'boolean';
                    const checked = explicit ? override : plugin.enabled;
                    return (
                      <li key={plugin.id}>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) =>
                              void setPluginForAccount(
                                plugin.id,
                                pluginAccountId,
                                event.target.checked,
                              )
                            }
                          />
                          {plugin.name}
                        </label>
                        <span className="hint">
                          {explicit ? (override ? '本账户单独启用' : '本账户已禁用') : '继承全局'}
                        </span>
                        {explicit ? (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void setPluginForAccount(plugin.id, pluginAccountId, null)}
                          >
                            恢复继承
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                {(pluginSnapshot?.plugins ?? []).length === 0 ? (
                  <li>
                    <span className="hint">尚未发现插件。</span>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {reauthId ? (
            <div className="account-reauth">
              <p className="hint">
                {accounts.find((item) => item.id === reauthId)?.email}：请输入新的授权码或密码。
                QQ / 网易需先在网页版邮箱重新生成授权码。
              </p>
              <div className="field settings-inline">
                <input
                  className="input"
                  type="password"
                  value={reauthPassword}
                  onChange={(event) => setReauthPassword(event.target.value)}
                  placeholder="授权码 / 密码"
                  autoComplete="off"
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !reauthPassword}
                  onClick={() => void submitReauth()}
                >
                  验证并恢复
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setReauthId(null);
                    setReauthPassword('');
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : null}

          <p className="hint">
            删除账户会清除本地邮件、附件缓存、搜索索引与 safeStorage 凭证；服务器上的邮件不受影响。
          </p>
        </>
      ) : (
        <form className="account-form" onSubmit={(event) => void submit(event)}>          <div className="account-form-grid">
            <label className="field">
              <span className="field-label">服务商预设</span>
              <select
                className="input"
                value={form.providerPreset}
                onChange={(event) => applyPreset(event.target.value)}
              >
                {PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">显示名称</span>
              <input
                className="input"
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                placeholder="工作邮箱"
                required
              />
            </label>

            <label className="field">
              <span className="field-label">邮箱地址</span>
              <input
                className="input"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                placeholder="you@example.com"
                autoComplete="username"
                required
              />
            </label>

            <label className="field">
              <span className="field-label">
                {mode === 'edit' ? '授权码 / 密码（留空表示不修改）' : '授权码 / 密码'}
              </span>
              <input
                className="input"
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                autoComplete="new-password"
              />
            </label>

            <label className="field">
              <span className="field-label">IMAP 主机</span>
              <input
                className="input"
                value={form.imapHost}
                onChange={(event) => setForm({ ...form, imapHost: event.target.value })}
                placeholder="imap.example.com"
                required
              />
            </label>

            <label className="field">
              <span className="field-label">IMAP 端口</span>
              <input
                className="input"
                type="number"
                value={form.imapPort}
                onChange={(event) => setForm({ ...form, imapPort: event.target.value })}
              />
            </label>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.imapSecure}
                onChange={(event) => setForm({ ...form, imapSecure: event.target.checked })}
              />
              IMAP 使用 TLS
            </label>

            <label className="field">
              <span className="field-label">标识色</span>
              <input
                className="input"
                value={form.color}
                onChange={(event) => setForm({ ...form, color: event.target.value })}
                placeholder="#5b9dff（可选）"
              />
            </label>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.smtpEnabled}
              onChange={(event) => setForm({ ...form, smtpEnabled: event.target.checked })}
            />
            配置 SMTP（发信需要）
          </label>

          {form.smtpEnabled ? (
            <div className="account-form-grid">
              <label className="field">
                <span className="field-label">SMTP 主机</span>
                <input
                  className="input"
                  value={form.smtpHost}
                  onChange={(event) => setForm({ ...form, smtpHost: event.target.value })}
                  placeholder="smtp.example.com"
                />
              </label>
              <label className="field">
                <span className="field-label">SMTP 端口</span>
                <input
                  className="input"
                  type="number"
                  value={form.smtpPort}
                  onChange={(event) => setForm({ ...form, smtpPort: event.target.value })}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.smtpSecure}
                  onChange={(event) => setForm({ ...form, smtpSecure: event.target.checked })}
                />
                SMTP 使用 TLS（465 端口勾选，587 端口不勾选）
              </label>
            </div>
          ) : null}

          <label className="field">
            <span className="field-label">下载首选项</span>
            <select
              className="input"
              value={form.downloadPreference}
              onChange={(event) =>
                setForm({ ...form, downloadPreference: event.target.value as DownloadPreference })
              }
            >
              {DOWNLOAD_PREFERENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="hint">
            控制同步时正文的抓取范围：下载整个项目会随同步抓取全部正文；仅下载邮件头时正文在点开邮件时按需加载。
          </p>

          {presetHint ? <p className="hint">{presetHint}</p> : null}
          <p className="hint">保存前会建立临时 IMAP/SMTP 连接验证凭证；验证失败不会写入数据库。</p>

          <div className="account-form-actions">
            <button type="button" className="btn" onClick={cancelForm} disabled={busy}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '正在验证…' : mode === 'add' ? '验证并添加' : '验证并保存'}
            </button>
          </div>
        </form>
      )}

      {deleteTarget ? (
        <div
          className="overlay"
          role="presentation"
          onMouseDown={(event) => event.target === event.currentTarget && setDeleteTarget(null)}
        >
          <div
            className="modal confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`删除账户 ${deleteTarget.email}`}
          >
            <div className="modal-header">
              <h2 className="modal-title">删除账户 {deleteTarget.email}</h2>
            </div>
            <div className="modal-body">
              <p>此操作将删除该账户在本地的所有邮件、附件缓存、搜索索引和相关设置。</p>
              <p className="hint">服务器上的邮件不受影响。此操作不可撤销。</p>
              <div className="field">
                <span className="field-label">
                  请输入 <code className="confirm-email">{deleteTarget.email}</code> 以确认删除
                </span>
                <input
                  className="input"
                  type="text"
                  autoFocus
                  value={deleteInput}
                  autoComplete="off"
                  placeholder={deleteTarget.email}
                  onChange={(event) => setDeleteInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && deleteInput.trim().toLowerCase() === deleteTarget.email.toLowerCase()) {
                      void confirmDelete();
                    }
                  }}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-primary" onClick={() => setDeleteTarget(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger-solid"
                disabled={deleting || deleteInput.trim().toLowerCase() !== deleteTarget.email.toLowerCase()}
                onClick={() => void confirmDelete()}
              >
                {deleting ? '正在删除…' : '删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
