// The requests graph: the To-dos page's "By request" grouping (lib/request-graph.ts). Every request the owner made as a
// small DAG drawn left to right: the owner's words, then each piece of work in layers by what it waits for (thin
// connectors with a hollow dot where they leave a card; dashed into a piece still queued). A piece says where it stands
// and which Agent is on it; hovering or focusing it lights it, what it waits for and what waits for it, and dims the
// rest. A piece with a to-do opens that to-do on the page, as a row does. Finished requests fold to one line each under
// "Done"; the pieces still queued are listed under the graph. Everything is the hub's own data.
import { useMemo, useState, type CSSProperties } from "react";
import { t } from "../i18n";
import { agentName, sessionAgent } from "../lib/agent-kind";
import { useDirectionTree } from "../lib/direction-tree";
import { useFeed } from "../lib/feed";
import { clock, sessionTitle, shortDuration } from "../lib/format";
import { machineWithHub } from "../lib/mesh";
import {
  buildGraph, CARD_H, CARD_W, layoutRequest, lineage, MERGED_H, queuedRows,
  type GraphNode, type GraphRequest, type NodeAgent, type NodeState, type QueueRow,
} from "../lib/request-graph";
import { effortLabel } from "../lib/routines";
import { modelLabel } from "../lib/session-models";
import { stateName } from "../lib/state-labels";
import type { SessionLookup, Todo } from "../lib/todos";
import type { Machine } from "../lib/types";
import { AgentMark } from "../ui/AgentMark";
import { Button, cx, useNow } from "../ui/atoms";
import { Icon } from "../ui/icons";
import { tipHandlers, useTips, type TipApi } from "./TodoRequestGraphTip";

/** The connectors' tones, from the theme's own: a line between the soft line color and the muted ink, and a fainter
 *  one into a piece still queued. Set on the view, so nothing reaches the page's shared styles. */
const EDGE_TONES = {
  "--edge": "color-mix(in srgb, var(--ink-3) 42%, var(--surface))",
  "--edge-muted": "color-mix(in srgb, var(--ink-3) 30%, var(--surface))",
} as CSSProperties;
/** The piece lit by the pointer or the focus: its request and its key. */
type Hot = { req: string; key: string } | null;
/** How often "now" moves: a working piece says how long it has worked, in minutes. */
const TICK_MS = 15_000;

// ── how a state looks ───────────────────────────────────────

/** A state's word: the app's own state names where it has one (lib/state-labels.ts), the graph's for the rest. */
function stateWord(n: Pick<GraphNode, "state" | "waitsStart">): string {
  switch (n.state) {
    case "queued": return n.waitsStart ? t("request-graph.state_planned") : t("request-graph.state_queued");
    case "ready": return t("request-graph.state_ready");
    case "working": return stateName("working");
    case "needs_you": return stateName("needs_you");
    case "review": return t("assistant-tasks.review_pending");
    case "stopped": return stateName("follow_up");
    case "done": return stateName("done");
    case "failed": return stateName("failed");
  }
}

/** The tag's tone (background and text) and its dot. */
const TAG: Record<NodeState, { tag: string; dot: string }> = {
  queued: { tag: "bg-field text-ink-2", dot: "" },
  ready: { tag: "bg-field text-accent-ink", dot: "var(--accent)" },
  working: { tag: "bg-orange-tint text-orange", dot: "var(--status-working)" },
  needs_you: { tag: "bg-field text-attention", dot: "var(--status-needs)" },
  review: { tag: "bg-green-tint text-green", dot: "var(--status-unread)" },
  stopped: { tag: "bg-field text-ink-2", dot: "var(--ink-3)" },
  done: { tag: "bg-field text-ink-3", dot: "" },
  failed: { tag: "bg-field text-red", dot: "var(--red)" },
};

/** A state's dot: filled in its tone, hollow for one that waits. */
function Dot({ color }: { color: string }) {
  return color ? <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: color }} /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-ink-3" />;
}

