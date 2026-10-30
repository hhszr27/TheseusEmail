/**
 * AI 服务商预设（§15）：选择后自动填好端点与默认模型。
 * 主流厂商大多提供 OpenAI 兼容的 /v1 网关，可直接被 OpenAiCompatibleProvider 复用；
 * Ollama 走本机 /v1，无需密钥；自定义则完全由用户填写。
 */

export interface AiProviderPreset {
  id: string;
  label: string;
  /** OpenAI 兼容网关地址，指向 .../v1 或等效路径。 */
  baseUrl: string;
  /** 该服务商推荐的默认模型名。 */
  defaultModel: string;
  /** 是否需要 API Key；本地/Ollama 为 false。 */
  needsKey: boolean;
  /** 可选的提示文案（如兼容网关注意事项）。 */
  hint?: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    needsKey: true,
  },
  {
    id: 'qwen',
    label: '通义千问（阿里云）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    needsKey: true,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
    needsKey: true,
  },
  {
    id: 'kimi',
    label: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    needsKey: true,
  },
  {
    id: 'gemini',
    label: 'Gemini（Google）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaultModel: 'gemini-2.0-flash',
    needsKey: true,
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.1',
    needsKey: false,
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    defaultModel: '',
    needsKey: true,
  },
];

export function aiPresetById(id: string | undefined): AiProviderPreset | null {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}
