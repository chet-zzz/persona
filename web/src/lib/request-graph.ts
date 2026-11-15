// The requests graph of the To-dos page's "By request" grouping (views/TodoRequestGraph.tsx), pure parts: every request
// the owner made as a small DAG (the owner's words → the pieces of work, left to right by what each piece waits for),
// who is on each piece, and the pieces still queued. Nothing here reads the hub or the clock.
//
// A request in pieces is two fields of a to-do, the hub's (docs/assistant/todos.md "Requests in pieces"): `part_of`, the
// to-do whose request this one is a piece of (the request's root), and `after`, the pieces it waits for. The hub checks
// them when they are written (the to-dos exist, one level, no cycle); this file still leaves out what a deleted or
// unlisted to-do left behind. A queued piece is started on its own to-do (task_plan's todo_id), so its id never changes.
//
// Requests come from (1) a to-do others name as their parent; (2) the to-dos of one task plan (plan_id), the root being
// the plan's words; an open plan not started yet shows its tasks as pieces waiting for Start; (3) a to-do with neither,
// a request of one piece. A to-do belongs to exactly one request: `part_of` wins over its plan. A worker a
// leader's Agent handed out is drawn on the leader's piece, among its Agents, not as a request of its own.
import { foldedState } from "./child-sessions";
import type { DirectionAgent, DirectionTask, DirectionTree } from "./direction-tree";
import type { PlanTask, TaskPlan } from "./feed";
import { reviewState } from "./supervision";
import { acceptedAtRest, interruption, isAutoDone, openAsk, todoStatus, type SessionLookup, type Todo, type TodoStatus } from "./todos";
import type { AgentState, Session, Subagent } from "./types";

// ── what a piece is and where it stands ─────────────────────

/**
 *   queued    it waits for pieces that are not done yet (`waitsFor`), or, in an open plan, for Start (`waitsStart`);
 *   ready     nothing it waits for is pending and nobody took it yet;
 *   working   an Agent on it works or waits to be brought back;
 *   needs_you it waits on the owner: a decision, an Agent that asks, a supervisor that passed it up, an interrupted one;
 *   review    it says it is done and waits to be accepted;
 *   stopped   its Agents ended their turn and nothing brings them back;
 *   done      closed;
 *   failed    its Agent did not start (start_error).
 */
export type NodeState = "queued" | "ready" | "working" | "needs_you" | "review" | "stopped" | "done" | "failed";

/** Where a state sorts: what waits on the owner first, then the work going on, then what waits, the closed last. */
const STATE_RANK: Record<NodeState, number> = { needs_you: 0, failed: 1, review: 2, working: 3, ready: 4, queued: 5, stopped: 6, done: 7 };

export type AgentRole = "lead" | "worker" | "spawned" | "subagent" | "before";

/** One Agent on a piece: the one it was given to, the workers a leader handed out, what they spawned, the earlier ones. */
export interface NodeAgent {
  key: string;
  mid: string;
  agent?: string;
  session?: Session;
  subagent?: Subagent;
  title: string;
  state: AgentState | "";
  role: AgentRole;
}

export interface GraphNode {
  key: string;
  title: string;
  todo?: Todo;
  /** A task of an open plan, not started yet. */
  task?: PlanTask;
  /** 1 + the deepest layer among what it waits for; 1 for a piece that waits for nothing. */
  layer: number;
  /** Its place in its layer, from the top. */
  row: number;
  /** The pieces it waits for (node keys), after the edges that would close a cycle were dropped. */
  after: string[];
  /** Those of them not done yet. */
  waitsFor: string[];
  /** An open plan's task: it waits for the owner's Start. */
  waitsStart: boolean;
  state: NodeState;
  status?: TodoStatus;
  agents: NodeAgent[];
  /** What it asks the owner (needs_you), or why it did not start (failed). */
  ask: string;
  /** Since when it is in its state (ms), when known. */
  since?: number;
}

export type RequestKind = "parent" | "plan" | "single";

export interface GraphEdge {
  /** "root" or a node key. */
  from: string;
  to: string;
  /** Into a piece that is still queued. */
  dashed: boolean;
}