function StateTag({ node }: { node: Pick<GraphNode, "state" | "waitsStart"> }) {
  const tone = TAG[node.state];
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center gap-1 rounded-chip px-1.5 text-xs leading-4 font-medium whitespace-nowrap", tone.tag)} data-node-state={node.state}>
      {node.state === "done" ? <Icon name="check" size={11} /> : <Dot color={tone.dot} />}
      {stateWord(node)}
    </span>
  );
}

/** "Opus · High · MacBook": on what and where it runs; the mark beside it says which Agent (`named`: say it in words too). */
function agentLine(a: NodeAgent, machines: Machine[], named = false): string {
  const s = a.session;
  const model = s?.model ? modelLabel(s.model) : "";
  const who = a.subagent ? a.title || t("request-graph.subagent") : named || !model ? agentName(s?.agent ?? a.agent, s?.agent_label) : "";
  return [who, model, s?.effort ? effortLabel(s.effort) : "", machineWithHub(a.mid, machines)].filter(Boolean).join(" · ");
}

/** An open plan's task: what it will run on, where. */
function taskLine(n: GraphNode, machines: Machine[]): string {
  const task = n.task;
  if (!task) return "";
  return [task.launcher ? agentName(task.launcher) : "", task.model ? modelLabel(task.model) : "", task.effort ? effortLabel(task.effort) : "", task.machine ? machineWithHub(task.machine, machines) : ""].filter(Boolean).join(" · ");
}

const names = (list: (GraphNode | undefined)[]) => list.map((n) => n?.title ?? "").filter(Boolean).join(t("request-graph.list_sep"));

/** The line beside a piece's tag: how long it works, what it waits for, what it asks, why it did not start. */
function detail(n: GraphNode, req: GraphRequest, now: number): string {
  const byKey = new Map(req.nodes.map((x) => [x.key, x]));
  switch (n.state) {
    case "queued": return n.waitsStart ? t("request-graph.waits_start") : t("request-graph.waits_for", { names: names(n.waitsFor.map((k) => byKey.get(k))) });
    case "working": return n.since !== undefined ? shortDuration(Math.max(0, now - n.since)) : "";
    case "needs_you": case "failed": case "review": return n.ask;
    case "done": return n.todo?.done_at ? clock(n.todo.done_at) : "";
    default: return "";
  }
}

// ── the view ────────────────────────────────────────────────

export default function TodoRequestGraph({ todos, lookup, machines, selectedId, onOpenTodo }: {
  todos: readonly Todo[]; lookup: SessionLookup; machines: Machine[]; selectedId?: string; onOpenTodo: (id: string) => void;
}) {
  const plans = useFeed((s) => s.plans);
  const tree = useDirectionTree();
  const now = useNow(TICK_MS);
  const graph = useMemo(() => buildGraph({ todos, plans, data: { tree, todos, lookup } }), [todos, plans, tree, lookup]);
  const queue = useMemo(() => queuedRows(graph), [graph]);
  const [hot, setHot] = useState<Hot>(null);
  const tips = useTips();
  return (
    <section aria-label={t("request-graph.label")} className="@container flex min-h-0 flex-1 flex-col" data-graph="" style={EDGE_TONES}>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain" data-graph-zone="">
        {/* as wide as the widest request, so every request's rule runs the whole way when the page scrolls sideways */}
        <div className="w-max min-w-full">
          {graph.active.length === 0 && graph.done.length === 0 ? <Empty /> : graph.active.length === 0 ? <AllDone /> : null}
          {graph.active.map((req) => (
            <RequestBlock key={req.key} req={req} machines={machines} now={now} selectedId={selectedId} hot={hot?.req === req.key ? hot.key : null} tips={tips.api}
              onHot={(key) => setHot(key ? { req: req.key, key } : null)} onOpenTodo={onOpenTodo} />
          ))}
          {graph.done.length > 0 && <DoneFold done={graph.done} machines={machines} now={now} selectedId={selectedId} tips={tips.api} hot={hot} onHot={setHot} onOpenTodo={onOpenTodo} />}
        </div>
      </div>
      <QueuedStrip rows={queue} selectedId={selectedId} onHot={setHot} onOpenTodo={onOpenTodo} />
      {tips.layer}
    </section>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center" data-graph-empty="">
      <span className="flex size-9 items-center justify-center rounded-control bg-canvas text-ink-3"><Icon name="workflow" size={18} /></span>
      <h3 className="text-sm font-semibold text-ink">{t("request-graph.empty_title")}</h3>
      <p className="max-w-sm text-xs leading-5 text-ink-3">{t("request-graph.empty_body")}</p>
    </div>
  );
}

