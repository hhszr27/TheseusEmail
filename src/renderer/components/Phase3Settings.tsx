import { useEffect, useState } from 'react';
import type {
  AiSettingsView,
  AttachmentExtensionSettings,
  DohStatus,
  MasterPasswordStatus,
  MetadataStatus,
  ScanProviderStatus,
  TranslationSettingsView,
} from '../../shared/ipc';
import { AI_PROVIDER_PRESETS, aiPresetById } from '../../shared/ai-providers';
import {
  mergeExtLists,
  normalizeScanPolicy,
  type ScanAction,
  type ScanPolicySettings,
} from '../../shared/attachments';
import { ConfirmDialog } from './ConfirmDialog';
import { SignatureDialog } from './SignatureDialog';
import { useMailStore } from '../stores/mail-store';

/**
 * Phase 3 设置：翻译、AI、附件扩展名、隐私与数据。
 * 所有密钥输入都是 write-only：保存后不再回显。
 */

function splitExts(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 单个扩展名归一化：补前导点、小写、校验；非法返回空串。 */
function normalizeExtInput(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return /^\.[a-z0-9]{1,12}$/.test(withDot) ? withDot : '';
}

export function Phase3Settings(): JSX.Element {
  const bootstrap = useMailStore((state) => state.bootstrap);
  const activeFolder = useMailStore((state) => state.activeFolder);
  const unified = useMailStore((state) => state.unified);

  const [translation, setTranslation] = useState<TranslationSettingsView | null>(null);
  const [translationKey, setTranslationKey] = useState('');
  const [translationRegion, setTranslationRegion] = useState('');

  const [ai, setAi] = useState<AiSettingsView | null>(null);
  const [aiKey, setAiKey] = useState('');

  const aiPreset = ai ? aiPresetById(ai.providerId) : null;
  const aiNeedsKey = ai ? !ai.local && (aiPreset ? aiPreset.needsKey : true) : true;

  const handleAiProviderChange = (id: string): void => {
    if (!ai) return;
    const preset = aiPresetById(id);
    setAi({
      ...ai,
      providerId: id,
      baseUrl: preset ? preset.baseUrl : '',
      model: preset ? preset.defaultModel : '',
      local: preset ? !preset.needsKey : false,
    });
  };

  /** 纯文本预览类型（可增删，立即保存）。 */
  const [textList, setTextList] = useState<string[]>([]);
  const [textInput, setTextInput] = useState('');
  /** 打开前提示：双击弹确认，确认后可打开。 */
  const [warnList, setWarnList] = useState<string[]>([]);
  const [warnInput, setWarnInput] = useState('');
  /** 禁止打开：双击直接拒绝，不给打开入口。 */
  const [blockList, setBlockList] = useState<string[]>([]);
  const [blockInput, setBlockInput] = useState('');
  /** 待确认的移除目标：点 × 先问一句，避免误删。 */
  const [pendingRemove, setPendingRemove] = useState<{
    kind: 'text' | 'warn' | 'block';
    ext: string;
  } | null>(null);
  /** 待确认的「恢复默认」目标：点按钮先问一句，避免误覆盖用户追加的类型。 */
  const [pendingReset, setPendingReset] = useState<'warn' | 'block' | null>(null);
  /** 签名编辑窗口：当前为纯 UI 占位，功能尚未实现。 */
  const [signatureOpen, setSignatureOpen] = useState(false);
  /** 附件扫描策略：扫描源开关 + 两种结论的处理方式（null = 还没读到）。 */
  const [scanPolicy, setScanPolicy] = useState<ScanPolicySettings | null>(null);
  /** 各扫描源是否可用（不可用时显示原因，避免"静默不扫"）。 */
  const [providerStatuses, setProviderStatuses] = useState<ScanProviderStatus[]>([]);

  const [doh, setDoh] = useState<DohStatus | null>(null);
  const [master, setMaster] = useState<MasterPasswordStatus | null>(null);
  const [masterPassword, setMasterPassword] = useState('');
  const [masterConfirm, setMasterConfirm] = useState('');
  const [masterCurrent, setMasterCurrent] = useState('');
  const [metadata, setMetadata] = useState<MetadataStatus | null>(null);

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.api.getTranslationSettings().then((result) => {
      if (result.ok) setTranslation(result.data);
    });
    void window.api.getAiSettings().then((result) => {
      if (result.ok) setAi(result.data);
    });
    void window.api.getAttachmentExtensions().then((result) => {
      if (result.ok) {
        setTextList(result.data.customTextExts);
        // 没存过完整列表时展示默认值（warn 默认会剔除已被禁止的那几个）——所见即当前生效
        const lists = mergeExtLists(
          [],
          result.data.customDangerExts,
          result.data.warnExts ?? result.data.dangerousExts,
          result.data.blockExts,
        );
        setWarnList(lists.warn);
        setBlockList(lists.blocked);
      }
    });
    void window.api.getSetting('attachments.scan').then((result) => {
      if (!result.ok) return;
      let parsed: unknown = null;
      if (result.data) {
        try {
          parsed = JSON.parse(result.data);
        } catch {
          parsed = null;
        }
      }
      setScanPolicy(normalizeScanPolicy(parsed));
    });
    void window.api.getScanProviders().then((result) => {
      if (result.ok) setProviderStatuses(result.data);
    });
    void window.api.getDohStatus().then((result) => {
      if (result.ok) setDoh(result.data);
    });
    void window.api.getMasterPasswordStatus().then((result) => {
      if (result.ok) setMaster(result.data);
    });
    void window.api.getMetadataStatus().then((result) => {
      if (result.ok) setMetadata(result.data);
    });
  }, []);

  const accountId = bootstrap?.accounts[0]?.id ?? '';

  const saveTranslation = async (): Promise<void> => {
    setBusy(true);
    const result = await window.api.setTranslationSettings({
      enabled: translation?.enabled ?? false,
      targetLang: translation?.targetLang ?? 'zh-Hans',
      ...(translationKey ? { apiKey: translationKey } : {}),
      ...(translationRegion ? { region: translationRegion } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setTranslationKey('');
    const refreshed = await window.api.getTranslationSettings();
    if (refreshed.ok) setTranslation(refreshed.data);
    setMessage('翻译设置已保存。');
  };

  const saveAi = async (): Promise<void> => {
    setBusy(true);
    const result = await window.api.setAiSettings({
      enabled: ai?.enabled ?? false,
      providerId: ai?.providerId ?? 'openai',
      baseUrl: ai?.baseUrl ?? '',
      model: ai?.model ?? '',
      local: ai?.local ?? false,
      features: ai?.features ?? { summarize: true, semanticSearch: true, command: true },
      ...(aiKey ? { apiKey: aiKey } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setAiKey('');
    const refreshed = await window.api.getAiSettings();
    if (refreshed.ok) setAi(refreshed.data);
    setMessage('AI 设置已保存。');
  };

  /** 三个列表必须一起写：只传一个会把其他清空。 */
  const persistExts = async (next: {
    text: string[];
    warn: string[];
    block: string[];
  }): Promise<void> => {
    const payload = {
      customTextExts: next.text,
      customDangerExts: [],
      warnExts: next.warn,
      blockExts: next.block,
    };
    const result = await window.api.setAttachmentExtensions(payload);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setTextList(next.text);
    setWarnList(next.warn);
    setBlockList(next.block);
    setMessage('附件扩展名已更新。');
  };

  const addText = async (): Promise<void> => {
    const candidates = splitExts(textInput)
      .map(normalizeExtInput)
      .filter(Boolean);
    if (!candidates.length) return;
    setTextInput('');
    await persistExts({
      text: [...new Set([...textList, ...candidates])],
      warn: warnList,
      block: blockList,
    });
  };

  const removeText = async (ext: string): Promise<void> => {
    await persistExts({
      text: textList.filter((item) => item !== ext),
      warn: warnList,
      block: blockList,
    });
  };

  const addWarn = async (): Promise<void> => {
    const candidates = splitExts(warnInput)
      .map(normalizeExtInput)
      .filter(Boolean);
    if (!candidates.length) return;
    setWarnInput('');
    await persistExts({
      text: textList,
      warn: [...new Set([...warnList, ...candidates])],
      block: blockList,
    });
  };

  const removeWarn = async (ext: string): Promise<void> => {
    await persistExts({
      text: textList,
      warn: warnList.filter((item) => item !== ext),
      block: blockList,
    });
  };

  const addBlock = async (): Promise<void> => {
    const candidates = splitExts(blockInput)
      .map(normalizeExtInput)
      .filter(Boolean);
    if (!candidates.length) return;
    setBlockInput('');
    await persistExts({
      text: textList,
      warn: warnList,
      block: [...new Set([...blockList, ...candidates])],
    });
  };

  const removeBlock = async (ext: string): Promise<void> => {
    await persistExts({
      text: textList,
      warn: warnList,
      block: blockList.filter((item) => item !== ext),
    });
  };

  /** 恢复默认：warn 用内置危险类型（剔除当前禁止列表），block 用内置禁止类型。 */
  const resetExts = async (kind: 'warn' | 'block'): Promise<void> => {
    const defaults = mergeExtLists([], [], undefined, kind === 'block' ? undefined : blockList);
    await persistExts({
      text: textList,
      warn: kind === 'warn' ? defaults.warn : warnList,
      block: kind === 'block' ? mergeExtLists([], []).blocked : blockList,
    });
  };

  /** 扫描策略改动立即落盘：这些开关直接影响下次打开附件的行为。 */
  const saveScanPolicy = (next: ScanPolicySettings): void => {
    setScanPolicy(next);
    void window.api.setSetting('attachments.scan', JSON.stringify(next));
  };

  const confirmRemove = (): void => {
    const target = pendingRemove;
    if (!target) return;
    setPendingRemove(null);
    if (target.kind === 'text') void removeText(target.ext);
    else if (target.kind === 'warn') void removeWarn(target.ext);
    else void removeBlock(target.ext);
  };

  /** 确认后真正恢复默认：会覆盖当前提示/禁止列表里用户追加的类型。 */
  const confirmReset = (): void => {
    const kind = pendingReset;
    if (!kind) return;
    setPendingReset(null);
    void resetExts(kind);
  };

  const changeMasterPassword = async (): Promise<void> => {
    if (master?.enabled && !masterCurrent) {
      setError('请输入当前主密码');
      return;
    }
    if (!master?.enabled) {
      if (masterPassword.length < 8) {
        setError('主密码至少需要 8 个字符');
        return;
      }
      if (masterPassword !== masterConfirm) {
        setError('两次输入的主密码不一致');
        return;
      }
    }
    setBusy(true);
    const result = await window.api.setMasterPassword(
      master?.enabled ? null : masterPassword,
      master?.enabled ? masterCurrent : undefined,
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setMaster(result.data);
    setMasterPassword('');
    setMasterConfirm('');
    setMasterCurrent('');
    setMessage(
      result.data.enabled
        ? '主密码已启用，下次启动需要输入。'
        : '主密码已关闭，数据库密钥恢复由系统密钥库保护。',
    );
  };

  return (
    <>
      <section className="settings-section">
        <h3 className="settings-title">翻译</h3>
        {message ? <p className="hint">{message}</p> : null}
        {error ? <p className="error-banner">{error}</p> : null}

        {translation ? (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={translation.enabled}
                onChange={(event) =>
                  setTranslation({ ...translation, enabled: event.target.checked })
                }
              />
              启用翻译（默认关闭）
            </label>

            <div className="field settings-inline">
              <label className="field-label" htmlFor="translation-lang">
                目标语言
              </label>
              <select
                id="translation-lang"
                className="input"
                value={translation.targetLang}
                onChange={(event) =>
                  setTranslation({ ...translation, targetLang: event.target.value })
                }
              >
                <option value="zh-Hans">简体中文</option>
                <option value="zh-Hant">繁体中文</option>
                <option value="en">英语</option>
                <option value="ja">日语</option>
                <option value="de">德语</option>
              </select>
            </div>

            <div className="field settings-inline">
              <label className="field-label" htmlFor="translation-key">
                Microsoft 密钥
              </label>
              <input
                id="translation-key"
                className="input"
                type="password"
                placeholder={translation.configured ? '已配置（留空保持不变）' : '尚未配置'}
                value={translationKey}
                onChange={(event) => setTranslationKey(event.target.value)}
              />
            </div>

            <div className="field settings-inline">
              <label className="field-label" htmlFor="translation-region">
                区域（可选）
              </label>
              <input
                id="translation-region"
                className="input"
                placeholder="如 eastasia"
                value={translationRegion}
                onChange={(event) => setTranslationRegion(event.target.value)}
              />
            </div>

            <p className="hint">密钥保存在系统密钥库，不会进入渲染进程或日志。</p>
            <p className="hint">{translation.dataTransferNotice}</p>

            <button type="button" className="btn btn-primary" onClick={() => void saveTranslation()} disabled={busy}>
              保存翻译设置
            </button>
          </>
        ) : (
          <p className="hint">正在读取翻译设置…</p>
        )}
      </section>

      <section className="settings-section">
        <h3 className="settings-title">AI 助手</h3>
        {ai ? (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={ai.enabled}
                onChange={(event) => setAi({ ...ai, enabled: event.target.checked })}
              />
              启用 AI（摘要、语义搜索、自然语言指令）
            </label>

            <div className="field settings-inline">
              <label className="field-label" htmlFor="ai-provider">
                服务商
              </label>
              <select
                id="ai-provider"
                className="input"
                value={ai.providerId}
                onChange={(event) => handleAiProviderChange(event.target.value)}
              >
                {AI_PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>

            {aiPreset?.hint ? (
              <p className="hint">{aiPreset.hint}</p>
            ) : null}

            <div className="field settings-inline">
              <label className="field-label" htmlFor="ai-base">
                端点
              </label>
              <input
                id="ai-base"
                className="input"
                value={ai.baseUrl}
                placeholder={ai.providerId === 'custom' ? '如 https://your-gateway/v1' : ''}
                onChange={(event) => setAi({ ...ai, baseUrl: event.target.value })}
              />
            </div>

            <div className="field settings-inline">
              <label className="field-label" htmlFor="ai-model">
                模型
              </label>
              <input
                id="ai-model"
                className="input"
                value={ai.model}
                placeholder={ai.providerId === 'custom' ? '模型名称' : ''}
                onChange={(event) => setAi({ ...ai, model: event.target.value })}
              />
            </div>

            {ai.providerId === 'custom' ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ai.local}
                  onChange={(event) => setAi({ ...ai, local: event.target.checked })}
                />
                无需 API Key（本地 / 自建 OpenAI 兼容服务）
              </label>
            ) : null}

            {aiNeedsKey ? (
              <div className="field settings-inline">
                <label className="field-label" htmlFor="ai-key">
                  API Key
                </label>
                <input
                  id="ai-key"
                  className="input"
                  type="password"
                  placeholder={ai.configured ? '已配置（留空保持不变）' : '尚未配置'}
                  value={aiKey}
                  onChange={(event) => setAiKey(event.target.value)}
                />
              </div>
            ) : null}

            <div className="permission-list">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ai.features.summarize}
                  onChange={(event) =>
                    setAi({ ...ai, features: { ...ai.features, summarize: event.target.checked } })
                  }
                />
                摘要
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ai.features.semanticSearch}
                  onChange={(event) =>
                    setAi({
                      ...ai,
                      features: { ...ai.features, semanticSearch: event.target.checked },
                    })
                  }
                />
                语义搜索
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ai.features.command}
                  onChange={(event) =>
                    setAi({ ...ai, features: { ...ai.features, command: event.target.checked } })
                  }
                />
                自然语言指令
              </label>
            </div>

            <p className="hint">{ai.dataTransferNotice}</p>

            <button type="button" className="btn btn-primary" onClick={() => void saveAi()} disabled={busy}>
              保存 AI 设置
            </button>
          </>
        ) : (
          <p className="hint">正在读取 AI 设置…</p>
        )}
      </section>

      <section className="settings-section">
        <h3 className="settings-title">附件扩展名</h3>
        <div className="field">
          <label className="field-label" htmlFor="text-exts">
            纯文本预览类型
          </label>
          <div className="ext-chips">
            {textList.map((ext) => (
              <span className="ext-chip" key={ext}>
                {ext}
                <button
                  type="button"
                  aria-label={`移除文本类型 ${ext}`}
                  onClick={() => setPendingRemove({ kind: 'text', ext })}
                >
                  ×
                </button>
              </span>
            ))}
            {textList.length === 0 ? <span className="hint">还没有追加任何类型</span> : null}
          </div>
          <div className="ext-add-row">
            <input
              id="text-exts"
              className="input"
              placeholder=".rst, .toml"
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addText();
                }
              }}
            />
            <button type="button" className="btn" onClick={() => void addText()}>
              添加
            </button>
          </div>
        </div>

        <div className="field">
          <label className="field-label">打开前提示</label>
          <p className="hint">双击会弹确认框，默认按钮是「取消」，确认后才打开。</p>
          <div className="ext-chips">
            {warnList.map((ext) => (
              <span className="ext-chip" key={ext}>
                {ext}
                <button
                  type="button"
                  aria-label={`从提示里移除 ${ext}`}
                  onClick={() => setPendingRemove({ kind: 'warn', ext })}
                >
                  ×
                </button>
              </span>
            ))}
            {warnList.length === 0 ? <span className="hint">没有任何类型需要提示</span> : null}
          </div>
          <div className="ext-add-row">
            <input
              id="warn-exts"
              className="input"
              placeholder=".hta, .lnk"
              value={warnInput}
              onChange={(event) => setWarnInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addWarn();
                }
              }}
            />
            <button type="button" className="btn" onClick={() => void addWarn()}>
              添加
            </button>
          </div>
        </div>

        <div className="field">
          <label className="field-label">禁止打开</label>
          <p className="hint">
            双击直接拒绝，没有「仍要打开」入口；需要时把它从禁止列表里移出来。
          </p>
          <div className="ext-chips">
            {blockList.map((ext) => (
              <span className="ext-chip" key={ext}>
                {ext}
                <button
                  type="button"
                  aria-label={`解除禁止 ${ext}`}
                  onClick={() => setPendingRemove({ kind: 'block', ext })}
                >
                  ×
                </button>
              </span>
            ))}
            {blockList.length === 0 ? <span className="hint">没有禁止任何类型</span> : null}
          </div>
          <div className="ext-add-row">
            <input
              id="block-exts"
              className="input"
              placeholder=".scr, .pif"
              value={blockInput}
              onChange={(event) => setBlockInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void addBlock();
                }
              }}
            />
            <button type="button" className="btn" onClick={() => void addBlock()}>
              添加
            </button>
          </div>
        </div>

        <div className="settings-inline">
          <button type="button" className="btn" onClick={() => setPendingReset('warn')}>
            恢复默认提示列表
          </button>
          <button type="button" className="btn" onClick={() => setPendingReset('block')}>
            恢复默认禁止列表
          </button>
        </div>

        <p className="hint">
          同一扩展名同时出现在两档时，按「禁止」处理。当前：文本 {textList.length} 项，提示{' '}
          {warnList.length} 项，禁止 {blockList.length} 项。
        </p>
      </section>

      <section className="settings-section">
        <h3 className="settings-title">签名</h3>
        <p className="hint">新建或回复邮件时可自动附带签名。以下功能尚未实现，此处仅预留入口。</p>
        <div className="signature-row">
          <span className="signature-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
              <path d="M14 3v4a1 1 0 0 0 1 1h4" />
              <path d="M16.5 14.5l4.2 4.2-2.4 1-1.8-.2-.2-1.8 1-2.4z" />
              <path d="M15.8 15.2l2.9 2.9" />
            </svg>
          </span>
          <span className="signature-desc">创建或修改邮件的签名。</span>
          <button
            type="button"
            className="btn"
            onClick={() => setSignatureOpen(true)}
          >
            签名(N)...
          </button>
        </div>
      </section>

      {signatureOpen ? <SignatureDialog onClose={() => setSignatureOpen(false)} /> : null}

      <section className="settings-section">
        <h3 className="settings-title">附件扫描</h3>
        <p className="hint">
          自动扫描只覆盖危险与可疑类型。结论怎么处理由你决定——软件不替你判断，风险也由你承担。
        </p>

        {scanPolicy ? (
          <>
            <div className="settings-subsection">
              <h4 className="settings-subtitle">扫描源</h4>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={scanPolicy.providers.defender}
                  onChange={(event) =>
                    saveScanPolicy({
                      ...scanPolicy,
                      providers: { ...scanPolicy.providers, defender: event.target.checked },
                    })
                  }
                />
                <span>Microsoft Defender（本机扫描，文件不出本机）</span>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={scanPolicy.providers.virustotal}
                  onChange={(event) =>
                    saveScanPolicy({
                      ...scanPolicy,
                      providers: { ...scanPolicy.providers, virustotal: event.target.checked },
                    })
                  }
                />
                <span>VirusTotal（只查 SHA-256，不上传文件内容；需要 API Key）</span>
              </label>

              {providerStatuses.map((status) => (
                <p
                  className={`hint${status.available ? '' : ' scan-provider-unavailable'}`}
                  key={status.id}
                >
                  {status.name}：
                  {status.available ? '可用' : `不可用 · ${status.reason ?? '未知原因'}`}
                </p>
              ))}
            </div>

            <div className="settings-subsection">
              <h4 className="settings-subtitle">扫描结论处理</h4>
              <label className="settings-inline">
                <span>危险（多个引擎命中）</span>
                <select
                  className="input"
                  aria-label="危险结论处理"
                  value={scanPolicy.actions.malicious}
                  onChange={(event) =>
                    saveScanPolicy({
                      ...scanPolicy,
                      actions: {
                        ...scanPolicy.actions,
                        malicious: event.target.value as ScanAction,
                      },
                    })
                  }
                >
                  <option value="confirm">提示后确认</option>
                  <option value="block">禁止打开</option>
                  <option value="label">仅标记</option>
                </select>
              </label>
              <label className="settings-inline">
                <span>疑似（证据不足）</span>
                <select
                  className="input"
                  aria-label="疑似结论处理"
                  value={scanPolicy.actions.suspicious}
                  onChange={(event) =>
                    saveScanPolicy({
                      ...scanPolicy,
                      actions: {
                        ...scanPolicy.actions,
                        suspicious: event.target.value as ScanAction,
                      },
                    })
                  }
                >
                  <option value="label">仅标记</option>
                  <option value="confirm">提示后确认</option>
                  <option value="block">禁止打开</option>
                </select>
              </label>
              <p className="hint">
                扩展名规则与扫描结论按「禁止 &gt; 提示 &gt; 普通」合成：任何一处要求禁止，就打不开。
              </p>
            </div>
          </>
        ) : (
          <p className="hint">正在读取扫描设置…</p>
        )}
      </section>

      <section className="settings-section">
        <h3 className="settings-title">隐私与网络</h3>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={doh?.enabled ?? false}
            onChange={(event) => {
              void window.api.setDoh(event.target.checked).then((result) => {
                if (result.ok) setDoh(result.data);
              });
            }}
          />
          启用 DNS over HTTPS
        </label>
        <p className="hint">
          端点：{doh?.template ?? '—'}
          {doh?.enabled
            ? doh.requiresRestart
              ? ' · 需要重启应用后生效'
              : ' · 当前进程已应用'
            : ' · 未启用'}
        </p>

        <div className="settings-subsection">
          <h4 className="settings-subtitle">主密码</h4>
          <p className="hint">
            当前状态：{master?.enabled ? '已启用（启动时需输入）' : '未启用'}
          </p>
          {master?.enabled ? (
            <div className="field settings-inline">
              <label className="field-label" htmlFor="master-current">
                当前主密码
              </label>
              <input
                id="master-current"
                className="input"
                type="password"
                value={masterCurrent}
                onChange={(event) => setMasterCurrent(event.target.value)}
              />
            </div>
          ) : (
            <>
              <div className="field settings-inline">
                <label className="field-label" htmlFor="master-new">
                  新主密码
                </label>
                <input
                  id="master-new"
                  className="input"
                  type="password"
                  value={masterPassword}
                  onChange={(event) => setMasterPassword(event.target.value)}
                />
              </div>
              <div className="field settings-inline">
                <label className="field-label" htmlFor="master-confirm">
                  确认主密码
                </label>
                <input
                  id="master-confirm"
                  className="input"
                  type="password"
                  value={masterConfirm}
                  onChange={(event) => setMasterConfirm(event.target.value)}
                />
              </div>
            </>
          )}
          <button type="button" className="btn" onClick={() => void changeMasterPassword()} disabled={busy}>
            {master?.enabled ? '关闭主密码' : '启用主密码'}
          </button>
        </div>

        <div className="settings-subsection">
          <h4 className="settings-subtitle">通知偏好漫游（IMAP METADATA）</h4>
          <p className="hint">
            {metadata?.supported
              ? `服务器支持 METADATA${metadata.lastSyncAt ? `，上次同步 ${new Date(metadata.lastSyncAt).toLocaleString()}` : ''}`
              : '服务器未声明 METADATA 能力，将使用本地配置'}
            {metadata?.error ? ` · ${metadata.error}` : ''}
          </p>
          <div className="settings-inline">
            <button
              type="button"
              className="btn"
              disabled={!accountId}
              onClick={() => {
                void window.api.syncMetadata({ accountId, direction: 'pull' }).then((result) => {
                  if (result.ok) setMetadata(result.data);
                  else setError(result.error.message);
                });
              }}
            >
              从服务器读取
            </button>
            <button
              type="button"
              className="btn"
              disabled={!accountId}
              onClick={() => {
                void window.api.syncMetadata({ accountId, direction: 'push' }).then((result) => {
                  if (result.ok) setMetadata(result.data);
                  else setError(result.error.message);
                });
              }}
            >
              写入服务器
            </button>
          </div>
        </div>

        <div className="settings-subsection">
          <h4 className="settings-subtitle">邮件归档</h4>
          <div className="settings-inline">
            <button
              type="button"
              className="btn"
              disabled={!accountId}
              onClick={() => {
                void window.api.importMbox({ accountId }).then((result) => {
                  if (!result.ok) {
                    if (result.error.code !== 'CANCELLED') setError(result.error.message);
                    return;
                  }
                  setMessage(
                    `已导入 ${result.data.imported} 封邮件到「${result.data.folder}」${result.data.errors ? `，${result.data.errors} 封失败` : ''}。`,
                  );
                  void useMailStore.getState().selectFolder(result.data.folder);
                });
              }}
            >
              导入 MBOX
            </button>
            <button
              type="button"
              className="btn"
              disabled={!accountId || unified}
              onClick={() => {
                void window.api
                  .exportMbox({ accountId, folder: activeFolder })
                  .then((result) => {
                    if (!result.ok) {
                      if (result.error.code !== 'CANCELLED') setError(result.error.message);
                      return;
                    }
                    setMessage(`已导出 ${result.data.exported} 封邮件到 ${result.data.path}`);
                  });
              }}
            >
              导出当前文件夹为 MBOX
            </button>
          </div>
          <p className="hint">导出为明文归档，选择保存位置前会先要求确认。</p>
        </div>
      </section>

      {pendingRemove ? (
        <ConfirmDialog
          title={
            pendingRemove.kind === 'block'
              ? '解除禁止'
              : pendingRemove.kind === 'warn'
                ? '从提示列表移除'
                : '移除文本预览类型'
          }
          message={
            pendingRemove.kind === 'block'
              ? `确定不再禁止 ${pendingRemove.ext} 吗？之后双击这类文件会回到普通处理。`
              : pendingRemove.kind === 'warn'
                ? `确定把 ${pendingRemove.ext} 从「打开前提示」里移除吗？之后双击这类文件会直接打开，不再确认。`
                : `确定不再把 ${pendingRemove.ext} 当作纯文本预览吗？`
          }
          hint={pendingRemove.kind === 'block' ? '可以在「禁止打开」里随时加回来。' : undefined}
          confirmLabel={pendingRemove.kind === 'block' ? '解除' : '移除'}
          danger={pendingRemove.kind !== 'text'}
          onConfirm={confirmRemove}
          onClose={() => setPendingRemove(null)}
        />
      ) : null}

      {pendingReset ? (
        <ConfirmDialog
          title={
            pendingReset === 'block' ? '恢复默认禁止列表' : '恢复默认提示列表'
          }
          message={
            pendingReset === 'block'
              ? '确定要把「禁止打开」列表恢复成内置默认值吗？你追加的禁止类型都会被覆盖。'
              : '确定要把「打开前提示」列表恢复成内置默认值吗？你追加的提示类型都会被覆盖。'
          }
          hint="内置默认列表不含你手动追加的类型。"
          confirmLabel="恢复默认"
          danger
          onConfirm={confirmReset}
          onClose={() => setPendingReset(null)}
        />
      ) : null}
    </>
  );
}
