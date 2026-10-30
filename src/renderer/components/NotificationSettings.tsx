import { useEffect, useState } from 'react';
import type { NotificationSettingsView, TraySettings } from '../../shared/ipc';
import { REMINDER_MINUTE_OPTIONS } from '../../shared/constants';
import { t } from '../../shared/i18n';

/**
 * 通知与托盘设置（宿主能力，§22）。
 *
 * 隐私边界（§22.2）：通知只含发件人与主题，界面明确告知用户。
 * 托盘是主进程原生能力（Tray），插件无法提供，故此节不属于插件设置。
 * 文案走 t()（§28.3）：伪本地化可暴露此处布局溢出。
 */

export function NotificationSettings(): JSX.Element {
  const [settings, setSettings] = useState<NotificationSettingsView | null>(null);
  const [tray, setTray] = useState<TraySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 两组设置各自管理忙碌态：保存通知设置不应禁用托盘开关，反之亦然
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [trayBusy, setTrayBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testHint, setTestHint] = useState<string | null>(null);

  useEffect(() => {
    void window.api.getNotificationSettings().then((result) => {
      if (result.ok) setSettings(result.data);
      else setError(result.error.message);
    });
    void window.api.getTraySettings().then((result) => {
      if (result.ok) setTray(result.data);
      else setError(result.error.message);
    });
  }, []);

  const saveNotifications = async (patch: Partial<Omit<NotificationSettingsView, 'dnd'>> & {
    dnd?: Partial<NotificationSettingsView['dnd']>;
  }): Promise<void> => {
    setNotifyBusy(true);
    const result = await window.api.setNotificationSettings(patch);
    setNotifyBusy(false);
    if (result.ok) {
      setSettings(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
  };

  const saveTray = async (patch: Partial<TraySettings>): Promise<void> => {
    setTrayBusy(true);
    const result = await window.api.setTraySettings(patch);
    setTrayBusy(false);
    if (result.ok) {
      setTray(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
  };

  const sendTest = async (): Promise<void> => {
    setTestBusy(true);
    const result = await window.api.sendTestNotification();
    setTestBusy(false);
    if (!result.ok) {
      setTestHint(null);
      setError(result.error.message);
      return;
    }
    setError(null);
    // supported=false：系统没有通知服务（如精简 Linux 桌面），按钮如实告知而非假装成功
    setTestHint(
      result.data.supported
        ? t('settings.notify.testSent')
        : t('settings.notify.testUnsupported'),
    );
  };

  return (
    <>
      <section className="settings-section" aria-label={t('settings.notify.title')}>
        <h3 className="settings-title">{t('settings.notify.title')}</h3>
        {error ? <p className="error-banner">{error}</p> : null}
        {settings ? (
          <div className="settings-checks">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.mail}
                disabled={notifyBusy}
                onChange={(event) => void saveNotifications({ mail: event.target.checked })}
              />
              {t('settings.notify.mail')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.sendResult}
                disabled={notifyBusy}
                onChange={(event) => void saveNotifications({ sendResult: event.target.checked })}
              />
              {t('settings.notify.sendResult')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.reminders}
                disabled={notifyBusy}
                onChange={(event) => void saveNotifications({ reminders: event.target.checked })}
              />
              {t('settings.notify.reminders')}
            </label>

            <div className="settings-inline">
              <label className="field">
                <span className="field-label">{t('settings.notify.reminderLead')}</span>
                <select
                  className="input"
                  value={settings.reminderMinutes}
                  disabled={notifyBusy || !settings.reminders}
                  onChange={(event) =>
                    void saveNotifications({ reminderMinutes: Number(event.target.value) })
                  }
                >
                  {REMINDER_MINUTE_OPTIONS.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes === 0
                        ? t('settings.notify.reminderOnTime')
                        : t('settings.notify.reminderMinutes', { minutes })}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.dnd.enabled}
                disabled={notifyBusy}
                onChange={(event) =>
                  void saveNotifications({ dnd: { enabled: event.target.checked } })
                }
              />
              {t('settings.notify.dnd')}
            </label>
            {settings.dnd.enabled ? (
              <div className="settings-inline">
                <label className="field">
                  <span className="field-label">{t('settings.notify.dndStart')}</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={23}
                    value={settings.dnd.startHour}
                    disabled={notifyBusy}
                    onChange={(event) =>
                      void saveNotifications({ dnd: { startHour: Number(event.target.value) } })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field-label">{t('settings.notify.dndEnd')}</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={23}
                    value={settings.dnd.endHour}
                    disabled={notifyBusy}
                    onChange={(event) =>
                      void saveNotifications({ dnd: { endHour: Number(event.target.value) } })
                    }
                  />
                </label>
              </div>
            ) : null}
            <p className="hint">{t('settings.notify.hint')}</p>
            <div className="settings-inline">
              <button
                type="button"
                className="btn btn-sm"
                disabled={testBusy || !settings}
                onClick={() => void sendTest()}
              >
                {testBusy ? t('settings.notify.testSending') : t('settings.notify.test')}
              </button>
              {testHint ? <span className="hint">{testHint}</span> : null}
            </div>
          </div>
        ) : (
          <p className="hint">{t('settings.notify.loading')}</p>
        )}
      </section>

      <section className="settings-section" aria-label={t('settings.tray.title')}>
        <h3 className="settings-title">{t('settings.tray.title')}</h3>
        {tray ? (
          <div className="settings-checks">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={tray.enabled}
                disabled={trayBusy}
                onChange={(event) => void saveTray({ enabled: event.target.checked })}
              />
              {t('settings.tray.enabled')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={tray.closeToTray}
                disabled={trayBusy || !tray.enabled}
                onChange={(event) => void saveTray({ closeToTray: event.target.checked })}
              />
              {t('settings.tray.closeToTray')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={tray.minimizeToTray}
                disabled={trayBusy || !tray.enabled}
                onChange={(event) => void saveTray({ minimizeToTray: event.target.checked })}
              />
              {t('settings.tray.minimizeToTray')}
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={tray.showUnreadBadge}
                disabled={trayBusy || !tray.enabled}
                onChange={(event) => void saveTray({ showUnreadBadge: event.target.checked })}
              />
              {t('settings.tray.showUnreadBadge')}
            </label>
            <p className="hint">{t('settings.tray.hint')}</p>
          </div>
        ) : (
          <p className="hint">{t('settings.tray.loading')}</p>
        )}
      </section>
    </>
  );
}
