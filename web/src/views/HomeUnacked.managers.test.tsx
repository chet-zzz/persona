// @vitest-environment jsdom
// The Overview's "Decided for you, not acknowledged" group with several assistants: its one request goes through the real
// API path (lib/api.ts, lib/manager-choice.ts managerHeaderFor) and names the picked assistant, so the hub sends it to
// that assistant's manager rather than the default's; picking another reads that one's list afresh. Only fetch is
// stubbed: it answers as each manager would, by the X-Persona-Manager header the request carries.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { initI18n } from "../i18n";
import { setToken } from "../lib/api";
import { chooseManager, MANAGER_HEADER, managerHeaderFor, resetManagerChoice, setRosterDefault } from "../lib/manager-choice";
import type { Todo, TodoDecision } from "../lib/todos";

// the page's to-dos are the current assistant's (lib/current-assistant.ts scopes the store's): here, both managers'
const hub = vi.hoisted(() => ({ todos: [] as unknown[] }));
vi.mock("../lib/current-assistant", async (orig) => ({ ...(await orig<typeof import("../lib/current-assistant")>()), useScopedTodos: () => hub.todos }));

const { default: HomeUnacked } = await import("./HomeUnacked");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (m: number) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
const todo = (id: string, manager: string): Todo => ({ id, title: `Todo ${id}`, created_at: at(0), updated_at: at(0), done_at: null, agents: [], manager });
const decision = (id: string, todoId: string): TodoDecision =>
  ({ id, todo_id: todoId, question: `Question ${id}?`, choice: "A", reason: "", source: "agent", source_machine: "", source_session: "", source_message: "", supersedes_id: "", superseded_by: "", created_at: at(1) });

// what each manager answers GET /todos/decisions/unacked with (the default's when the request names none)
const answers: Record<string, TodoDecision[]> = { assistant: [decision("d_default", "t_default")], "m-1": [decision("d_m1", "t_m1")] };
let asked: { url: string; manager: string | null }[] = [];
// the hub sends a request that names no manager to its default; a manager listed here is from before the route
let hubDefault = "assistant";
let withoutRoute = new Set<string>();

let host: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const shown = () => [...host.querySelectorAll("[data-decision]")].map((el) => el.getAttribute("data-decision"));

beforeAll(() => initI18n("en"));
beforeEach(() => {
  localStorage.clear();
  resetManagerChoice();
  setRosterDefault("assistant");
  setToken("synthetic");
  asked = [];
  hubDefault = "assistant";
  withoutRoute = new Set();
  hub.todos = [todo("t_default", "assistant"), todo("t_m1", "m-1")];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const manager = new Headers(init?.headers).get(MANAGER_HEADER);
    // only this group's request is counted (picking an assistant reads its profile too)
    if (String(url).endsWith("/todos/decisions/unacked")) asked.push({ url: String(url), manager });
    const answering = manager ?? hubDefault;
    // a manager before the route: the mux's plain-text 404
    if (String(url).endsWith("/todos/decisions/unacked") && withoutRoute.has(answering)) return new Response("404 page not found\n", { status: 404, headers: { "Content-Type": "text/plain" } });
    return new Response(JSON.stringify({ decisions: answers[answering] ?? [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setToken("");
  resetManagerChoice();
});

describe("the unacknowledged decisions of the picked assistant", () => {
  it("names the picked assistant on the collection request, and none for the default", () => {
    expect(managerHeaderFor("/todos/decisions/unacked")).toBeUndefined();
    chooseManager("m-1");
    expect(managerHeaderFor("/todos/decisions/unacked")).toBe("m-1");
    chooseManager(null);
    expect(managerHeaderFor("/todos/decisions/unacked")).toBeUndefined();
  });

  it("reads the picked assistant's list from its manager, and the other one's afresh when the pick changes", async () => {
    chooseManager("m-1");
    act(() => root.render(<HomeUnacked />));
    await settle();
    await settle();
    expect(asked).toEqual([{ url: expect.stringMatching(/\/api\/v1\/todos\/decisions\/unacked$/), manager: "m-1" }]);
    expect(shown()).toEqual(["d_m1"]);

    act(() => chooseManager(null));
    await settle();
    await settle();
    expect(asked.map((a) => a.manager)).toEqual(["m-1", null]);
    expect(shown()).toEqual(["d_default"]);
  });
  // #8557 review: no pick, and the roster's default moves from a manager before the route to one with it. The old
  // default's 404 marks only its own feed unsupported: the new default is another manager, asked afresh.
  it("asks the new default afresh after the old default had no route", async () => {
    withoutRoute = new Set(["assistant"]);
    act(() => root.render(<HomeUnacked />));
    await settle();
    await settle();
    expect(asked.map((a) => a.manager)).toEqual([null]);
    expect(host.innerHTML).toBe("");

    hubDefault = "m-1";
    act(() => setRosterDefault("m-1"));
    await settle();
    await settle();
    // no pick, so still no header: the hub's new default answers
    expect(asked.map((a) => a.manager)).toEqual([null, null]);
    expect(shown()).toEqual(["d_m1"]);
  });

  it("keeps a manager without the route quiet while the default stays", async () => {
    withoutRoute = new Set(["assistant"]);
    act(() => root.render(<HomeUnacked />));
    await settle();
    await settle();
    act(() => setRosterDefault("assistant"));
    hub.todos = [todo("t_default", "assistant"), { ...todo("t_m1", "m-1"), updated_at: at(9) }];
    act(() => root.render(<HomeUnacked />));
    await act(async () => { await new Promise((r) => setTimeout(r, 450)); });
    expect(asked.length).toBe(1);
    expect(host.innerHTML).toBe("");
  });
});
