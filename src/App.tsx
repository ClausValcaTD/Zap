/**
 * App — the Strand workflow builder.
 *
 * Layout:
 *   ┌ toolbar ────────────────────────────────────────────────┐
 *   │ name · templates · import/export · run/reset · settings   │
 *   ├ palette ─┬ canvas ─────────────────────────┬ properties ─┤
 *   │ node     │ draggable DAG + Bézier edges     │ config for  │
 *   │ library  │                                  │ selection   │
 *   ├──────────┴ execution log ───────────────────┴────────────┤
 *   └──────────────────────────────────────────────────────────┘
 *
 * The document is the single source of truth: every edit produces a new
 * immutable document, which is auto-saved and compiled on Run.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodePalette } from './components/NodePalette';
import { WorkflowCanvas, CARD_HEIGHT } from './components/WorkflowCanvas';
import { PropertiesDrawer } from './components/PropertiesDrawer';
import { LogPanel } from './components/LogPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { useWorkflowRunner } from './lib/useWorkflowRunner';
import {
  addEdge,
  addNode,
  auditDocument,
  autoLayout,
  removeEdge,
  removeNode,
  updateNode,
  validateNewEdge,
} from './lib/compile';
import {
  TEMPLATES,
  downloadDocument,
  loadDocument,
  saveDocument,
  templateById,
} from './lib/templates';
import { parseDocument } from './lib/document';
import type { NodeTypeId, WorkflowDocument } from './lib/document';
import { loadSettings, saveSettings } from './lib/settings';
import type { AppSettings } from './lib/settings';

interface Toast {
  id: number;
  kind: 'error' | 'success' | 'info';
  message: string;
}

export default function App(): JSX.Element {
  const [document, setDocument] = useState<WorkflowDocument>(() => loadDocument());
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [simulate, setSimulate] = useState(true);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pendingSource, setPendingSource] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const runner = useWorkflowRunner();
  const toastId = useRef(0);

  const notify = useCallback((kind: Toast['kind'], message: string): void => {
    const id = (toastId.current += 1);
    setToasts((previous) => [...previous, { id, kind, message }]);
    setTimeout(() => {
      setToasts((previous) => previous.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  // Persist on every change so a refresh never loses work.
  useEffect(() => {
    saveDocument(document);
  }, [document]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  const issues = useMemo(() => auditDocument(document), [document]);
  const selectedNode = useMemo(
    () => document.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [document.nodes, selectedNodeId],
  );

  /* ------------------------------- editing ------------------------------- */

  const handleAddNode = useCallback(
    (type: NodeTypeId, point?: { x: number; y: number }): void => {
      setDocument((previous) => {
        // Click-to-add places the node below the lowest existing card.
        const fallbackY = previous.nodes.reduce(
          (acc, node) => Math.max(acc, node.y + CARD_HEIGHT + 24),
          40,
        );
        const position = point ?? { x: 60, y: fallbackY };
        const result = addNode(previous, { type, x: position.x, y: position.y });
        setSelectedNodeId(result.node.id);
        return result.document;
      });
      setSelectedEdgeId(null);
    },
    [],
  );

  const handleAddNodeAt = useCallback(
    (type: NodeTypeId, x: number, y: number): void => handleAddNode(type, { x, y }),
    [handleAddNode],
  );

  const handleConnect = useCallback(
    (source: string, target: string): void => {
      const problem = validateNewEdge(document, source, target);
      if (problem) {
        // Flash the rejection; the graph is left untouched.
        notify('error', problem);
        setPendingSource(null);
        return;
      }
      setDocument((previous) => addEdge(previous, source, target));
      setPendingSource(null);
      notify('success', 'Connection created.');
    },
    [document, notify],
  );

  const handleMoveNode = useCallback((id: string, x: number, y: number): void => {
    setDocument((previous) =>
      updateNode(previous, id, { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) }),
    );
  }, []);

  const handleRename = useCallback((id: string, name: string): void => {
    setDocument((previous) => updateNode(previous, id, { name }));
  }, []);

  const handleConfigChange = useCallback(
    (id: string, config: Record<string, unknown>): void => {
      setDocument((previous) => updateNode(previous, id, { config }));
    },
    [],
  );

  const handleDeleteNode = useCallback((id: string): void => {
    setDocument((previous) => removeNode(previous, id));
    setSelectedNodeId(null);
  }, []);

  const handleRemoveEdge = useCallback((edgeId: string): void => {
    setDocument((previous) => removeEdge(previous, edgeId));
    setSelectedEdgeId(null);
  }, []);

  /* ------------------------------ workflow ------------------------------- */

  const handleRun = useCallback((): void => {
    // Surface configuration problems before burning a run.
    const blocking = issues.filter((issue) => issue.severity === 'error');
    if (blocking.length > 0) {
      notify('error', `Fix ${blocking.length} configuration issue(s) before running.`);
    }
    void runner.run({ document, settings, simulate });
  }, [document, settings, simulate, runner, issues, notify]);

  const loadTemplate = useCallback(
    (templateId: string): void => {
      const template = templateById(templateId);
      if (!template) return;
      setDocument(template.build());
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setPendingSource(null);
      runner.reset();
      setTemplatesOpen(false);
      notify('success', `Loaded template: ${template.name}`);
    },
    [runner, notify],
  );

  const handleExport = useCallback((): void => {
    downloadDocument(document);
    notify('success', 'Downloaded workflow.json');
  }, [document, notify]);

  const handleImport = useCallback(
    (raw: string): void => {
      try {
        const parsed = parseDocument(JSON.parse(raw));
        setDocument(parsed);
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        runner.reset();
        setImportOpen(false);
        notify('success', `Loaded "${parsed.name}" (${parsed.nodes.length} nodes).`);
      } catch (error) {
        notify('error', error instanceof Error ? error.message : 'Invalid JSON.');
      }
    },
    [runner, notify],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const status of Object.values(runner.statuses)) {
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }, [runner.statuses]);

  const presentTypes = useMemo(
    () => document.nodes.map((node) => node.type),
    [document.nodes],
  );

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-200">
      {/* ------------------------------ toolbar ----------------------------- */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            className="size-7 rounded-lg bg-gradient-to-br from-indigo-500 to-sky-400 shadow-[0_0_16px_rgba(99,102,241,0.45)]"
            aria-hidden="true"
          />
          <div>
            <h1 className="text-[13px] font-semibold leading-tight">Strand</h1>
            <p className="text-[10px] leading-tight text-zinc-500">Workflow builder</p>
          </div>
        </div>

        <input
          className="min-w-40 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-[12px] outline-none focus:border-indigo-500"
          value={document.name}
          aria-label="Workflow name"
          onChange={(event) =>
            setDocument((previous) => ({ ...previous, name: event.target.value }))
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <div className="hidden items-center gap-1.5 lg:flex">
            {(['idle', 'running', 'success', 'error', 'skipped'] as const).map((status) => (
              <span
                key={status}
                className={`rounded-full border px-2 py-0.5 text-[10px] ${
                  status === 'running'
                    ? 'border-sky-500/50 text-sky-400'
                    : status === 'success'
                      ? 'border-green-500/50 text-green-400'
                      : status === 'error'
                        ? 'border-red-500/50 text-red-400'
                        : 'border-zinc-700 text-zinc-500'
                }`}
              >
                {status}
                {statusCounts[status] ? ` · ${statusCounts[status]}` : ''}
              </span>
            ))}
          </div>

          <div className="relative">
            <button
              type="button"
              onClick={() => setTemplatesOpen((open) => !open)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] hover:border-zinc-600"
            >
              Templates ▾
            </button>
            {templatesOpen ? (
              <div className="absolute right-0 z-40 mt-1 w-72 rounded-lg border border-zinc-800 bg-zinc-900 p-1.5 shadow-2xl">
                {TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => loadTemplate(template.id)}
                    className="block w-full rounded-md px-2.5 py-2 text-left hover:bg-zinc-800"
                  >
                    <span className="block text-[12px] font-medium text-zinc-100">
                      {template.name}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-zinc-500">
                      {template.description}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            onClick={() => setDocument((previous) => autoLayout(previous))}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] hover:border-zinc-600"
            title="Arrange nodes by dependency level"
          >
            Auto-arrange
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] hover:border-zinc-600"
          >
            Export
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] hover:border-zinc-600"
          >
            Import
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] hover:border-zinc-600"
          >
            Settings
            {simulate ? <span className="ml-1.5 text-[10px] text-amber-400">sim</span> : null}
          </button>
          <button
            type="button"
            onClick={() => {
              runner.reset();
              setSelectedEdgeId(null);
              setPendingSource(null);
            }}
            disabled={runner.running}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-[12px] hover:border-zinc-600 disabled:opacity-50"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={handleRun}
            disabled={runner.running}
            className="rounded-md bg-indigo-600 px-3.5 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {runner.running ? 'Running…' : 'Run workflow'}
          </button>
        </div>
      </header>

      {/* -------------------------------- body ------------------------------ */}
      <div className="flex min-h-0 flex-1">
        <NodePalette onAdd={handleAddNode} presentTypes={presentTypes} disabled={runner.running} />

        <main className="flex min-w-0 flex-1 flex-col">
          <WorkflowCanvas
            document={document}
            statuses={runner.statuses}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
            pendingSource={pendingSource}
            onSelectNode={(id) => {
              setSelectedNodeId(id);
              if (id) setSelectedEdgeId(null);
            }}
            onSelectEdge={(id) => {
              setSelectedEdgeId(id);
              if (id) setSelectedNodeId(null);
            }}
            onMoveNode={handleMoveNode}
            onArmSource={setPendingSource}
            onConnect={handleConnect}
            onAddNodeAt={handleAddNodeAt}
            onDeleteEdge={handleRemoveEdge}
          />

          {pendingSource ? (
            <div className="shrink-0 border-t border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-300">
              Connecting from{' '}
              <strong>{document.nodes.find((node) => node.id === pendingSource)?.name}</strong> —
              click a highlighted input port. Press Escape to cancel.
            </div>
          ) : (
            <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 px-4 py-1.5 text-[11px] text-zinc-500">
              {document.nodes.length} nodes · {document.edges.length} connections. Click a node to
              configure it; drag from the library to add more.
            </div>
          )}

          <div className="h-[26vh] min-h-40 shrink-0">
            <LogPanel
              entries={runner.log}
              running={runner.running}
              onClear={() => runner.reset()}
            />
          </div>
        </main>

        <PropertiesDrawer
          node={selectedNode}
          document={document}
          settings={settings}
          statuses={runner.statuses}
          records={runner.records}
          issues={issues}
          onRename={handleRename}
          onConfigChange={handleConfigChange}
          onDeleteNode={handleDeleteNode}
          onRemoveEdge={handleRemoveEdge}
          onAddConnection={(sourceId) => setPendingSource(sourceId)}
        />
      </div>

      {/* ------------------------------- overlays --------------------------- */}
      <SettingsDialog
        open={settingsOpen}
        settings={settings}
        simulate={simulate}
        onChange={setSettings}
        onSimulateChange={setSimulate}
        onClose={() => setSettingsOpen(false)}
      />

      {importOpen ? (
        <ImportDialog onClose={() => setImportOpen(false)} onSubmit={handleImport} />
      ) : null}

      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-lg border px-3 py-2 text-[12px] shadow-xl ${
              toast.kind === 'error'
                ? 'border-red-500/50 bg-red-950/90 text-red-200'
                : toast.kind === 'success'
                  ? 'border-green-500/50 bg-green-950/90 text-green-200'
                  : 'border-zinc-700 bg-zinc-900/95 text-zinc-200'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Import dialog
 * -------------------------------------------------------------------------- */

function ImportDialog({
  onClose,
  onSubmit,
}: {
  onClose(): void;
  onSubmit(raw: string): void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (raw: string): void => {
    try {
      JSON.parse(raw);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Invalid JSON.');
      return;
    }
    onSubmit(raw);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Import workflow"
      >
        <h2 className="text-sm font-semibold text-zinc-100">Import workflow JSON</h2>
        <p className="mt-1 text-[11px] text-zinc-500">
          Paste an exported workflow, or choose a <code>workflow.json</code> file.
        </p>

        <input
          type="file"
          accept="application/json,.json"
          className="mt-3 w-full text-[11px] text-zinc-400"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            const contents = await file.text();
            setText(contents);
            setError(null);
          }}
        />

        <textarea
          className="strand-scroll mt-3 h-56 w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-200 outline-none focus:border-indigo-500"
          placeholder='{ "version": 1, "nodes": [...], "edges": [...] }'
          value={text}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
        />

        {error ? <p className="mt-2 text-[11px] text-red-400">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-[12px] hover:border-zinc-600"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => submit(text)}
            disabled={!text.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Load workflow
          </button>
        </div>
      </div>
    </div>
  );
}
