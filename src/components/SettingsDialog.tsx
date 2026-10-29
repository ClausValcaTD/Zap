/**
 * SettingsDialog — credentials and AI provider selection.
 *
 * Values are held in React state and mirrored to `localStorage`. They are sent
 * only to the endpoints the user configures. Secrets are typed as passwords so
 * they are not shoulder-surfed or captured by casual screen recording.
 */
import { PROVIDER_PRESETS } from '../lib/settings';
import type { AiProvider, AppSettings } from '../lib/settings';

export interface SettingsDialogProps {
  open: boolean;
  settings: AppSettings;
  simulate: boolean;
  onChange(settings: AppSettings): void;
  onSimulateChange(value: boolean): void;
  onClose(): void;
}

export function SettingsDialog(props: SettingsDialogProps): JSX.Element | null {
  const { open, settings, onChange, simulate } = props;
  if (!open) return null;

  const patch = (partial: Partial<AppSettings>): void => onChange({ ...settings, ...partial });

  const onProviderChange = (provider: AiProvider): void => {
    if (provider === 'custom') {
      patch({ aiProvider: provider });
      return;
    }
    const preset = PROVIDER_PRESETS[provider];
    patch({ aiProvider: provider, aiBaseUrl: preset.baseUrl, aiModel: preset.model });
  };

  const field =
    'w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-indigo-500';
  const label = 'text-[10px] uppercase tracking-widest text-zinc-500';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 sm:items-center"
      onClick={props.onClose}
      role="presentation"
    >
      <div
        className="strand-scroll my-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Settings</h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Stored only in this browser&apos;s localStorage.
            </p>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded px-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={simulate}
            onChange={(event) => props.onSimulateChange(event.target.checked)}
          />
          <span>
            <span className="block text-[12px] font-medium text-zinc-100">
              Offline simulation
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">
              Run LLM and messaging nodes with canned results. No keys needed, no network calls.
            </span>
          </span>
        </label>

        <fieldset className="mt-4 space-y-3 rounded-lg border border-zinc-800 p-3">
          <legend className={`${label} px-1`}>AI provider</legend>
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-provider" className={label}>
              Provider
            </label>
            <select
              id="ai-provider"
              className={field}
              value={settings.aiProvider}
              onChange={(event) => onProviderChange(event.target.value as AiProvider)}
            >
              {Object.entries(PROVIDER_PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom (OpenAI-compatible)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="ai-base" className={label}>
              Base URL
            </label>
            <input
              id="ai-base"
              className={field}
              value={settings.aiBaseUrl}
              spellCheck={false}
              onChange={(event) => patch({ aiBaseUrl: event.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="ai-model" className={label}>
              Model
            </label>
            <input
              id="ai-model"
              className={field}
              value={settings.aiModel}
              spellCheck={false}
              onChange={(event) => patch({ aiModel: event.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="ai-key" className={label}>
              API key
            </label>
            <input
              id="ai-key"
              type="password"
              autoComplete="off"
              className={field}
              value={settings.aiApiKey}
              placeholder="sk-..."
              spellCheck={false}
              onChange={(event) => patch({ aiApiKey: event.target.value })}
            />
          </div>
        </fieldset>

        <fieldset className="mt-4 space-y-3 rounded-lg border border-zinc-800 p-3">
          <legend className={`${label} px-1`}>Telegram</legend>
          <div className="flex flex-col gap-1">
            <label htmlFor="tg-token" className={label}>
              Bot token
            </label>
            <input
              id="tg-token"
              type="password"
              autoComplete="off"
              className={field}
              value={settings.telegramToken}
              placeholder="123456:ABC-DEF..."
              spellCheck={false}
              onChange={(event) => patch({ telegramToken: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tg-chat" className={label}>
              Chat id
            </label>
            <input
              id="tg-chat"
              className={field}
              value={settings.telegramChatId}
              placeholder="@channel or 123456789"
              spellCheck={false}
              onChange={(event) => patch({ telegramChatId: event.target.value })}
            />
          </div>
          <p className="text-[10px] leading-snug text-zinc-600">
            Create a bot with @BotFather, then message it once so it may reply.
          </p>
        </fieldset>

        <fieldset className="mt-4 space-y-3 rounded-lg border border-zinc-800 p-3">
          <legend className={`${label} px-1`}>Discord</legend>
          <div className="flex flex-col gap-1">
            <label htmlFor="dc-hook" className={label}>
              Incoming webhook URL
            </label>
            <input
              id="dc-hook"
              type="password"
              autoComplete="off"
              className={field}
              value={settings.discordWebhookUrl}
              placeholder="https://discord.com/api/webhooks/..."
              spellCheck={false}
              onChange={(event) => patch({ discordWebhookUrl: event.target.value })}
            />
          </div>
          <p className="text-[10px] leading-snug text-zinc-600">
            Treat this URL as a secret — the token is embedded in it. Channel settings → Integrations
            → Webhooks.
          </p>
        </fieldset>

        <button
          type="button"
          onClick={props.onClose}
          className="mt-5 w-full rounded-md bg-indigo-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-indigo-500"
        >
          Done
        </button>
      </div>
    </div>
  );
}