function AllDone() {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-xs text-ink-3" data-graph-all-done="">
      <Icon name="check" size={13} className="text-green" />
      {t("request-graph.all_done")}
    </div>
  );
}

// ── one request ─────────────────────────────────────────────

function RequestBlock({ req, machines, now, selectedId, hot, tips, onHot, onOpenTodo, flat }: {
  req: GraphRequest; machines: Machine[]; now: number; selectedId?: string; hot: string | null; tips: TipApi; onHot: (key: string | null) => void;
  onOpenTodo: (id: string) => void; flat?: boolean;
}) {
  const lay = useMemo(() => layoutRequest(req), [req]);
  const lit = useMemo(() => (hot && hot !== "root" ? lineage(req, hot) : null), [req, hot]);
  // edges in the lit lineage are drawn last, over the dimmed ones
  const edges = lit ? [...lay.edges].sort((a, b) => Number(lit.has(a.from) && lit.has(a.to)) - Number(lit.has(b.from) && lit.has(b.to))) : lay.edges;
  const dots = new Map<string, { at: [number, number]; on: boolean; muted: boolean }>();
  for (const e of edges) {
    const k = e.dot.join(",");
    const on = !lit || lit.has(e.from);
    const d = dots.get(k);
    dots.set(k, { at: e.dot, on: (d?.on ?? false) || on, muted: (d?.muted ?? true) && e.dashed });
  }
  return (
    <div className={cx("px-3 py-2", !flat && "border-b border-line")} data-request={req.key} data-request-kind={req.kind}>
      <div className="relative" style={{ width: lay.width, height: lay.height }}>
        <svg width={lay.width} height={lay.height} className="pointer-events-none absolute inset-0 block overflow-visible" aria-hidden data-edges="">
          {edges.map((e) => {
            const on = Boolean(lit && lit.has(e.from) && lit.has(e.to));
            const dim = Boolean(lit) && !on;
            return (
              <path key={`${e.from}>${e.to}`} d={e.d} fill="none" strokeWidth={on ? 1.75 : 1.25} strokeLinecap="round" strokeDasharray={e.dashed ? "3 3" : undefined}
                className="transition-[stroke,opacity] duration-150" data-edge={`${e.from}>${e.to}`} data-lit={on ? "" : undefined}
                style={{ stroke: on ? "var(--accent)" : e.dashed ? "var(--edge-muted)" : "var(--edge)", opacity: dim ? 0.35 : 1 }} />
            );
          })}
          {[...dots.values()].map((d) => (
            <circle key={d.at.join(",")} cx={d.at[0]} cy={d.at[1]} r={3} strokeWidth={1.25} className="transition-[stroke,opacity] duration-150"
              style={{ fill: "var(--surface)", stroke: lit && d.on ? "var(--accent)" : d.muted ? "var(--edge-muted)" : "var(--edge)", opacity: lit && !d.on ? 0.35 : 1 }} />
          ))}
        </svg>
        {!req.merged && <RootCard req={req} at={lay.root} selected={Boolean(req.root) && req.root!.id === selectedId} tips={tips} onOpenTodo={onOpenTodo} onHot={onHot} />}
        {req.nodes.map((n) => {
          const p = lay.nodes.get(n.key)!;
          return <NodeCard key={n.key} node={n} req={req} x={p.x} y={p.y} machines={machines} now={now} dim={Boolean(lit) && !lit!.has(n.key)} lit={hot === n.key}
            selected={Boolean(n.todo) && n.todo!.id === selectedId} tips={tips} onHot={onHot} onOpenTodo={onOpenTodo} />;
        })}
      </div>
    </div>
  );
}

