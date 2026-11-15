// @vitest-environment jsdom
// The Overview's "Decided for you, not acknowledged" group: the open to-dos' calls the user has not taken as theirs, by
// to-do, with "I agree" and "No, change it" writing the user's decision; nothing at all when there is none. The list is
// the manager's (GET /todos/decisions/unacked), read once and again when an open to-do changes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
});
import { initI18n } from "../i18n";
import type { Todo, TodoDecision } from "../lib/todos";

const hub = vi.hoisted(() => ({ todos: [] as unknown[], unacked: [] as unknown[], reads: 0, missing: false, written: [] as [string, unknown][] }));
vi.mock("../lib/current-assistant", async (orig) => ({ ...(await orig<typeof import("../lib/current-assistant")>()), useScopedTodos: () => hub.todos }));
vi.mock("../lib/api", async (orig) => {
  const real = await orig<typeof import("../lib/api")>();
  return {
    ...real,
    api: async (path: string) => {
      if (path !== "/todos/decisions/unacked") throw new Error(`unexpected read ${path}`);
      hub.reads++;
      // a manager before the route: the mux's plain-text 404
      if (hub.missing) throw new real.ApiError(404, "404 page not found", {}, false);
      return { decisions: hub.unacked };
    },
  };
});
vi.mock("../lib/todos", async (orig) => ({ ...(await orig<typeof import("../lib/todos")>()), addTodoDecision: async (id: string, body: unknown) => void hub.written.push([id, body]) }));

const { default: HomeUnacked } = await import("./HomeUnacked");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (m: number) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
const todo = (id: string, patch: Partial<Todo> = {}): Todo => ({ id, title: `Todo ${id}`, created_at: at(0), updated_at: at(0), done_at: null, agents: [], ...patch });
const decision = (id: string, source: string, patch: Partial<TodoDecision> = {}): TodoDecision =>
  ({ id, todo_id: "t1", question: "Which branch?", choice: "fix/a", reason: "", source, source_machine: "", source_session: "", source_message: "", supersedes_id: "", superseded_by: "", created_at: at(1), ...patch });

let host: HTMLDivElement;
let root: Root;
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const mount = async () => { act(() => root.render(<HomeUnacked />)); await settle(); await settle(); };
const later = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 450)); }); await settle(); };

beforeAll(() => initI18n("en"));
beforeEach(() => {
  hub.todos = [];
  hub.unacked = [];
  hub.reads = 0;
  hub.missing = false;
  hub.written = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the unacknowledged decisions group", () => {
  it("lists a model's call under its to-do, and 'I agree' writes the user's decision replacing it", async () => {
    hub.todos = [todo("t1"), todo("t2", { done_at: at(2) })];
    // the manager's list; a to-do the page does not list as open (done here) is not drawn
    hub.unacked = [decision("d1", "agent"), decision("d9", "agent", { todo_id: "t2" })];
    await mount();
    expect(host.querySelector("h2")!.textContent).toBe("Decided for you, not acknowledged");
    const group = host.querySelector('[data-unacked-group="t1"]')!;
    expect(group.textContent).toContain("Todo t1");
    expect(group.querySelectorAll("[data-decision]").length).toBe(1);
    expect(group.textContent).toContain("Which branch?");
    expect(group.textContent).toContain("fix/a");
    expect(host.querySelector('[data-unacked-group="t2"]')).toBeNull();
    expect(hub.reads).toBe(1);
    hub.unacked = [];
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="decision-ack"]')!.click());
    await settle();
    expect(hub.written).toEqual([["t1", { question: "Which branch?", choice: "fix/a", supersedes_id: "d1" }]]);
    // read again after the write: nothing waits now
    expect(hub.reads).toBe(2);
    expect(host.innerHTML).toBe("");
  });

  it("lists a concern's report while that report keeps it closed, and 'I agree' takes it as the user's", async () => {
    const title = "Is the nightly backup covered?";
    hub.todos = [todo("c1", { title, kind: "concern", done_at: at(3), done_by: "reported" })];
    hub.unacked = [decision("r1", "reported", { todo_id: "c1", question: title, choice: "Yes, every night at 2:00" })];
    await mount();
    const group = host.querySelector('[data-unacked-group="c1"]')!;
    expect(group.textContent).toContain(title);
    expect(group.textContent).toContain("Yes, every night at 2:00");
    act(() => group.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    expect(group.querySelector("[data-decision-more]")!.textContent).toContain("What the main conversation told you");
    await act(async () => group.querySelector<HTMLButtonElement>('[data-testid="decision-ack"]')!.click());
    await settle();
    expect(hub.written).toEqual([["c1", { question: title, choice: "Yes, every night at 2:00", supersedes_id: "r1" }]]);
  });

  it("'No, change it' asks for the user's own choice and why, then writes them replacing the call", async () => {
    hub.todos = [todo("t1")];
    hub.unacked = [decision("d1", "agent")];
    await mount();
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="decision-change"]')!.click());
    const form = host.querySelector<HTMLFormElement>("[data-overrule]")!;
    const [choice, reason] = [form.querySelector("input")!, form.querySelector("textarea")!];
    const set = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => act(() => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    set(choice, " main ");
    set(reason, "keep it simple");
    await act(async () => { form.requestSubmit(); });
    await settle();
    expect(hub.written).toEqual([["t1", { question: "Which branch?", choice: "main", reason: "keep it simple", supersedes_id: "d1" }]]);
  });

  it("shows only the latest few of many calls and takes them all at once", async () => {
    hub.todos = [todo("t1")];
    hub.unacked = [5, 4, 3, 2, 1].map((n) => decision(`d${n}`, "agent", { question: `Q${n}?`, created_at: at(n) }));
    await mount();
    expect(host.querySelectorAll("[data-decision]").length).toBe(3);
    expect(host.textContent).toContain("2 more");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="decision-ack-all"]')!.click());
    await settle();
    expect(hub.written.map(([, b]) => (b as { supersedes_id: string }).supersedes_id)).toEqual(["d5", "d4", "d3", "d2", "d1"]);
  });

  it("draws nothing at all while there is nothing to acknowledge, and reads again when an open to-do changes", async () => {
    hub.todos = [todo("t1"), todo("t2")];
    await mount();
    expect(hub.reads).toBe(1);
    expect(host.innerHTML).toBe("");
    // an Agent records a call: its to-do's updated_at moves, and the list is read again
    hub.unacked = [decision("d1", "agent")];
    hub.todos = [todo("t1", { updated_at: at(5) }), todo("t2")];
    act(() => root.render(<HomeUnacked />));
    await later();
    expect(hub.reads).toBe(2);
    expect(host.querySelectorAll("[data-decision]").length).toBe(1);
  });

  it("asks a manager without the route once, and shows nothing", async () => {
    hub.missing = true;
    hub.todos = [todo("t1")];
    await mount();
    hub.todos = [todo("t1", { updated_at: at(5) })];
    act(() => root.render(<HomeUnacked />));
    await later();
    expect(hub.reads).toBe(1);
    expect(host.innerHTML).toBe("");
  });
});
