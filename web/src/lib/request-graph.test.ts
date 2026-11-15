// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildGraph, CARD_H, CARD_W, layoutRequest, lineage, mergesWithRoot, pieceStep, queuedRows, requestWords, roundedPath, type GraphData, type GraphNode, type GraphRequest,
} from "./request-graph";
import { caseKey, caseName, caseTodos, MERGE_CASES, PIECES, ROOTS, type PieceKind, type RootKind } from "./request-graph-merge-cases";
import type { PlanTask, TaskPlan } from "./feed";
import { makeSessionLookup, todoStatus, type Todo } from "./todos";
import type { Session } from "./types";

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 10, 0) + minutes * 60_000).toISOString();
const todo = (id: string, patch: Partial<Todo> = {}): Todo => ({ id, title: id, created_at: at(0), updated_at: at(0), agents: [], ...patch });
const session = (sid: string, patch: Partial<Session> = {}): Session => ({ machine_id: "mac", session_id: sid, title: `agent ${sid}`, cwd: "/code/app", status: "working", state: "working", ...patch }) as Session;
const link = (sid: string, patch: Partial<NonNullable<Todo["agents"]>[number]> = {}) => ({ machine_id: "mac", session_id: sid, linked_at: at(1), ...patch });
const data = (todos: Todo[], sessions: Session[] = []): GraphData => ({ todos, tree: null, lookup: makeSessionLookup(sessions) });
const task = (title: string, patch: Partial<PlanTask> = {}): PlanTask => ({ title, prompt: title, machine: "mac", cwd: "/code/app", ...patch });
const plan = (id: string, state: TaskPlan["state"], tasks: PlanTask[], minutes = 0): TaskPlan => ({ id, conversation: "main", state, tasks, created_at: at(minutes) });
const graph = (todos: Todo[], sessions: Session[] = [], plans: Record<string, TaskPlan> = {}) => buildGraph({ todos, plans, data: data(todos, sessions) });
const node = (r: GraphRequest, id: string) => r.nodes.find((n) => n.key === `todo:${id}`)!;

