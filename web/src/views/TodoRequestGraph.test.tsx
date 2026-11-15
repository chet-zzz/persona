// @vitest-environment jsdom
// The requests graph of the To-dos page: each request's pieces with their state and their Agent, the queued strip, a
// hovered piece lighting its lineage (and a queued row lighting its piece), a piece with a to-do opening it, and no
// native title balloons.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { initI18n } from "../i18n";
import type { TaskPlan } from "../lib/feed";
import { caseKey, caseName, caseTodos, MERGE_CASES, type MergeCase } from "../lib/request-graph-merge-cases";
import { makeSessionLookup, type Todo } from "../lib/todos";
import type { Machine, Session } from "../lib/types";
import TodoRequestGraph from "./TodoRequestGraph";

// the plans the feed knows: a test sets them and renders again
const feed = vi.hoisted(() => ({ plans: {} as Record<string, unknown> }));
vi.mock("../lib/feed", async (orig) => ({ ...(await orig<typeof import("../lib/feed")>()), useFeed: (select: (s: { plans: Record<string, unknown> }) => unknown) => select(feed) }));

// a hub without a direction tree: nothing to read
vi.mock("../lib/direction-tree", async (orig) => ({ ...(await orig<typeof import("../lib/direction-tree")>()), useDirectionTree: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const machines: Machine[] = [{ id: "mac", name: "MacBook", online: true }];
const session = (sid: string, patch: Partial<Session> = {}): Session =>
  ({ machine_id: "mac", session_id: sid, title: `agent ${sid}`, cwd: "/code", status: "working", state: "working", agent: "codex", model: "gpt-5.5", ...patch }) as Session;
const link = (sid: string) => ({ machine_id: "mac", session_id: sid, linked_at: at(30) });
const todo = (id: string, patch: Partial<Todo> = {}): Todo => ({ id, title: id, created_at: at(60), updated_at: at(5), agents: [], ...patch });

const todos = [
  todo("req", { title: "Search page", brief: { request: { text: "ship the search page", at: at(60) } } as Todo["brief"] }),
  todo("api", { title: "API fields", part_of: "req", done_at: at(40) }),
  todo("back", { title: "Back end", part_of: "req", after: ["api"], agents: [link("b1"), link("b2")] }),
  todo("front", { title: "Front end", part_of: "req", after: ["api"], agents: [link("f1")] }),
  todo("e2e", { title: "End to end", part_of: "req", after: ["back", "front"] }),
  todo("track", { title: "Tracking", part_of: "req", after: ["api"] }),
];
const sessions = [
  session("b1", { state_since: at(12) }),
  session("b2", { agent: "claude", model: "opus" }),
  session("f1", { agent: "claude", state: "needs_you", status: "idle", asks: "Empty state: show picks?" }),
];
const lookup = makeSessionLookup(sessions);

let host: HTMLDivElement;
let root: Root;
const opened: string[] = [];

beforeAll(() => initI18n("en"));
beforeEach(() => {
  localStorage.clear();
  feed.plans = {};
  opened.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(
    <TodoRequestGraph todos={todos} lookup={lookup} machines={machines} selectedId="front" onOpenTodo={(id) => opened.push(id)} />,
  ));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const card = (id: string) => host.querySelector<HTMLButtonElement>(`[data-node="todo:${id}"]`)!;
const enter = (el: Element) => act(() => { el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })); });
const leave = (el: Element) => act(() => { el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" })); });

describe("the requests graph", () => {
  it("draws each piece with its state and the Agent on it", () => {
    expect(host.querySelector('[data-root="todo:req"]')!.textContent).toContain("ship the search page");
    expect(card("api").dataset.state).toBe("done");
    expect(card("back").dataset.state).toBe("working");
    expect(card("back").querySelector("[data-node-detail]")!.textContent).toMatch(/12/);
    expect(card("back").querySelector("[data-node-agent]")!.getAttribute("data-node-agent")).toBe("mac/b1");
    expect(card("back").querySelector("[data-marks]")!.getAttribute("data-marks")).toBe("2");
    expect(card("back").textContent).toContain("MacBook");
    expect(card("front").dataset.state).toBe("needs_you");
    expect(card("front").textContent).toContain("Empty state: show picks?");
    expect(card("e2e").dataset.state).toBe("queued");
    expect(card("e2e").textContent).toContain("Waits for Back end, Front end");
    expect(card("track").dataset.state).toBe("ready");
    expect(card("track").querySelector("[data-no-agent]")).not.toBeNull();
    // dashed only into the queued piece
    expect([...host.querySelectorAll("[data-edge]")].filter((e) => e.getAttribute("stroke-dasharray")).map((e) => e.getAttribute("data-edge"))).toEqual(["todo:back>todo:e2e", "todo:front>todo:e2e"]);
  });

  it("lists only the queued pieces under the graph: those nobody took, then those that wait for others", () => {
    const strip = host.querySelector("[data-queued]")!;
    expect([...strip.querySelectorAll("[data-queued-row]")].map((r) => r.getAttribute("data-queued-row"))).toEqual(["todo:track", "todo:e2e"]);
    expect(strip.querySelector("[data-queued-count]")!.textContent).toBe("2");
    expect([...strip.querySelectorAll("[data-queued-why]")].map((r) => r.textContent)).toEqual(["Can start now; no Agent has it yet", "Waits for Back end, Front end"]);
    // what needs the owner is not here: the Overview and the to-do rows say it
    expect(host.querySelector('[data-queued-row="todo:front"]')).toBeNull();
    expect(host.querySelector("[data-graph-counts]")).toBeNull();
  });

  it("lights a hovered piece's lineage and dims the rest; a queued row lights its piece", () => {
    enter(card("e2e"));
    expect(card("e2e").hasAttribute("data-lit")).toBe(true);
    expect(card("track").hasAttribute("data-dim")).toBe(true);
    expect(card("back").hasAttribute("data-dim")).toBe(false);
    expect([...host.querySelectorAll("[data-edge][data-lit]")].map((e) => e.getAttribute("data-edge")).sort())
      .toEqual(["root>todo:api", "todo:api>todo:back", "todo:api>todo:front", "todo:back>todo:e2e", "todo:front>todo:e2e"]);
    leave(card("e2e"));
    expect(host.querySelectorAll("[data-node][data-dim]").length).toBe(0);
    const row = host.querySelector('[data-queued-row="todo:track"] button')!;
    enter(row);
    expect(card("track").hasAttribute("data-lit")).toBe(true);
    expect(card("back").hasAttribute("data-dim")).toBe(true);
    leave(row);
  });

  it("opens a piece's to-do on the page, from its card, the request's root or a queued row, and marks the open one", () => {
    act(() => card("front").click());
    act(() => card("track").click());
    act(() => host.querySelector<HTMLButtonElement>('[data-root="todo:req"]')!.click());
    act(() => host.querySelector<HTMLButtonElement>('[data-queued-row="todo:e2e"] button')!.click());
    expect(opened).toEqual(["front", "track", "req", "e2e"]);
    expect(card("front").getAttribute("aria-current")).toBe("true");
    expect(card("track").hasAttribute("aria-current")).toBe(false);
    expect([...host.querySelectorAll("[data-node]")].every((n) => n.tagName === "BUTTON")).toBe(true);
  });

  it("draws a task of a plan not started yet as a card with nothing to open", () => {
    const plan: TaskPlan = { id: "p", conversation: "main", state: "open", tasks: [{ title: "Write docs", prompt: "x", machine: "mac", cwd: "/c" }], created_at: at(1) };
    feed.plans = { p: plan };
    act(() => root.render(<TodoRequestGraph todos={todos} lookup={lookup} machines={machines} onOpenTodo={(id) => opened.push(id)} />));
    const planned = host.querySelector<HTMLElement>('[data-node="plan:p/0"]')!;
    expect(planned.tagName).toBe("DIV");
    expect(planned.dataset.state).toBe("queued");
    expect(planned.textContent).toContain("Not started");
    act(() => planned.click());
    expect(opened).toEqual([]);
    expect(host.querySelector('[data-queued-row="plan:p/0"]')).toBeNull();
  });

  it("puts no text in title attributes", () => {
    expect(host.querySelectorAll("[data-graph] [title]").length).toBe(0);
  });
});

describe("a request of one piece, and nothing queued", () => {
  const render = (list: Todo[], lookupSessions: Session[] = []) => act(() => root.render(
    <TodoRequestGraph todos={list} lookup={makeSessionLookup(lookupSessions)} machines={machines} onOpenTodo={() => {}} />,
  ));

  it("draws one card with when it was said when the words are the piece's title, and both cards when they differ", () => {
    render([
      todo("same", { title: "Rename the repo", agents: [link("s1")] }),
      todo("other", { title: "Rename it", brief: { request: { text: "please rename the repo", at: at(3) } } as Todo["brief"] }),
    ], [session("s1")]);
    const same = host.querySelector('[data-request="todo:same"]')!;
    expect(same.querySelector("[data-root]")).toBeNull();
    expect(same.querySelectorAll("[data-edge]").length).toBe(0);
    expect(same.querySelector("[data-node-request]")!.textContent).toContain("Request");
    expect(same.querySelector("[data-node]")!.textContent).toContain("Rename the repo");
    const other = host.querySelector('[data-request="todo:other"]')!;
    expect(other.querySelector("[data-root]")!.textContent).toContain("please rename the repo");
    expect(other.querySelector("[data-node-request]")).toBeNull();
    expect(other.querySelectorAll("[data-edge]").length).toBe(1);
  });

  it("keeps the root's card, to open the request's to-do, when its one piece of the same name is done and it is not", () => {
    const opened: string[] = [];
    act(() => root.render(
      <TodoRequestGraph todos={[todo("req", { title: "Search page" }), todo("piece", { title: "Search page", part_of: "req", done_at: at(10) })]}
        lookup={makeSessionLookup([])} machines={machines} onOpenTodo={(id) => opened.push(id)} />,
    ));
    const block = host.querySelector('[data-request="todo:req"]')!;
    expect(block).not.toBeNull(); // still among the open requests
    const rootCard = block.querySelector<HTMLButtonElement>("[data-root]")!;
    expect(rootCard).not.toBeNull();
    expect(block.querySelector("[data-node-request]")).toBeNull();
    expect(block.querySelector('[data-node="todo:piece"]')).not.toBeNull();
    expect(block.querySelectorAll("[data-edge]").length).toBe(1);
    act(() => rootCard.click());
    expect(opened).toEqual(["req"]);
  });

  it("keeps the root's card for an open request whose same-name piece the hub closed and nobody looked at yet", () => {
    const opened: string[] = [];
    act(() => root.render(
      <TodoRequestGraph todos={[todo("req", { title: "Search page" }), todo("piece", { title: "Search page", part_of: "req", done_at: at(10), done_by: "auto", done_reason: "finished" })]}
        lookup={makeSessionLookup([])} machines={machines} onOpenTodo={(id) => opened.push(id)} />,
    ));
    const block = host.querySelector('[data-request="todo:req"]')!;
    expect(block).not.toBeNull(); // among the open requests
    expect(block.querySelector('[data-node="todo:piece"]')!.textContent).toContain("Awaiting review");
    expect(block.querySelector("[data-node-request]")).toBeNull();
    const rootCard = block.querySelector<HTMLButtonElement>("[data-root]")!;
    expect(rootCard).not.toBeNull();
    act(() => rootCard.click());
    expect(opened).toEqual(["req"]);
  });

  it("draws one card or both for every root × piece, open requests in the graph and finished ones under Done", () => {
    const all = MERGE_CASES.map((c) => caseTodos(c, at, todo));
    const opened: string[] = [];
    act(() => root.render(
      <TodoRequestGraph todos={all.flatMap((x) => x.todos)} lookup={makeSessionLookup(all.flatMap((x) => x.sessions))} machines={machines} onOpenTodo={(id) => opened.push(id)} />,
    ));
    const fold = host.querySelector<HTMLButtonElement>("[data-graph-done] > button")!;
    act(() => fold.click());
    const check = (c: MergeCase, block: Element) => {
      const k = caseKey(c);
      const rootCard = block.querySelector<HTMLButtonElement>("[data-root]");
      const pieceCard = block.querySelector<HTMLButtonElement>(`[data-node="todo:p-${k}"]`);
      expect({ rootCard: Boolean(rootCard), mergedLabel: Boolean(block.querySelector("[data-node-request]")), pieceCard: Boolean(pieceCard), edges: block.querySelectorAll("[data-edge]").length }, caseName(c))
        .toEqual({ rootCard: !c.merged, mergedLabel: c.merged, pieceCard: true, edges: c.merged ? 0 : 1 });
      // whatever is drawn opens what it stands for: the root card the request's to-do, the piece's card the piece
      opened.length = 0;
      if (rootCard) act(() => rootCard.click());
      act(() => pieceCard!.click());
      expect(opened, caseName(c)).toEqual(c.merged ? [`p-${k}`] : [`r-${k}`, `p-${k}`]);
    };
    for (const c of MERGE_CASES) {
      const k = caseKey(c);
      const block = host.querySelector(`[data-request="todo:r-${k}"]`);
      const active = block && !block.closest("[data-graph-done]") ? block : null;
      const row = host.querySelector(`[data-done-request="todo:r-${k}"]`);
      expect({ active: Boolean(active), done: Boolean(row) }, caseName(c)).toEqual({ active: !c.done, done: c.done });
      if (active) check(c, active);
      else {
        act(() => row!.querySelector<HTMLButtonElement>("button")!.click());
        check(c, row!.querySelector("[data-request]") ?? row!);
      }
    }
  });

  it("draws no queued strip when nothing is queued", () => {
    render([todo("w", { title: "Busy", agents: [link("s1")] })], [session("s1")]);
    expect(host.querySelector("[data-queued]")).toBeNull();
  });
});