export interface GraphRequest {
  key: string;
  kind: RequestKind;
  /** The owner's words, else the title they were filed under (`own` false). */
  words: string;
  own: boolean;
  /** When it was said (ISO), when known. */
  at?: string;
  /** The parent to-do (kind parent), the plan (kind plan). */
  root?: Todo;
  plan?: TaskPlan;
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: number;
  rows: number;
  done: boolean;
  /** The latest change on it (ms): the most active request first. */
  touched: number;
  /** When its last piece closed (ms), for a done request. */
  finished: number;
  /** One piece whose title is the request's words: drawn as that piece's card alone (with when it was said). */
  merged: boolean;
}

export interface Graph {
  /** Not done, the most active first. */
  active: GraphRequest[];
  /** Done, the latest finished first. */
  done: GraphRequest[];
}

export interface GraphInput {
  todos: readonly Todo[];
  /** The task plans the feed has (lib/feed.ts), by id. */
  plans: Record<string, TaskPlan>;
  data: GraphData;
}

/** What the pieces' Agents are read from: the direction tree, every to-do (a leader's workers are among them) and the rows. */
export interface GraphData {
  tree: DirectionTree | null | undefined;
  todos: readonly Todo[];
  lookup: SessionLookup;
}

const ms = (iso: string | null | undefined) => {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : undefined;
};
const ref = (mid: string, sid: string) => `${mid}/${sid}`;

/** Closed by the hub as done: a piece waiting for it may go on. A piece that did not start is not done. */
export const isDoneTodo = (t: Pick<Todo, "done_at" | "start_error">) => Boolean(t.done_at) && !t.start_error;

/** How deep workers of workers go at most (a leader's workers are plain workers: one level is what the hub allows). */
const MAX_DEPTH = 4;

/** The direction tree's task for a to-do, wherever it is filed. */
function directionTask(tree: DirectionTree | null | undefined, todoId: string): DirectionTask | undefined {
  for (const d of tree?.directions ?? []) {
    const hit = d.tasks?.find((td) => td.id === todoId);
    if (hit) return hit;
  }
  return undefined;
}

/** The open to-dos a leader's Agent handed out (its workers): their ledger names it as supervisor, or their origin is it. */
function workersOf(todos: readonly Todo[], mid: string, sid: string): Todo[] {
  const r = ref(mid, sid);
  return todos.filter((td) => !td.done_at && (td.supervision?.supervisor === r || td.origin === r));
}

type AgentLink = { machine_id: string; session_id: string; title?: string; agent?: string; state?: string; children?: DirectionAgent[] };

/** Every Agent on a to-do: its own (the direction tree's, with what each spawned, else the to-do's own links), the
 *  workers a leader handed out and their Agents, running subagents, then the ones it had before. */
