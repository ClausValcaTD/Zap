/**
 * PropertiesDrawer — configures the selected node.
 *
 * Fields are rendered from the node registry's schema, so a new node type
 * automatically gets a working editor. It also surfaces live validation, the
 * node's connections, and its latest run output.
 */
import { definitionFor, withDefaults } from '../lib/nodeRegistry';
import type { FieldSchema } from '../lib/nodeRegistry';
import { listReferences } from '../lib/template';
import type { DocumentNode, WorkflowDocument } from '../lib/document';
import type { AppSettings } from '../lib/settings';
import type { NodeRecord, StatusMap } from '../lib/useWorkflowRunner';
import type { ValidationIssue } from '../lib/compile';

export interface PropertiesDrawerProps {
  node: DocumentNode | null;
  document: WorkflowDocument;
  settings: AppSettings;
  statuses: StatusMap;
  records: Record<string, NodeRecord>;
  issues: readonly ValidationIssue[];
  onRename(id: string, name: string): void;
  onConfigChange(id: string, config: Record<string, unknown>): void;
  onDeleteNode(id: string): void;
  onRemoveEdge(edgeId: string): void;
  onAddConnection(sourceId: string): void;
}

export function PropertiesDrawer(props: PropertiesDrawerProps): JSX.Element {
  const { node, document: workflow, settings, statuses, records, issues } = props;

  if (!node) {
    return (
      <aside className="strand-scroll w-80 shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-950/60 p-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
          Properties
        </h2>
        <p className="mt-3 text-[12px] leading-relaxed text-zinc-500">
          Select a node to configure it, or drag one in from the library.
        </p>

        {issues.length > 0 ? (
          <div className="mt-5">
            <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
              Checks
            </h3>
            <ul className="mt-2 space-y-1.5">
              {issues.map((issue, index) => (
                <li
                  key={index}
                  className={`rounded-md border px-2 py-1.5 text-[11px] leading-snug ${
                    issue.severity === 'error'
                      ? 'border-red-500/40 bg-red-500/10 text-red-300'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-5 rounded-md border border-green-500/30 bg-green-500/10 px-2 py-1.5 text-[11px] text-green-300">
            Graph looks valid.
          </p>
        )}
      </aside>
    );
  }

  const definition = definitionFor(node.type);
  const config = withDefaults(node.type, node.config);
  const record = records[node.id];
  const status = statuses[node.id] ?? 'idle';
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);

  const incoming = workflow.edges.filter((edge) => edge.target === node.id);
  const outgoing = workflow.edges.filter((edge) => edge.source === node.id);
  const nameOf = (id: string): string =>
    workflow.nodes.find((candidate) => candidate.id === id)?.name ?? id;

  const setField = (key: string, value: unknown): void =>
    props.onConfigChange(node.id, { ...config, [key]: value });

  return (
    <aside className="strand-scroll flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-zinc-800 bg-zinc-950/60 p-4">
      <header>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] uppercase tracking-widest text-zinc-500">
            {definition?.category ?? 'node'}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
              status === 'success'
                ? 'border-green-500/50 text-green-400'
                : status === 'error'
                  ? 'border-red-500/50 text-red-400'
                  : status === 'running'
                    ? 'border-sky-500/50 text-sky-400'
                    : 'border-zinc-700 text-zinc-400'
            }`}
          >
            {status}
          </span>
        </div>
        <h2 className="mt-1 text-sm font-semibold text-zinc-100">{definition?.label ?? node.type}</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{definition?.blurb}</p>
      </header>

      {nodeIssues.length > 0 ? (
        <ul className="space-y-1.5">
          {nodeIssues.map((issue, index) => (
            <li
              key={index}
              className={`rounded-md border px-2 py-1.5 text-[11px] ${
                issue.severity === 'error'
                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">Display name</span>
        <input
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-indigo-500"
          value={node.name}
          onChange={(event) => props.onRename(node.id, event.target.value)}
        />
      </label>

      {/* Schema-driven fields. */}
      {definition?.fields
        .filter((field) => !field.visibleWhen || field.visibleWhen(config))
        .map((field) => (
          <FieldEditor
            key={field.key}
            field={field}
            value={config[field.key]}
            onChange={(value) => setField(field.key, value)}
          />
        ))}

      {/* Credential readiness. */}
      {definition?.requires?.length ? (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
          <h3 className="text-[10px] uppercase tracking-widest text-zinc-500">Credentials</h3>
          <ul className="mt-1.5 space-y-1">
            {definition.requires.map((key) => {
              const present = String(settings[key] ?? '').trim().length > 0;
              return (
                <li key={key} className="flex items-center justify-between text-[11px]">
                  <span className="font-mono text-zinc-400">{key}</span>
                  <span className={present ? 'text-green-400' : 'text-amber-400'}>
                    {present ? 'set' : 'missing'}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-600">
            Configure under Settings. Simulation mode bypasses these.
          </p>
        </div>
      ) : null}

      {/* Template reference hints for prompt-bearing nodes. */}
      {definition?.fields.some((field) => field.kind === 'textarea') ? (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
          <h3 className="text-[10px] uppercase tracking-widest text-zinc-500">
            Available variables
          </h3>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {incoming.length === 0 ? (
              <span className="text-[11px] text-zinc-600">Connect an upstream node first.</span>
            ) : (
              incoming.map((edge) => (
                <code
                  key={edge.id}
                  className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-sky-300"
                >
                  {`{{ ${edge.source}.field }}`}
                </code>
              ))
            )}
          </div>
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-600">
            Shorthand <code className="text-sky-300">{'{{ field }}'}</code> searches all parents.
          </p>
        </div>
      ) : null}

      {/* Connections. */}
      <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500">Connections</h3>
        <div className="mt-1.5 space-y-1.5">
          {incoming.map((edge) => (
            <div key={edge.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-zinc-400">← {nameOf(edge.source)}</span>
              <button
                type="button"
                onClick={() => props.onRemoveEdge(edge.id)}
                className="shrink-0 rounded px-1 text-zinc-500 hover:bg-red-500/20 hover:text-red-400"
                title="Remove connection"
              >
                ✕
              </button>
            </div>
          ))}
          {outgoing.map((edge) => (
            <div key={edge.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-zinc-400">→ {nameOf(edge.target)}</span>
              <button
                type="button"
                onClick={() => props.onRemoveEdge(edge.id)}
                className="shrink-0 rounded px-1 text-zinc-500 hover:bg-red-500/20 hover:text-red-400"
                title="Remove connection"
              >
                ✕
              </button>
            </div>
          ))}
          {incoming.length === 0 && outgoing.length === 0 ? (
            <span className="text-[11px] text-zinc-600">Not connected.</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => props.onAddConnection(node.id)}
          className="mt-2 w-full rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:border-sky-500 hover:text-sky-300"
        >
          Start a connection from here
        </button>
      </div>

      {/* Latest run data. */}
      <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-2.5">
        <h3 className="text-[10px] uppercase tracking-widest text-zinc-500">Last run</h3>
        {record === undefined ? (
          <p className="mt-1.5 text-[11px] text-zinc-600">Not run yet.</p>
        ) : (
          <div className="mt-1.5 space-y-2">
            <div className="flex gap-3 text-[11px] text-zinc-400">
              <span>Duration: {record.durationMs ?? 0} ms</span>
            </div>
            {record.pruned ? (
              <pre className="rounded bg-amber-500/10 p-2 text-[10px] text-amber-300">
                {record.pruned}
              </pre>
            ) : null}
            {record.error ? (
              <pre className="strand-scroll max-h-28 overflow-auto rounded bg-red-500/10 p-2 text-[10px] text-red-300">
                {record.error}
              </pre>
            ) : null}
            <details open>
              <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-zinc-500">
                Output
              </summary>
              <pre className="strand-scroll mt-1 max-h-40 overflow-auto rounded bg-zinc-950 p-2 text-[10px] leading-relaxed text-zinc-300">
                {record.output ? JSON.stringify(record.output, null, 2) : '—'}
              </pre>
            </details>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => props.onDeleteNode(node.id)}
        className="mt-auto rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[11px] font-medium text-red-300 hover:bg-red-500/20"
      >
        Delete node
      </button>
    </aside>
  );
}

/* -------------------------------------------------------------------------- *
 * Field renderers
 * -------------------------------------------------------------------------- */

function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: FieldSchema;
  value: unknown;
  onChange(value: unknown): void;
}): JSX.Element {
  const id = `field-${field.key}`;
  const references =
    field.kind === 'textarea' || field.kind === 'text' ? listReferences(String(value ?? '')) : [];

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[10px] uppercase tracking-widest text-zinc-500">
        {field.label}
      </label>

      {field.kind === 'select' ? (
        <select
          id={id}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-indigo-500"
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.kind === 'number' ? (
        <input
          id={id}
          type="number"
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-indigo-500"
          value={Number(value ?? 0)}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      ) : field.kind === 'textarea' || field.kind === 'code' ? (
        <textarea
          id={id}
          rows={field.kind === 'code' ? 12 : 4}
          spellCheck={false}
          className={`strand-scroll rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-[12px] leading-relaxed text-zinc-100 outline-none focus:border-indigo-500 ${
            field.kind === 'code' ? 'font-mono text-[11px]' : ''
          }`}
          value={String(value ?? '')}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[12px] text-zinc-100 outline-none focus:border-indigo-500"
          value={String(value ?? '')}
          placeholder={field.placeholder}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {field.help ? (
        <p className="text-[10px] leading-snug text-zinc-600">{field.help}</p>
      ) : null}

      {references.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {references.map((reference) => (
            <code key={reference} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-sky-300">
              {`{{ ${reference} }}`}
            </code>
          ))}
        </div>
      ) : null}
    </div>
  );
}