describe("requests", () => {
  it("groups the pieces a to-do is named parent of under it, in layers by what each waits for (a diamond)", () => {
    const todos = [
      todo("req", { title: "Ship the search page", brief: { request: { text: "please ship search", at: at(-5) } } as Todo["brief"] }),
      todo("a", { part_of: "req", done_at: at(5) }),
      todo("b", { part_of: "req", after: ["a"] }),
      todo("c", { part_of: "req", after: ["a"] }),
      todo("d", { part_of: "req", after: ["b", "c"] }),
    ];
    const { active, done } = graph(todos);
    expect(done).toEqual([]);
    expect(active).toHaveLength(1);
    const r = active[0];
    expect([r.kind, r.words, r.own, r.at]).toEqual(["parent", "please ship search", true, at(-5)]);
    expect(r.nodes.map((n) => [n.key, n.layer])).toEqual([["todo:a", 1], ["todo:b", 2], ["todo:c", 2], ["todo:d", 3]]);
    expect([r.layers, r.rows]).toEqual([3, 2]);
    expect(r.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["root>todo:a", "todo:a>todo:b", "todo:a>todo:c", "todo:b>todo:d", "todo:c>todo:d"]);
    // a is done: b and c are ready (nobody took them); d waits for both
    expect([node(r, "a").state, node(r, "b").state, node(r, "c").state, node(r, "d").state]).toEqual(["done", "ready", "ready", "queued"]);
    expect(node(r, "d").waitsFor).toEqual(["todo:b", "todo:c"]);
    expect(r.edges.filter((e) => e.dashed).map((e) => e.to)).toEqual(["todo:d", "todo:d"]);
  });

  it("takes a node's layer from its deepest prerequisite when it has several", () => {
    const todos = [todo("req"), todo("a", { part_of: "req" }), todo("b", { part_of: "req", after: ["a"] }), todo("c", { part_of: "req", after: ["a", "b"] })];
    const r = graph(todos).active[0];
    expect(r.nodes.map((n) => [n.key, n.layer, n.after])).toEqual([["todo:a", 1, []], ["todo:b", 2, ["todo:a"]], ["todo:c", 3, ["todo:a", "todo:b"]]]);
    // c skips a column: its edge from a runs along the gutter, never across b
    const lay = layoutRequest(r);
    const b = lay.nodes.get("todo:b")!;
    const skip = lay.edges.find((e) => e.from === "todo:a" && e.to === "todo:c")!;
    const pts = [...skip.d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const inside = ([x, y]: number[]) => x > b.x && x < b.x + CARD_W && y > b.y && y < b.y + CARD_H;
    // no point of the path, nor the middle of any of its legs, is inside b
    expect(pts.some(inside) || pts.slice(1).some((p, i) => inside([(p[0] + pts[i][0]) / 2, (p[1] + pts[i][1]) / 2]))).toBe(false);
  });

  it("ignores unknown ids and a to-do naming itself", () => {
    const todos = [todo("req"), todo("a", { part_of: "req", after: ["ghost", "a"] }), todo("lone", { part_of: "nobody" })];
    const { active } = graph(todos);
    const r = active.find((x) => x.key === "todo:req")!;
    expect(r.nodes.map((n) => [n.key, n.after, n.state])).toEqual([["todo:a", [], "ready"]]);
    expect(active.find((x) => x.key === "todo:lone")!.kind).toBe("single");
  });

  it("drops the edge that closes a cycle instead of looping", () => {
    const todos = [todo("req"), todo("a", { part_of: "req", after: ["c"] }), todo("b", { part_of: "req", after: ["a"] }), todo("c", { part_of: "req", after: ["b"] })];
    const r = graph(todos).active[0];
    // walking a → c → b → a: the edge back into a is dropped, the rest stays a DAG
    expect(r.nodes.map((n) => [n.key, n.layer, n.after])).toEqual([["todo:a", 3, ["todo:c"]], ["todo:b", 1, []], ["todo:c", 2, ["todo:b"]]]);
  });

  it("makes a plan's to-dos one request under the plan's words, edges from after, part_of winning", () => {
    const p = plan("p1", "started", [task("Fix", { todo_id: "f", brief: { request: { text: "fix it and test it", at: at(-3) } } as PlanTask["brief"] }), task("Test", { todo_id: "t" })], -2);
    const todos = [
      todo("t", { plan_id: "p1", after: ["f"], created_at: at(-1) }),
      todo("f", { plan_id: "p1", created_at: at(0), agents: [link("s1")] }),
      todo("own", { title: "Mine", plan_id: "p1", part_of: "other" }),
      todo("other"),
    ];
    const { active } = graph(todos, [session("s1", { state_since: at(1) })], { p1: p });
    const r = active.find((x) => x.kind === "plan")!;
    expect([r.key, r.words, r.own, r.at]).toEqual(["plan:p1", "fix it and test it", true, at(-2)]);
    // in the plan's order, whatever their creation
    expect(r.nodes.map((n) => [n.key, n.title, n.layer, n.state])).toEqual([["todo:f", "Fix", 1, "working"], ["todo:t", "Test", 2, "queued"]]);
    expect(node(r, "f").agents.map((a) => [a.key, a.role])).toEqual([["mac/s1", "lead"]]);
    expect(node(r, "f").since).toBe(Date.parse(at(1)));
    expect(active.find((x) => x.key === "todo:other")!.nodes.map((n) => n.key)).toEqual(["todo:own"]);
  });

  it("shows an open plan's tasks as pieces waiting for Start", () => {
    const p = plan("p2", "open", [task("One", { brief: { request: { text: "do one and two", at: at(0) } } as PlanTask["brief"] }), task("Two")]);
    const r = graph([], [], { p2: p, gone: plan("gone", "dismissed", [task("x")]) }).active;
    expect(r).toHaveLength(1);
    expect([r[0].words, r[0].nodes.map((n) => [n.title, n.state, n.waitsStart, n.layer])]).toEqual(["do one and two", [["One", "queued", true, 1], ["Two", "queued", true, 1]]]);
    expect(r[0].edges.every((e) => e.from === "root" && e.dashed)).toBe(true);
  });

  it("makes a lone to-do a request of one piece, under its own words", () => {
    const r = graph([todo("solo", { title: "Rename the repo", agents: [link("s1")] })], [session("s1", { state: "needs_you", status: "idle", asks: "Which name?" })]).active[0];
    expect([r.kind, r.words, r.own]).toEqual(["single", "Rename the repo", false]);
    expect([r.nodes[0].state, r.nodes[0].ask]).toEqual(["needs_you", "Which name?"]);
  });

  it("files finished requests under done, the latest first, and keeps a request with an open piece active", () => {
    const todos = [
      todo("old", { done_at: at(10) }),
      todo("new", { done_at: at(20) }),
      todo("req", { done_at: at(30) }),
      todo("piece", { part_of: "req" }),
      todo("broke", { done_at: at(40), start_error: "rpc: closed" }),
    ];
    const { active, done } = graph(todos);
    expect(done.map((r) => r.key)).toEqual(["todo:new", "todo:old"]);
    expect(active.map((r) => r.key).sort()).toEqual(["todo:broke", "todo:req"]);
    expect(active.find((r) => r.key === "todo:broke")!.nodes[0].state).toBe("failed");
  });

  it("draws a leader's workers among its Agents, not as requests of their own, and lists earlier Agents last", () => {
    const todos = [
      todo("lead", { agents: [link("L"), link("old", { released_at: at(2) })] }),
      todo("w1", { origin: "mac/L", supervision: { supervisor: "mac/L" } as Todo["supervision"], agents: [link("W1")] }),
      todo("w2", { origin: "mac/L", agents: [link("W2")], done_at: at(9) }),
    ];
    const { active, done } = graph(todos, [session("L"), session("W1"), session("old", { state: "idle", status: "idle" })]);
    expect(done).toEqual([]);
    expect(active.map((r) => r.key)).toEqual(["todo:lead"]);
    expect(active[0].nodes[0].agents.map((a) => [a.key, a.role])).toEqual([["mac/L", "lead"], ["mac/W1", "worker"], ["mac/old", "before"]]);
  });

  it("puts the most active request first: what needs the owner, then work going on, then what waits", () => {
    const todos = [
      todo("idle", { updated_at: at(50) }),
      todo("busy", { agents: [link("w")], updated_at: at(10) }),
      todo("asks", { agents: [link("n")], updated_at: at(1) }),
    ];
    const order = graph(todos, [session("w"), session("n", { state: "needs_you", status: "idle" })]).active.map((r) => r.key);
    expect(order).toEqual(["todo:asks", "todo:busy", "todo:idle"]);
  });
});

describe("a request of one piece that says the same", () => {
  it("is drawn as the piece's card alone when its words are the piece's title, spaces aside", () => {
    const g = graph([
      todo("same", { title: "Rename  the repo " , brief: { request: { text: " Rename the\nrepo", at: at(0) } } as Todo["brief"] }),
      todo("other", { title: "Rename the repo", brief: { request: { text: "please rename it", at: at(0) } } as Todo["brief"] }),
      todo("req", { title: "Search" }),
      todo("one", { title: "Search", part_of: "req" }),
    ]);
    const by = (k: string) => g.active.find((r) => r.key === k)!;
    expect([by("todo:same").merged, by("todo:same").edges]).toEqual([true, []]);
    expect(by("todo:other").merged).toBe(false);
    expect(by("todo:other").edges.map((e) => e.from)).toEqual(["root"]);
    // a parent with one piece of the same name merges too
    expect(by("todo:req").merged).toBe(true);
    const lay = layoutRequest(by("todo:same"));
    expect([lay.edges, lay.nodes.get("todo:same")!.x, lay.width]).toEqual([[], lay.root.x, lay.root.x * 2 + CARD_W]);
    expect(layoutRequest(by("todo:other")).nodes.get("todo:other")!.x).toBeGreaterThan(CARD_W);
  });

  it("keeps the root's card when the root and its piece disagree on done", () => {
    const g = graph([
      todo("open", { title: "Search" }),
      todo("finished", { title: "Search", part_of: "open", done_at: at(5) }),
      todo("closed", { title: "Export", done_at: at(5) }),
      todo("going", { title: "Export", part_of: "closed" }),
      todo("both", { title: "Import", done_at: at(6) }),
      todo("both-piece", { title: "Import", part_of: "both", done_at: at(5) }),
    ]);
    const find = (k: string) => [...g.active, ...g.done].find((r) => r.key === k)!;
    // the piece is done, the request's to-do still open: the request stays open, its root card drawn
    const open = find("todo:open");
    expect([g.active.includes(open), open.done, open.merged, node(open, "finished").state]).toEqual([true, false, false, "done"]);
    expect(open.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["root>todo:finished"]);
    const lay = layoutRequest(open);
    expect(lay.nodes.get("todo:finished")!.x).toBeGreaterThan(lay.root.x + CARD_W);
    // and the other way round: the root done, its piece not
    expect([find("todo:closed").done, find("todo:closed").merged]).toEqual([false, false]);
    // both done: one card again
    expect([find("todo:both").done, find("todo:both").merged]).toEqual([true, true]);
  });

  it("keeps the root's card for an open root whose same-name piece the hub closed and nobody looked at yet", () => {
    // stored closed (done_at, done_by auto) but drawn `review`: an open root and an unseen auto-done piece still split
    const g = graph([todo("req", { title: "Search" }), todo("piece", { title: "Search", part_of: "req", done_at: at(5), done_by: "auto", done_reason: "finished" })]);
    const req = g.active.find((r) => r.key === "todo:req")!;
    expect([Boolean(req), req.done, node(req, "piece").state, req.merged]).toEqual([true, false, "review", false]);
    expect(req.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["root>todo:piece"]);
  });
});

describe("root × piece: when one card stands for both", () => {
  const cases = MERGE_CASES.map((c) => ({ ...c, name: caseName(c) }));

  it("covers every root and every piece", () => {
    const seen = new Set(MERGE_CASES.map(caseKey));
    for (const r of Object.keys(ROOTS)) for (const p of Object.keys(PIECES)) expect(seen.has(caseKey({ root: r as RootKind, piece: p as PieceKind })), `${r} × ${p}`).toBe(true);
    expect(seen.size).toBe(MERGE_CASES.length);
  });

  it.each(cases)("$name", (c) => {
    const { todos, sessions } = caseTodos(c, at, todo);
    const g = graph(todos, sessions);
    const req = [...g.active, ...g.done].find((r) => r.key === `todo:r-${caseKey(c)}`)!;
    expect(req.kind).toBe("parent");
    expect({ state: node(req, `p-${caseKey(c)}`).state, merged: req.merged, done: req.done, filed: g.done.includes(req) ? "done" : "active" })
      .toEqual({ state: c.state, merged: c.merged, done: c.done, filed: c.done ? "done" : "active" });
    // a merged block has no connectors; a split one has the root's
    expect(req.edges.map((e) => e.from)).toEqual(c.merged ? [] : ["root"]);
    // never a done-looking card standing for an open request
    if (req.merged && !req.done) expect(req.nodes[0].state).not.toBe("done");
  });

  it("the same, all in one graph: each request's answer is its own", () => {
    const all = MERGE_CASES.map((c) => caseTodos(c, at, todo));
    const g = graph(all.flatMap((x) => x.todos), all.flatMap((x) => x.sessions));
    for (const c of MERGE_CASES) {
      const req = [...g.active, ...g.done].find((r) => r.key === `todo:r-${caseKey(c)}`)!;
      expect([req.merged, req.done], caseName(c)).toEqual([c.merged, c.done]);
    }
  });

  it("merges a request with no root to-do by its words alone: a lone to-do in any state, an open plan's one task", () => {
    for (const kind of Object.keys(PIECES) as PieceKind[]) {
      const lone = todo(`solo-${kind}`, { title: "Rename", ...PIECES[kind].patch(at) });
      const lg = graph([lone], (PIECES[kind] as { sessions?: (a: typeof at) => Session[] }).sessions?.(at) ?? []);
      const r = [...lg.active, ...lg.done][0];
      expect([r.kind, r.merged], kind).toEqual(["single", true]);
    }
    const r = graph([], [], { p: plan("p", "open", [task("Rename", { brief: { request: { text: "Rename", at: at(0) } } as PlanTask["brief"] })]) }).active[0];
    expect([r.kind, r.nodes[0].todo, r.nodes[0].state, r.merged]).toEqual(["plan", undefined, "queued", true]);
  });

  it("answers mergesWithRoot from the stored state, and the drawn one only for a plan's task with no to-do", () => {
    const n = (patch: Partial<GraphNode>): GraphNode => ({ key: "k", title: "t", layer: 1, row: 0, after: [], waitsFor: [], waitsStart: false, state: "ready", agents: [], ask: "", ...patch });
    // a task with no to-do: its drawn state is all there is
    expect([mergesWithRoot(todo("r"), n({ state: "queued" })), mergesWithRoot(todo("r", { done_at: at(1) }), n({ state: "done" }))]).toEqual([true, true]);
    expect(mergesWithRoot(todo("r"), n({ state: "done" }))).toBe(false);
    // a to-do's stored state wins over what it is drawn as
    expect(mergesWithRoot(todo("r"), n({ state: "review", todo: todo("p", { done_at: at(1), done_by: "auto" }) }))).toBe(false);
    expect(mergesWithRoot(todo("r", { done_at: at(1) }), n({ state: "review", todo: todo("p", { done_at: at(1), done_by: "auto" }) }))).toBe(true);
  });
});

describe("a piece of a piece", () => {
  it("keeps one level: a to-do whose part_of names another piece, or a loop, is a request of its own", () => {
    const g = graph([todo("req"), todo("a", { part_of: "req" }), todo("deep", { part_of: "a" }), todo("x", { part_of: "y" }), todo("y", { part_of: "x" })]);
    expect(g.active.map((q) => [q.key, q.kind, q.nodes.map((n) => n.key)]).sort()).toEqual([
      ["todo:deep", "single", ["todo:deep"]], ["todo:req", "parent", ["todo:a"]], ["todo:x", "single", ["todo:x"]], ["todo:y", "single", ["todo:y"]],
    ]);
  });
});

describe("lineage", () => {
  it("is a node, its ancestors and its descendants, with the words", () => {
    const todos = [todo("req"), todo("a", { part_of: "req" }), todo("b", { part_of: "req", after: ["a"] }), todo("c", { part_of: "req", after: ["a"] }), todo("d", { part_of: "req", after: ["b"] })];
    const r = graph(todos).active[0];
    expect([...lineage(r, "todo:b")].sort()).toEqual(["root", "todo:a", "todo:b", "todo:d"]);
    expect([...lineage(r, "todo:c")].sort()).toEqual(["root", "todo:a", "todo:c"]);
    expect(lineage(r, "nope").size).toBe(0);
  });
});

describe("the queue", () => {
  it("lists the pieces nobody took first, the longest waiting first, then the pieces that wait for others in the graph's order", () => {
    const todos = [
      todo("req"),
      todo("a", { part_of: "req", agents: [link("asker")] }),
      todo("b", { part_of: "req", after: ["a"] }),
      todo("c", { part_of: "req", created_at: at(3) }),
      todo("d", { part_of: "req", done_at: at(4), start_error: "no machine" }),
      todo("e", { part_of: "req", ask: { verdict: "Done, please check", asked_at: at(6) } }),
      todo("f", { part_of: "req", created_at: at(2) }),
      todo("solo", { agents: [link("w")] }),
    ];
    const p = plan("p", "open", [task("X"), task("Y")], 2);
    const g = graph(todos, [session("asker", { state: "needs_you", status: "idle", asks: "Which DB?", state_since: at(5) }), session("w")], { p });
    const rows = queuedRows(g);
    // what needs the owner, what works, what failed and what waits to be accepted are not queued; an open plan waits for Start
    expect(rows.map((q) => [q.kind, q.title])).toEqual([["ready", "f"], ["ready", "c"], ["after", "b"]]);
    expect(rows[2].waits.map((n) => n.key)).toEqual(["todo:a"]);
    expect(rows[2].request.key).toBe("todo:req");
  });
});

describe("where a to-do stands", () => {
  const step = (t: Todo, sessions: Session[] = []) => pieceStep(t, todoStatus(t, makeSessionLookup(sessions)));
  const idle = (sid: string) => session(sid, { state: "idle", status: "idle", updated_at: at(0) });
  const agentOn = (sid: string) => ({ machine_id: "mac", session_id: sid, linked_at: at(0), released_at: null });

  it("puts what waits on the user first: a decision it asks, an Agent that needs them, a supervisor that passed it up, a failed start", () => {
    expect(step(todo("a", { agents: [agentOn("s")] }), [session("s", { state: "needs_you", status: "blocked" })])).toBe("needs_me");
    expect(step(todo("b", { ask: { outcome: "decide", verdict: "Pick one", asked_at: at(2) } }))).toBe("needs_me");
    expect(step(todo("c", { agents: [agentOn("s")], supervision: { supervisor: "conv", state: "needs_user" } }), [idle("s")])).toBe("needs_me");
    expect(step(todo("d", { start_error: "rpc closed", done_at: at(3) }))).toBe("needs_me");
  });

  it("reads 'it says it is done' as waiting to be accepted: a pending review, a reported done, a result to verify, a closed one nobody looked at", () => {
    expect(step(todo("a", { agents: [agentOn("s")], supervision: { supervisor: "conv", state: "pending_review" } }), [idle("s")])).toBe("review");
    expect(step(todo("b", { agents: [agentOn("s")], supervision: { supervisor: "conv", progress: { kind: "done", text: "Done", at: at(4) } } }), [idle("s")])).toBe("review");
    expect(step(todo("c", { ask: { outcome: "done", verdict: "Please verify", asked_at: at(2) } }))).toBe("review");
    expect(step(todo("d", { done_at: at(3), done_by: "auto" }))).toBe("review");
  });

  it("keeps the work going on in the middle, and the closed ones last", () => {
    expect(step(todo("a", { agents: [agentOn("s")] }), [session("s", { state: "working", status: "working" })])).toBe("working");
    expect(step(todo("b"))).toBe("working"); // nobody took it yet
    expect(step(todo("c", { done_at: at(3) }))).toBe("accepted");
    expect(step(todo("d", { done_at: at(3), done_by: "review" }))).toBe("accepted");
    expect(step(todo("e", { done_at: at(3), done_by: "auto", seen_at: at(4) }))).toBe("accepted");
    expect(step(todo("f", { agents: [agentOn("s")], supervision: { supervisor: "conv", state: "accepted", reviews: [{ at: at(2), verdict: "accepted" }] } }), [idle("s")])).toBe("accepted");
  });

  it("quotes the user's own words when the brief keeps them, else the title", () => {
    expect(requestWords(todo("t", { title: "Fix it", brief: { id: "b", created_at: at(0), started_by: "owner", goal: "g", request: { text: " It crashes, fix it ", at: at(0) } } }))).toEqual({ text: "It crashes, fix it", own: true });
    expect(requestWords(todo("t", { title: "Fix it" }))).toEqual({ text: "Fix it", own: false });
  });
});

describe("geometry", () => {
  it("places the words in the first column and every layer in the next, no card on another", () => {
    const todos = [todo("req"), todo("a", { part_of: "req" }), todo("b", { part_of: "req" }), todo("c", { part_of: "req", after: ["a", "b"] })];
    const r = graph(todos).active[0];
    const lay = layoutRequest(r);
    const boxes = [lay.root, ...lay.nodes.values()];
    for (const p of boxes) for (const q of boxes) {
      if (p === q) continue;
      const apart = p.x + CARD_W <= q.x || q.x + CARD_W <= p.x || p.y + CARD_H <= q.y || q.y + CARD_H <= p.y;
      expect(apart, `${p.key} / ${q.key}`).toBe(true);
    }
    expect(lay.width).toBeGreaterThanOrEqual(lay.nodes.get("todo:c")!.x + CARD_W);
    // every edge leaves its source's right edge (the hollow dot) and ends on its target's left edge
    for (const e of lay.edges) {
      const s = e.from === "root" ? lay.root : lay.nodes.get(e.from)!;
      const t = lay.nodes.get(e.to)!;
      expect(e.dot).toEqual([s.x + CARD_W, s.y + CARD_H / 2]);
      expect(e.d.endsWith(`L${t.x} ${t.y + CARD_H / 2}`)).toBe(true);
    }
  });

  it("rounds the corners of a path, never by more than half a leg", () => {
    expect(roundedPath([[0, 0], [10, 0], [10, 4], [20, 4]])).toBe("M0 0 L8 0 Q10 0 10 2 L10 2 Q10 4 12 4 L20 4");
    expect(roundedPath([[0, 0], [0, 0]])).toBe("");
  });
});