/** The root's label: the owner's words, or the title they were filed under. */
const rootLabel = (req: GraphRequest) => (req.own ? t("request-graph.root_words") : t("request-graph.root_title"));

function RootCard({ req, at, selected, tips, onOpenTodo, onHot }: { req: GraphRequest; at: { x: number; y: number }; selected: boolean; tips: TipApi; onOpenTodo: (id: string) => void; onHot: (key: string | null) => void }) {
  const done = req.nodes.filter((n) => n.state === "done").length;
  const label = rootLabel(req);
  const th = tipHandlers(tips, () => (
    <>
      <p className="text-xs text-tooltip-muted">{label}{req.at ? ` · ${clock(req.at)}` : ""}</p>
      <p className="break-words whitespace-pre-line">{req.words}</p>
      {req.root && <p className="border-t border-tooltip-border pt-1 text-xs text-tooltip-muted">{t("request-graph.tip_open_todo")}</p>}
    </>
  ));
  const body = (
    <>
      <span className="flex h-5 items-center gap-1.5 text-xs leading-4 text-ink-3">
        <Icon name={req.kind === "plan" ? "spark" : "quote"} size={11} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {req.at && <span className="shrink-0 tabular-nums">{clock(req.at)}</span>}
      </span>
      <span className="mt-1.5 line-clamp-2 max-h-8 shrink-0 overflow-hidden text-xs leading-4 break-words text-ink" data-root-words="">{req.words}</span>
      <span className="mt-auto flex h-4 items-center gap-1.5 text-xs leading-4 text-ink-3 tabular-nums">
        {req.nodes.length > 1 && <Progress done={done} total={req.nodes.length} />}
        <span className="truncate">{req.nodes.length > 1 ? t("request-graph.progress", { done, total: req.nodes.length }) : t("request-graph.pieces", { count: req.nodes.length })}</span>
      </span>
    </>
  );
  const cls = cx("absolute flex flex-col overflow-hidden rounded-control bg-canvas px-2.5 py-2 text-left", selected && "ring-2 ring-accent");
  const style = { left: at.x, top: at.y, width: CARD_W, height: CARD_H };
  if (req.root) {
    const id = req.root.id;
    return (
      <button type="button" className={cx(cls, "hover:bg-hover-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none")} style={style} data-root={req.key} aria-current={selected || undefined}
        {...th} onFocus={(e) => { th.onFocus(e); onHot(null); }} onClick={() => onOpenTodo(id)}>
        {body}
      </button>
    );
  }
  return <div className={cls} style={style} data-root={req.key} onPointerEnter={th.onPointerEnter} onPointerLeave={th.onPointerLeave}>{body}</div>;
}

