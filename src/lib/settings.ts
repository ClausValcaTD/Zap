/**
 * Browser-local persistence for credentials and endpoint settings.
 * Everything stays in the user's own `localStorage`; nothing is ever sent
 * anywhere except the endpoints the user explicitly configures.
 */

export type AiProvider = 'openai' | 'openrouter' | 'gemini' | 'custom';

export interface AppSettings {
  /** OpenAI-compatible provider preset (drives the default base URL/model). */
  aiProvider: AiProvider;
  /** Chat-completions base URL, e.g. `https://api.openai.com/v1`. */
  aiBaseUrl: string;
  aiModel: string;
  aiApiKey: string;
  /** Telegram bot token from @BotFather. */
  telegramToken: string;
  /** Target chat id (numeric id, `@channelname`, or `-100...` for groups). */
  telegramChatId: string;
  /**
   * Discord incoming-webhook URL. Treat as a secret: the token is embedded in
   * the URL itself.
   */
  discordWebhookUrl: string;
}

export const PROVIDER_PRESETS: Record<
  Exclude<AiProvider, 'custom'>,
  { label: string; baseUrl: string; model: string; docs: string }
> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/api-keys',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    docs: 'https://openrouter.ai/keys',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    docs: 'https://aistudio.google.com/app/apikey',
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  aiProvider: 'openai',
  aiBaseUrl: PROVIDER_PRESETS.openai.baseUrl,
  aiModel: PROVIDER_PRESETS.openai.model,
  aiApiKey: '',
  telegramToken: '',
  telegramChatId: '',
  discordWebhookUrl: '',
};

const STORAGE_KEY = 'zap.playground.settings.v1';

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage disabled (private mode); settings simply won't persist */
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