export function nodeAgents(todo: Todo, data: GraphData): NodeAgent[] {
  const out: NodeAgent[] = [];
  const seen = new Set<string>();
  const visit = (a: AgentLink, role: AgentRole, depth: number) => {
    const s = data.lookup(a.machine_id, a.session_id);
    const key = ref(a.machine_id, a.session_id);
    seen.add(key);
    out.push({ key, mid: a.machine_id, agent: s?.agent || a.agent, session: s, title: s?.title || a.title || "", state: (s ? foldedState(s) : (a.state as AgentState | undefined)) || "", role });
    for (const c of a.children ?? []) if (!seen.has(ref(c.machine_id, c.session_id))) visit(c, "spawned", depth + 1);
    if (depth < MAX_DEPTH) for (const w of workersOf(data.todos, a.machine_id, a.session_id)) on(w, "worker", depth + 1);
    for (const sub of s?.subagents ?? []) {
      if (!sub.running) continue;
      const k = `sub:${a.machine_id}/${s!.session_id}/${sub.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ key: k, mid: a.machine_id, subagent: sub, title: sub.description?.trim() || sub.type || "", state: "working", role: "subagent" });
    }
  };
  const on = (td: Todo, role: AgentRole, depth: number) => {
    const tree = directionTask(data.tree, td.id)?.agents;
    const list: AgentLink[] = tree?.length ? tree : (td.agents ?? []).filter((a) => !a.released_at);
    for (const a of list) if (!seen.has(ref(a.machine_id, a.session_id))) visit(a, role, depth);
  };
  on(todo, "lead", 0);
  for (const a of todo.agents ?? []) {
    if (!a.released_at || seen.has(ref(a.machine_id, a.session_id))) continue;
    const s = data.lookup(a.machine_id, a.session_id);
    seen.add(ref(a.machine_id, a.session_id));
    out.push({ key: ref(a.machine_id, a.session_id), mid: a.machine_id, agent: s?.agent || a.agent, session: s, title: s?.title || a.title || "", state: s ? foldedState(s) : "", role: "before" });
  }
  return out;
}

// ── where a to-do stands ────────────────────────────────────

/** The four steps of the user's view of a to-do, from the states lib/todos.ts already works out (todoStatus, reviewState,
 *  openAsk); no state of its own is made up here:
 *    needs_me   something on it waits on the user: a decision it asks (openAsk with outcome decide / cannot), an Agent
 *               that needs them, a supervisor that passed it up (needs_user), an Agent cut off by a model error, an
 *               Agent that did not start;
 *    review     it says the work is done and waits to be accepted: its supervisor's review is pending, its Agent
 *               reported done (report_to_supervisor), its ask is "please verify" / a conclusion, or the hub closed it
 *               as done (done_by auto) and the user has not looked at it yet;
 *    working    everything else still open: working, waiting, stopped, not started;
 *    accepted   closed: accepted by its supervisor, marked done by the user, closed after the user saw it. */
export type PieceStep = "needs_me" | "review" | "working" | "accepted";

/** Where a to-do stands; `status` is its todoStatus. */
export function pieceStep(todo: Todo, status: TodoStatus): PieceStep {
  if (status === "failed") return "needs_me";
  if (todo.done_at) return isAutoDone(todo) && !todo.seen_at ? "review" : "accepted";
  const ask = openAsk(todo);
  if (ask && (ask.outcome === "decide" || ask.outcome === "cannot")) return "needs_me";
  const review = reviewState(todo);
  if (status === "needs_you" || status === "interrupted" || review === "needs_user") return "needs_me";
  if (status === "working" || status === "waiting") return "working";
  if (acceptedAtRest(todo, status)) return "accepted";
  if (ask || review === "pending_review" || reportedDone(todo)) return "review";
  return "working";
}

/** Its Agent's latest report says done and no review has answered it yet. */
function reportedDone(todo: Todo): boolean {
  const sup = todo.supervision;
  if (sup?.progress?.kind !== "done") return false;
  const last = sup.reviews?.[sup.reviews.length - 1];
  return !last || !sup.progress.at || Date.parse(last.at) < Date.parse(sup.progress.at);
}

/** The user's own words for a to-do, as its brief keeps them; else its title. */
export function requestWords(todo: Pick<Todo, "title" | "brief">): { text: string; own: boolean } {
  const words = todo.brief?.request?.text?.trim();
  return words ? { text: words, own: true } : { text: todo.title, own: false };
}

/** When it was asked: the owner's message when the brief has it, else when the to-do was made. */
export function requestedAt(todo: Pick<Todo, "created_at" | "brief">): string {
  return todo.brief?.request?.at || todo.created_at;
}

/** A to-do's piece: its state, what it asks, since when (prerequisites are filled in later). */
function todoNode(todo: Todo, data: GraphData, title?: string): GraphNode {
  const lookup = data.lookup;
  const status = todoStatus(todo, lookup);
  const step = pieceStep(todo, status);
  const active = (todo.agents ?? []).filter((a) => !a.released_at);
  const sessions = active.map((a) => lookup(a.machine_id, a.session_id)).filter((s): s is Session => Boolean(s));
  let state: NodeState;
  if (todo.start_error) state = "failed";
  else if (step === "accepted") state = "done";
  else if (step === "review") state = "review";
  else if (step === "needs_me") state = "needs_you";
  else if (!active.length) state = "ready";
  else if (status === "working" || status === "waiting") state = "working";
  else if (status === "unread") state = "review";
  else state = "stopped";
  const ask = openAsk(todo);
  const asking = sessions.find((s) => foldedState(s) === "needs_you");
  const cut = sessions.map((s) => interruption(s)).find(Boolean);
  const text = state === "failed" ? todo.start_error ?? ""
    : state === "needs_you" ? ask?.question?.trim() || ask?.verdict?.trim() || asking?.asks?.trim() || cut?.reason || ""
    : state === "review" ? ask?.verdict?.trim() || todo.supervision?.progress?.line || "" : "";
  const working = sessions.filter((s) => foldedState(s) === "working").map((s) => ms(s.state_since)).filter((v): v is number => v !== undefined);
  const since = state === "working" ? (working.length ? Math.min(...working) : undefined)
    : state === "needs_you" ? ms(ask?.asked_at) ?? ms(asking?.state_since)
    : state === "done" ? ms(todo.done_at)
    : ms(todo.created_at);
  return {
    key: `todo:${todo.id}`, title: title || todo.title, todo, layer: 1, row: 0, after: [], waitsFor: [], waitsStart: false,
    state, status, agents: nodeAgents(todo, data), ask: text, since,
  };
}

function planTaskNode(plan: TaskPlan, task: PlanTask, i: number): GraphNode {
  return { key: `plan:${plan.id}/${i}`, title: task.title, task, layer: 1, row: 0, after: [], waitsFor: [], waitsStart: true, state: "queued", agents: [], ask: "", since: ms(plan.created_at) };
}

// ── layers ──────────────────────────────────────────────────

/**
 * Fills in each node's prerequisites (`wants`: node key → the keys it names), drops an edge that would close a cycle
 * (walking the nodes in their order, an edge back into the walk in progress), then lays the nodes out: layer = 1 + the
 * deepest layer among its prerequisites, rows in a layer by the average row of their prerequisites (fewer crossings),
 * ties in the given order. Returns the edges: root → every layer-1 node, prerequisite → dependent.
 */
export function layOut(nodes: GraphNode[], wants: Map<string, string[]>): { edges: GraphEdge[]; layers: number; rows: number } {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const kept = new Map<string, string[]>();
  const mark = new Map<string, 1 | 2>(); // 1: on the walk, 2: finished
  const walk = (key: string) => {
    mark.set(key, 1);
    const keep: string[] = [];
    for (const w of wants.get(key) ?? []) {
      if (w === key || !byKey.has(w) || keep.includes(w)) continue;
      if (mark.get(w) === 1) continue; // closes a cycle: dropped
      if (!mark.has(w)) walk(w);
      keep.push(w);
    }
    kept.set(key, keep);
    mark.set(key, 2);
  };
  for (const n of nodes) if (!mark.has(n.key)) walk(n.key);
  const layerOf = new Map<string, number>();
  const layer = (key: string): number => {
    const have = layerOf.get(key);
    if (have) return have;
    const v = 1 + Math.max(0, ...(kept.get(key) ?? []).map(layer));
    layerOf.set(key, v);
    return v;
  };
  for (const n of nodes) {
    n.after = kept.get(n.key) ?? [];
    n.layer = layer(n.key);
  }
  const layers = Math.max(0, ...nodes.map((n) => n.layer));
  let rows = 0;
  for (let l = 1; l <= layers; l++) {
    const here = nodes.map((n, i) => ({ n, i })).filter((x) => x.n.layer === l);
    const center = (n: GraphNode) => (n.after.length ? n.after.reduce((s, k) => s + byKey.get(k)!.row, 0) / n.after.length : Infinity);
    if (l > 1) here.sort((a, b) => center(a.n) - center(b.n) || a.i - b.i);
    here.forEach((x, r) => (x.n.row = r));
    rows = Math.max(rows, here.length);
  }
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    const dashed = n.state === "queued";
    if (n.layer === 1) edges.push({ from: "root", to: n.key, dashed });
    for (const a of n.after) edges.push({ from: a, to: n.key, dashed });
  }
  return { edges, layers, rows };
}

/** A node and everything above and below it (its ancestors, its descendants), with "root" for the request's words. */
export function lineage(req: Pick<GraphRequest, "nodes">, key: string): Set<string> {
  const byKey = new Map(req.nodes.map((n) => [n.key, n]));
  if (!byKey.has(key)) return new Set(key === "root" ? ["root", ...byKey.keys()] : []);
  const out = new Set<string>(["root", key]);
  const up = (k: string) => byKey.get(k)?.after.forEach((a) => !out.has(a) && (out.add(a), up(a)));
  const down = (k: string) => req.nodes.forEach((n) => n.after.includes(k) && !out.has(n.key) && (out.add(n.key), down(n.key)));
  up(key);
  down(key);
  return out;
}

// ── requests ────────────────────────────────────────────────

/** The refs ("machine/session") of every Agent a to-do had, so its workers can be told from requests of their own. */
function agentRefs(todos: readonly Todo[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const t of todos) for (const a of t.agents ?? []) if (!owner.has(ref(a.machine_id, a.session_id))) owner.set(ref(a.machine_id, a.session_id), t.id);
  return owner;
}

/** The same words, spaces aside (trimmed, runs of white space as one). */
export const sameWords = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

function finish(req: Omit<GraphRequest, "edges" | "layers" | "rows" | "done" | "touched" | "finished" | "merged">, wants: Map<string, string[]>): GraphRequest {
  const byKey = new Map(req.nodes.map((n) => [n.key, n]));
  // a piece is queued while something it waits for is not done, and nobody took it yet
  const { edges, layers, rows } = layOut(req.nodes, wants);
  for (const n of req.nodes) {
    n.waitsFor = n.after.filter((k) => { const t = byKey.get(k)?.todo; return !t || !isDoneTodo(t); });
    if (n.todo && n.waitsFor.length && n.state === "ready") n.state = "queued";
  }
  // edges again: a piece that just became queued is drawn dashed
  for (const e of edges) e.dashed = byKey.get(e.to)?.state === "queued";
  const todos = [...(req.root ? [req.root] : []), ...req.nodes.flatMap((n) => (n.todo ? [n.todo] : []))];
  const done = req.nodes.length > 0 && req.nodes.every((n) => n.state === "done") && (!req.root || isDoneTodo(req.root));
  const touched = Math.max(0, ms(req.plan?.created_at) ?? 0, ...todos.map((t) => ms(t.updated_at) ?? ms(t.created_at) ?? 0));
  const finished = Math.max(0, ...todos.map((t) => ms(t.done_at) ?? 0));
  const merged = req.nodes.length === 1 && sameWords(req.words, req.nodes[0].title);
  return { ...req, edges: merged ? [] : edges, layers, rows, done, touched, finished, merged };
}

const rank = (r: GraphRequest) => Math.min(STATE_RANK.done + 1, ...r.nodes.map((n) => STATE_RANK[n.state]));

/** Every request, from the to-dos and the plans (see the head of this file). */
export function buildGraph({ todos: all, plans, data }: GraphInput): Graph {
  const todos = all;
  const byId = new Map(todos.map((t) => [t.id, t]));
  // the request a to-do is a piece of: a listed to-do other than itself that is no piece itself (the hub keeps one level)
  const parentOf = (t: Todo) => {
    const p = t.part_of;
    return p && p !== t.id && byId.has(p) && !byId.get(p)!.part_of ? p : undefined;
  };
  const rootOf = (t: Todo) => parentOf(t) ?? t.id;
  const owners = agentRefs(todos);
  // a worker a leader's Agent handed out: drawn on the leader's piece (unless it is a piece of a request)
  const isWorker = (t: Todo) => {
    if (parentOf(t)) return false;
    const by = t.supervision?.supervisor || t.origin || "";
    const owner = owners.get(by);
    return Boolean(owner && owner !== t.id);
  };

  const groups = new Map<string, { kind: RequestKind; root?: Todo; plan?: TaskPlan; members: Todo[] }>();
  const group = (key: string, make: () => { kind: RequestKind; root?: Todo; plan?: TaskPlan }) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ...make(), members: [] }));
    return g;
  };
  const roots = new Set<string>();
  for (const t of todos) {
    if (isWorker(t)) continue;
    const r = rootOf(t);
    if (r !== t.id) roots.add(r);
  }
  for (const t of todos) {
    if (isWorker(t) && !roots.has(t.id)) continue;
    if (roots.has(t.id)) {
      group(`todo:${t.id}`, () => ({ kind: "parent", root: t }));
      continue;
    }
    const r = rootOf(t);
    if (r !== t.id) group(`todo:${r}`, () => ({ kind: "parent", root: byId.get(r) })).members.push(t);
    else if (t.plan_id) group(`plan:${t.plan_id}`, () => ({ kind: "plan", plan: plans[t.plan_id!] })).members.push(t);
    else group(`todo:${t.id}`, () => ({ kind: "single" })).members.push(t);
  }
  // an open plan nobody started: its tasks wait for Start
  for (const p of Object.values(plans)) if (p.state === "open" && p.tasks.length) group(`plan:${p.id}`, () => ({ kind: "plan", plan: p }));

  const out: GraphRequest[] = [];
  for (const [key, g] of groups) {
    const wants = new Map<string, string[]>();
    let nodes: GraphNode[];
    if (g.plan && g.plan.state === "open") nodes = g.plan.tasks.map((task, i) => planTaskNode(g.plan!, task, i));
    else {
      // a plan's to-dos in its tasks' order, any others after them
      const order = (t: Todo) => {
        const i = g.plan?.tasks.findIndex((task) => task.todo_id === t.id) ?? -1;
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      const members = [...g.members].sort((a, b) => order(a) - order(b) || (ms(a.created_at) ?? 0) - (ms(b.created_at) ?? 0) || a.id.localeCompare(b.id));
      nodes = members.map((t) => todoNode(t, data, g.plan?.tasks.find((task) => task.todo_id === t.id)?.title));
      for (const t of members) wants.set(`todo:${t.id}`, (t.after ?? []).map((id) => `todo:${id}`));
    }
    if (!nodes.length) continue;
    let words: { text: string; own: boolean };
    let at: string | undefined;
    if (g.kind === "parent" && g.root) {
      words = requestWords(g.root);
      at = requestedAt(g.root);
    } else if (g.kind === "plan") {
      // the owner's words a plan's first task kept
      const said = g.plan?.tasks.find((task) => task.brief?.request?.text?.trim())?.brief?.request?.text?.trim() ?? "";
      const first = g.members[0];
      words = said ? { text: said, own: true } : first ? requestWords(first) : { text: g.plan?.tasks[0]?.title ?? "", own: false };
      at = g.plan?.created_at || (first && requestedAt(first));
    } else {
      words = requestWords(g.members[0]);
      at = requestedAt(g.members[0]);
    }
    out.push(finish({ key, kind: g.kind, words: words.text, own: words.own, at, root: g.root, plan: g.plan, nodes }, wants));
  }
  const active = out.filter((r) => !r.done).sort((a, b) => rank(a) - rank(b) || b.touched - a.touched || a.key.localeCompare(b.key));
  const done = out.filter((r) => r.done).sort((a, b) => b.finished - a.finished || a.key.localeCompare(b.key));
  return { active, done };
}

// ── what is still queued ────────────────────────────────────

/** `ready`: nobody took it yet and nothing it waits for is pending; `after`: it waits for other pieces. */
export type QueueKind = "ready" | "after";

export interface QueueRow {
  key: string;
  kind: QueueKind;
  title: string;
  request: GraphRequest;
  node: GraphNode;
  /** The pieces it waits for (after), by node. */
  waits: GraphNode[];
  since?: number;
}

/**
 * The pieces still queued, in order: first those nobody took yet with nothing pending before them (the longest waiting
 * first), then those that wait for others, in the graph's order (request, layer, row) so the list reads like the picture.
 * An open plan's tasks wait for Start and are not listed.
 */
export function queuedRows(graph: Graph): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const request of graph.active) {
    if (request.plan?.state === "open") continue;
    const byKey = new Map(request.nodes.map((n) => [n.key, n]));
    for (const node of request.nodes) {
      const base = { key: node.key, title: node.title, request, node, since: node.since };
      if (node.state === "ready") rows.push({ ...base, kind: "ready", waits: [] });
      else if (node.state === "queued") rows.push({ ...base, kind: "after", waits: node.waitsFor.map((k) => byKey.get(k)!).filter(Boolean) });
    }
  }
  const active = new Map(graph.active.map((r, i) => [r.key, i]));
  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "ready" ? -1 : 1;
    if (a.kind === "after") return (active.get(a.request.key)! - active.get(b.request.key)!) || a.node.layer - b.node.layer || a.node.row - b.node.row;
    return (a.since ?? Infinity) - (b.since ?? Infinity) || a.key.localeCompare(b.key);
  });
}

// ── geometry ────────────────────────────────────────────────

/** The card and the gaps, in px (the view draws its cards at these sizes). */
export const CARD_W = 200;
export const CARD_H = 92;
export const GAP_X = 44;
export const GAP_Y = 14;
export const PAD = 10;
/** A merged request's card: a piece's card with one more line on top, the request's label and time. */
export const MERGED_H = CARD_H + 20;
const R = 8;

export interface Placed {
  key: string;
  x: number;
  y: number;
}

export interface DrawnEdge extends GraphEdge {
  d: string;
  /** Where it leaves its source (the hollow dot). */
  dot: [number, number];
}

export interface RequestLayout {
  root: Placed;
  nodes: Map<string, Placed>;
  edges: DrawnEdge[];
  width: number;
  height: number;
}

const colX = (c: number) => PAD + c * (CARD_W + GAP_X);
const rowY = (r: number) => PAD + r * (CARD_H + GAP_Y);

/** A polyline through `pts`, its corners rounded (never by more than half of either leg). */
export function roundedPath(pts: [number, number][]): string {
  const p = pts.filter((q, i) => i === 0 || q[0] !== pts[i - 1][0] || q[1] !== pts[i - 1][1]);
  if (p.length < 2) return "";
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], [cx, cy] = p[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
    const r = Math.min(R, l1 / 2, l2 / 2);
    const sx = bx - ((bx - ax) / l1) * r, sy = by - ((by - ay) / l1) * r;
    const ex = bx + ((cx - bx) / l2) * r, ey = by + ((cy - by) / l2) * r;
    d += ` L${sx} ${sy} Q${bx} ${by} ${ex} ${ey}`;
  }
  const last = p[p.length - 1];
  return `${d} L${last[0]} ${last[1]}`;
}

/**
 * Where everything of a request goes: the words in column 0, row 0; a node of layer L in column L at its row. An edge
 * leaves its source's right edge at mid height, turns in the gap right of it, and enters its target's left edge; one
 * that skips columns runs along the gutter between two rows (above its source when its target is higher, else
 * below), so it never crosses a card.
 */
export function layoutRequest(req: Pick<GraphRequest, "nodes" | "edges" | "layers" | "rows"> & { merged?: boolean }): RequestLayout {
  if (req.merged) {
    // one card, in the words' place: no root, no connector
    const only = req.nodes[0];
    return { root: { key: "root", x: PAD, y: PAD }, nodes: new Map([[only.key, { key: only.key, x: PAD, y: PAD }]]), edges: [], width: PAD * 2 + CARD_W, height: PAD * 2 + MERGED_H };
  }
  const nodes = new Map<string, Placed>(req.nodes.map((n) => [n.key, { key: n.key, x: colX(n.layer), y: rowY(n.row) }]));
  const root: Placed = { key: "root", x: colX(0), y: rowY(0) };
  const rowOf = new Map(req.nodes.map((n) => [n.key, n.row]));
  const colOf = new Map(req.nodes.map((n) => [n.key, n.layer]));
  const edges: DrawnEdge[] = req.edges.map((e) => {
    const s = e.from === "root" ? root : nodes.get(e.from)!;
    const t = nodes.get(e.to)!;
    const sc = e.from === "root" ? 0 : colOf.get(e.from)!, tc = colOf.get(e.to)!;
    const sr = e.from === "root" ? 0 : rowOf.get(e.from)!, tr = rowOf.get(e.to)!;
    const x1 = s.x + CARD_W, y1 = s.y + CARD_H / 2;
    const x2 = t.x, y2 = t.y + CARD_H / 2;
    const gapOut = x1 + GAP_X / 2, gapIn = x2 - GAP_X / 2;
    let pts: [number, number][];
    if (tc === sc + 1) pts = [[x1, y1], [gapOut, y1], [gapOut, y2], [x2, y2]];
    else {
      const gutter = tr < sr ? rowY(sr) - GAP_Y / 2 : rowY(sr) + CARD_H + GAP_Y / 2;
      pts = [[x1, y1], [gapOut, y1], [gapOut, gutter], [gapIn, gutter], [gapIn, y2], [x2, y2]];
    }
    return { ...e, d: roundedPath(pts), dot: [x1, y1] };
  });
  const cols = Math.max(1, req.layers + 1);
  const rows = Math.max(1, req.rows);
  return { root, nodes, edges, width: colX(cols - 1) + CARD_W + PAD, height: rowY(rows - 1) + CARD_H + PAD };
}