/** Done of total, as a thin bar. */
function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span aria-hidden className="relative h-1 w-10 shrink-0 overflow-hidden rounded-full bg-hover-2">
      <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(done / Math.max(1, total)) * 100}%`, background: "var(--status-unread)" }} />
    </span>
  );
}

function NodeCard({ node, req, x, y, machines, now, dim, lit, selected, tips, onHot, onOpenTodo }: {
  node: GraphNode; req: GraphRequest; x: number; y: number; machines: Machine[]; now: number; dim: boolean; lit: boolean; selected: boolean; tips: TipApi;
  onHot: (key: string | null) => void; onOpenTodo: (id: string) => void;
}) {
  const line = detail(node, req, now);
  const current = node.agents.filter((a) => a.role !== "before");
  const lead = current[0];
  const queued = node.state === "queued";
  const th = tipHandlers(tips, () => <NodeTip node={node} req={req} machines={machines} now={now} />);
  const shared = {
    "data-node": node.key, "data-state": node.state, "data-lit": lit ? "" : undefined, "data-dim": dim ? "" : undefined,
    style: { left: x, top: y, width: CARD_W, height: req.merged ? MERGED_H : CARD_H } as CSSProperties,
    onPointerEnter: (e: React.PointerEvent<Element>) => { th.onPointerEnter(e); onHot(node.key); },
    onPointerLeave: (e: React.PointerEvent<Element>) => { th.onPointerLeave(e); onHot(null); },
    className: cx(
      "absolute flex flex-col overflow-hidden rounded-control px-2.5 py-2 text-left transition-[opacity,box-shadow,background-color] duration-150 focus-visible:outline-none",
      queued ? "border border-dashed border-line-strong bg-surface" : "bg-surface shadow-card",
      node.todo && "hover:bg-hover",
      node.state === "needs_you" && "shadow-[inset_2px_0_0_var(--status-needs),var(--shadow-card)]",
      (lit || selected) && "ring-2 ring-accent",
      "focus-visible:ring-2 focus-visible:ring-accent",
      dim && "opacity-40",
      node.state === "done" && !dim && "opacity-75",
    ),
  };
  const body = (
    <>
      {req.merged && (
        // the request and the piece say the same: one card, with what the root card would have said of when
        <span className="mb-1 flex h-4 min-w-0 items-center gap-1.5 text-xs leading-4 text-ink-3" data-node-request="">
          <Icon name={req.kind === "plan" ? "spark" : "quote"} size={11} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{rootLabel(req)}</span>
          {req.at && <span className="shrink-0 tabular-nums">{clock(req.at)}</span>}
        </span>
      )}
      <span className="flex h-5 min-w-0 items-center gap-1.5">
        <StateTag node={node} />
        {line && (
          <span className={cx("min-w-0 flex-1 truncate text-xs leading-4", node.state === "working" ? "text-right text-ink-3 tabular-nums" : node.state === "needs_you" ? "text-ink-2" : "text-ink-3")} data-node-detail="">{line}</span>
        )}
      </span>
      <span className={cx("mt-1.5 line-clamp-2 max-h-8 overflow-hidden text-xs leading-4 font-medium break-words", node.state === "done" ? "text-ink-2" : "text-ink")} data-node-title="">{node.title}</span>
      <span className="mt-auto flex h-5 min-w-0 items-center gap-1.5 text-xs leading-4 text-ink-3" data-node-agent={lead ? lead.key : ""}>
        {lead ? (
          <>
            <Marks agents={current} />
            <span className="min-w-0 flex-1 truncate">{agentLine(lead, machines)}</span>
          </>
        ) : node.task ? (
          <>
            {node.task.launcher && <span className="flex size-4 shrink-0 items-center justify-center rounded-chip opacity-60"><AgentMark agent={node.task.launcher} size={11} decorative /></span>}
            <span className="min-w-0 flex-1 truncate">{taskLine(node, machines) || t("request-graph.no_agent")}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate italic" data-no-agent="">{t("request-graph.no_agent")}</span>
        )}
      </span>
    </>
  );
  // a task of a plan not started yet has no to-do to open: a card with its hover card only
  if (!node.todo) return <div {...shared}>{body}</div>;
  const id = node.todo.id;
  return (
    <button type="button" {...shared} aria-current={selected || undefined} onClick={() => onOpenTodo(id)}
      onPointerDown={th.onPointerDown} onFocus={(e) => { th.onFocus(e); onHot(node.key); }} onBlur={(e) => { th.onBlur(e); onHot(null); }}>
      {body}
    </button>
  );
}

/** Up to three Agent marks, each a little over the one before, then "+n". */
function Marks({ agents }: { agents: NodeAgent[] }) {
  const shown = agents.length > 3 ? agents.slice(0, 2) : agents;
  const more = agents.length - shown.length;
  return (
    <span className="flex shrink-0 items-center" data-marks={agents.length}>
      {shown.map((a, i) => (
        <span key={a.key} className={cx("flex size-4 items-center justify-center rounded-chip bg-surface shadow-hairline", i > 0 && "-ml-1")}>
          {a.subagent ? <Icon name="cornerDownRight" size={10} className="text-ink-3" /> : <AgentMark {...(a.session ? sessionAgent(a.session) : { agent: a.agent })} size={10} decorative />}
        </span>
      ))}
      {more > 0 && <span className="-ml-1 flex h-4 min-w-4 items-center justify-center rounded-chip bg-field px-1 text-xs leading-4 font-medium text-ink-2 tabular-nums shadow-hairline">+{more}</span>}
    </span>
  );
}

const ROLE_KEY: Record<NodeAgent["role"], string> = {
  lead: "",
  worker: "request-graph.role_worker",
  spawned: "request-graph.role_spawned",
  subagent: "request-graph.subagent",
  before: "request-graph.agent_before",
};

function NodeTip({ node, req, machines, now }: { node: GraphNode; req: GraphRequest; machines: Machine[]; now: number }) {
  const byKey = new Map(req.nodes.map((x) => [x.key, x]));
  const line = detail(node, req, now);
  const waits = node.after.map((k) => byKey.get(k)).filter((x): x is GraphNode => Boolean(x));
  return (
    <>
      <p className="font-medium break-words">{node.title}</p>
      <p className="text-xs text-tooltip-muted">
        {stateWord(node)}
        {node.state === "working" && line ? ` · ${line}` : ""}
      </p>
      {(node.state === "needs_you" || node.state === "failed" || node.state === "review") && line && <p className="break-words whitespace-pre-line">{line}</p>}
      {node.waitsStart && <p className="text-xs break-words">{t("request-graph.waits_start")}</p>}
      {waits.length > 0 && (
        <div>
          <p className="text-xs text-tooltip-muted">{t("request-graph.tip_after")}</p>
          <ul className="space-y-0.5">
            {waits.map((w) => (
              <li key={w.key} className="flex items-center gap-1.5 text-xs">
                {w.state === "done" ? <Icon name="check" size={11} className="shrink-0" /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-current" />}
                <span className="min-w-0 break-words">{w.title}</span>
                <span className="shrink-0 text-tooltip-muted">· {stateWord(w)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="text-xs text-tooltip-muted">{t("request-graph.tip_agents")}</p>
        {node.agents.length ? (
          <ul className="space-y-1">
            {node.agents.map((a) => (
              <li key={a.key} className="flex items-start gap-1.5 text-xs">
                <span className="mt-px flex size-4 shrink-0 items-center justify-center">
                  {a.subagent ? <Icon name="cornerDownRight" size={11} /> : <AgentMark {...(a.session ? sessionAgent(a.session) : { agent: a.agent })} size={12} decorative className="text-tooltip-fg" />}
                </span>
                <span className="min-w-0">
                  <span className="block break-words">{(a.session && sessionTitle(a.session)) || a.title || t("request-graph.agent_untitled")}</span>
                  <span className="block break-words text-tooltip-muted">
                    {[ROLE_KEY[a.role] ? t(ROLE_KEY[a.role]) : "", agentLine(a, machines, true)].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs">{node.task ? taskLine(node, machines) || t("request-graph.no_agent") : t("request-graph.no_agent")}</p>
        )}
      </div>
      <p className="text-xs break-words text-tooltip-muted">{t("request-graph.tip_request", { title: req.words })}</p>
      <p className="border-t border-tooltip-border pt-1 text-xs text-tooltip-muted">{node.todo ? t("request-graph.tip_open_todo") : t("request-graph.waits_start")}</p>
    </>
  );
}

// ── finished requests ───────────────────────────────────────

/** How many finished requests show at a time once the fold is open. */
const DONE_PAGE = 30;

function DoneFold({ done, machines, now, selectedId, tips, hot, onHot, onOpenTodo }: {
  done: GraphRequest[]; machines: Machine[]; now: number; selectedId?: string; tips: TipApi; hot: Hot; onHot: (h: Hot) => void; onOpenTodo: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(DONE_PAGE);
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <div className="px-3 py-2" data-graph-done="">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className="flex h-7 items-center gap-1.5 rounded-control px-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-hover">
        <Icon name="chevronRight" size={12} className={cx("text-ink-3 transition-transform", open && "rotate-90")} />
        {t("request-graph.done_fold", { count: done.length })}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5">
          {done.slice(0, shown).map((req) => (
            <li key={req.key} data-done-request={req.key}>
              <button type="button" aria-expanded={opened === req.key} onClick={() => setOpened((v) => (v === req.key ? null : req.key))}
                className="flex h-7 w-full min-w-0 items-center gap-2 rounded-control px-1.5 text-left text-xs transition-colors hover:bg-hover">
                <Icon name="check" size={12} className="shrink-0 text-green" />
                <span className="min-w-0 flex-1 truncate text-ink-2">{req.words}</span>
                <span className="shrink-0 text-ink-3 tabular-nums">{t("request-graph.pieces", { count: req.nodes.length })}</span>
                {req.finished > 0 && <span className="w-24 shrink-0 truncate text-right text-ink-3 tabular-nums">{clock(new Date(req.finished).toISOString())}</span>}
              </button>
              {opened === req.key && (
                <RequestBlock req={req} machines={machines} now={now} selectedId={selectedId} hot={hot?.req === req.key ? hot.key : null} tips={tips} flat
                  onHot={(key) => onHot(key ? { req: req.key, key } : null)} onOpenTodo={onOpenTodo} />
              )}
            </li>
          ))}
          {done.length > shown && (
            <li>
              <Button tone="quiet" size="sm" className="whitespace-nowrap" onClick={() => setShown((n) => n + DONE_PAGE)}>
                {t("request-graph.show_more", { count: Math.min(DONE_PAGE, done.length - shown) })}
              </Button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// ── still queued ────────────────────────────────────────────

/** The pieces still queued under the graph: those nobody took yet and those waiting for others. A row lights its piece
 *  in the graph and opens its to-do. */
function QueuedStrip({ rows, selectedId, onHot, onOpenTodo }: { rows: QueueRow[]; selectedId?: string; onHot: (h: Hot) => void; onOpenTodo: (id: string) => void }) {
  if (!rows.length) return null;
  return (
    <aside aria-label={t("request-graph.queued")} className="max-h-40 shrink-0 overflow-y-auto overscroll-contain border-t border-line bg-canvas px-2 pb-2" data-queued="">
      <h3 className="flex h-7 items-center gap-1.5 px-1.5 text-xs font-medium">
        <Dot color="" />
        <span className="text-ink-2">{t("request-graph.queued")}</span>
        <span className="text-ink-3 tabular-nums" data-queued-count="">{rows.length}</span>
      </h3>
      <ol className="grid grid-cols-1 gap-x-2 gap-y-0.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
        {rows.map((row) => {
          const light = () => onHot({ req: row.request.key, key: row.node.key });
          const id = row.node.todo?.id;
          return (
            <li key={row.key} data-queued-row={row.key} data-queued-kind={row.kind}>
              <button type="button" aria-current={id !== undefined && id === selectedId ? true : undefined} disabled={!id}
                className="flex w-full min-w-0 items-start gap-2 rounded-control px-1.5 py-1.5 text-left transition-colors enabled:hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                onPointerEnter={light} onPointerLeave={() => onHot(null)} onFocus={light} onBlur={() => onHot(null)} onClick={() => id && onOpenTodo(id)}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs leading-4 font-medium text-ink">{row.title}</span>
                  <span className="block truncate text-xs leading-4 text-ink-3" data-queued-why="">
                    {row.kind === "ready" ? t("request-graph.why_ready") : t("request-graph.waits_for", { names: names(row.waits) })}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
