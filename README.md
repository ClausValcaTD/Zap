# Strand

A browser-native alternative to Zapier/n8n: a dependency-free TypeScript workflow
engine, plus an interactive builder for composing, configuring and running
workflows entirely in the browser.

## Quick start

```bash
npm install
npm run dev
```

Open the printed URL (default <http://localhost:5173>). The builder loads with a
sample workflow and runs offline out of the box in **simulation mode**, so you can
explore everything before adding credentials.

## Live preview

To serve the optimised production bundle on the runtime's public port:

```bash
npm run build
npm run serve:public
```

Then open the port-12000 URL for this environment. `vite.config.ts` already lists
`*.prod-runtime.all-hands.dev` in `allowedHosts`, which Vite requires before it
will answer requests arriving through the runtime's proxy.

## Deploying to static hosting

`npm run build` emits a fully static `dist/` (no server, no runtime config), so it
drops onto any static host. For example:

```bash
npx surge dist --domain your-name.surge.sh   # requires `npx surge login` first
npx netlify deploy --dir=dist --prod          # requires Netlify auth
npx vercel deploy dist --prod                 # requires Vercel auth
```

Assets are referenced with absolute `/assets/...` paths, so deploy to a domain
root rather than a sub-path.

## Using the builder

**Add nodes** — drag an item from the left library onto the canvas, or click it to
drop at the next free slot.

**Connect nodes** — click a node's output port (right edge), then click the target
node's input port (left edge). Press `Escape` to cancel.

**Delete a connection** — click the edge (it turns indigo) and press `Delete`, or
use the ✕ next to it in the Properties panel.

**Configure a node** — click it to open the Properties panel on the right.

**Move a node** — drag its card. **Arrange everything** — press `Auto-arrange` to
lay the graph out in dependency columns.

**Save your work** — the document auto-saves to `localStorage` on every edit, so a
refresh never loses anything. Use **Export** to download `workflow.json` and
**Import** to paste or load one back.

### Live cycle prevention

As you wire nodes together, every proposed connection is validated by the engine's
own `GraphResolver` — the same code that runs your workflow. Attempting to create
a loop is rejected with a toast naming the offending path, and the graph is left
untouched:

> Cannot connect: creates circular dependency!
> (webhook_… → code_… → ai_… → telegram_… → webhook_…)

## Node library

| Node | Category | What it does |
| --- | --- | --- |
| **Webhook Trigger** | Trigger | Starts the run from an inbound payload (paste your own JSON, or generate a sample). |
| **Manual Trigger** | Trigger | Emits a fixed payload on demand — handy for testing. |
| **LLM Completion** | AI | `POST {baseUrl}/chat/completions`, OpenAI-compatible. Editable system prompt, templated user prompt, temperature. |
| **If Condition** | Logic | Field / operator / value comparison. On failure it prunes its branch instead of failing the run. |
| **Custom JS Function** | Code | Your own async snippet with `inputs`, `flat`, `context` and `console` in scope. |
| **Telegram Dispatcher** | Action | Real `POST https://api.telegram.org/bot<TOKEN>/sendMessage`. |
| **Discord Webhook** | Action | Real incoming-webhook post, with `allowed_mentions` locked down. |

### Template variables

Prompts and message bodies substitute values from upstream nodes:

```
{{ orderId }}              shorthand — searches every parent
{{ webhook.orderId }}      explicit — a specific parent, then a path
```

## Templates

Three starting points ship in the **Templates** dropdown:

1. **E-Commerce Fraud & Dispatch** — Webhook → parallel Currency + Fraud →
   LLM briefing → Telegram. The diamond that demonstrates real parallelism.
2. **AI Support Ticket Triage** — Webhook → LLM analysis → If Negative →
   Telegram alert. Demonstrates conditional branch pruning.
3. **Custom JS Starter** — Webhook → your own snippet → Discord.

## The execution model

**Parallelism.** Nodes are grouped into dependency levels by Kahn's algorithm.
Everything in a level starts in the same wave, so `Currency Converter` and
`Fraud Check` genuinely overlap. The log proves it with identical offsets:

```
+0.40s start    Currency Converter started
+0.40s start    Fraud Check started
```

**Error isolation.** A node that throws is marked `error` and its entire
downstream cone is marked `skipped`, while unrelated branches finish normally.

**Branch pruning.** An `If Condition` node that evaluates to `false` throws an
internal `BranchPruned`. The engine treats this as a *success* — the node reached
a decision — records its verdict, and skips only its descendants. The run's
overall status stays `success`, because a filter doing its job is not a failure.

**Input merging.** A node receives the merged outputs of its **direct** parents,
keyed by parent id. Nodes that benefit from context passing (LLM Completion, If
Condition) offer a *Forward upstream data* option that flattens parent fields into
their own output.

## Enabling the live integrations

Untick **Offline simulation** in Settings to make real network calls.

- **AI** — pick a provider (OpenAI / OpenRouter / Google Gemini) or set a custom
  OpenAI-compatible base URL, then paste an API key.
- **Telegram** — create a bot with [@BotFather](https://t.me/BotFather), paste the
  token and a chat id, and message the bot once so it may reply.
- **Discord** — channel settings → Integrations → Webhooks, then copy the URL.

## Architecture

```
src/
  workflow-engine.ts         # core: types, Kahn's algorithm, async engine, hooks
  lib/
    document.ts              # serialisable WorkflowDocument + validation
    nodeRegistry.ts          # one declarative definition per node type
    compile.ts               # document -> engine definition, graph edits, validation
    template.ts              # {{ }} interpolation and reference resolution
    templates.ts             # pre-built templates, localStorage, export/import
    useWorkflowRunner.ts     # bridges engine hooks into React state
    settings.ts, http.ts     # credentials and fetch helpers
  components/
    NodePalette.tsx          # left library (drag or click to add)
    WorkflowCanvas.tsx       # cards, ports, Bézier edges, direct manipulation
    PropertiesDrawer.tsx     # schema-driven node configuration
    LogPanel.tsx             # execution log
    SettingsDialog.tsx       # credentials
  App.tsx, main.tsx, styles.css
```

Adding a node type means adding **one object** to `nodeRegistry.ts`: its palette
metadata, its config schema, and its executor. The palette, the properties panel,
the compiler and the validator all pick it up automatically.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with HMR. |
| `npm run build` | Typecheck, then bundle to `dist/`. |
| `npm run preview` | Serve the built bundle locally. |
| `npm run serve:public` | Serve the built bundle on port 12000 for the runtime's public URL. |
| `npm run typecheck` | Typecheck without emitting. |
| `npm run engine:demo` | Run the Phase 1 engine demo in the terminal. |

## Security notes

- **Credentials** live in this browser's `localStorage` and are sent only to the
  endpoints you configure. Do not deploy this with a key baked in.
- **The Custom JS node executes arbitrary code** in the page's origin, by design —
  it is the product feature. It can read `localStorage` (including stored keys) and
  make network requests. Treat it as trusted-input-only, and do not host this
  playground on an origin holding credentials you care about.
- **Discord webhook URLs are secrets** — the token is embedded in the URL. They are
  stored as passwords and never logged.
- **Browser-direct calls** require the provider to allow CORS. Telegram and Discord
  webhooks do; some LLM gateways do not, and need a backend proxy.
