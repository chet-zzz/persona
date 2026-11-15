// What the Overview's "Decided for you, not acknowledged" group reads (views/HomeUnacked.tsx): the model's decisions on
// open to-dos, and the reports of concerns they closed, that the owner has not acknowledged. Which ones wait is the manager's rule
// (server/internal/assistant/todo_unacked.go, docs/assistant/todos.md "Decisions made for you"), behind one route,
// GET /todos/decisions/unacked; this file only reads it and writes the owner's answers.
//   - read once when the group mounts, and again (at most every few hundred ms) when a to-do it may list changes: the
//     hub bumps a to-do's `updated_at` whenever a decision is written, so those to-dos' stamps say when to read;
//   - a concern's report stops waiting on its own, with nothing written to its to-do (its seven days run out): the route
//     says when (`waits_until`), and at that instant the row leaves the list here and the list is read once more;
//   - a manager without the route (its route-level 404) is asked once, and the group then shows nothing.
import { api } from "./api";
import { isLegacySpacesRouteError, type Todo, type TodoDecision } from "./todos";

const SETTLE_MS = 400;
/** The longest a wait for a `waits_until` sleeps before looking at the clock again: a computer asleep or a throttled tab
 *  can hold a timer past its time, so a row still leaves at most this late (each look is local, never a read). */
export const EXPIRY_CHECK_MS = 60 * 60 * 1000;

/** One listed decision as the route answers it: `waits_until`, on a concern's report, is the last instant it waits
 *  (the manager's rule, server/internal/assistant/todo_unacked.go waitsUntil); absent, only a change to its to-do ends it. */
export type UnackedDecision = TodoDecision & { waits_until?: string };

export type UnackedState = { decisions: UnackedDecision[]; unsupported: boolean };

/** The decisions still waiting at `now` (ms): those past their `waits_until` are gone, as the manager answers. */
export function stillWaiting(decisions: readonly UnackedDecision[], now: number): UnackedDecision[] {
  return decisions.filter((d) => !d.waits_until || !(now > Date.parse(d.waits_until)));
}

/** The first instant (ms) after `now` at which one of the decisions stops waiting, or undefined when none will. */
export function nextExpiry(decisions: readonly UnackedDecision[], now: number): number | undefined {
  let next: number | undefined;
  for (const d of decisions) {
    const until = d.waits_until ? Date.parse(d.waits_until) : NaN;
    if (Number.isNaN(until) || until < now) continue;
    const gone = until + 1; // listed up to and at waits_until, gone just after
    if (next === undefined || gone < next) next = gone;
  }
  return next;
}

/** Reads the list now and whenever `refresh` is called (coalesced); `onState` hears each read. A failed read keeps the
 *  list it had. When a listed decision's `waits_until` passes, it drops that row and reads once more (one timer, for
 *  the earliest). */
export class UnackedFeed {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private due = 0;
  private closed = false;
  private reading = false;
  private again = false;
  private state: UnackedState = { decisions: [], unsupported: false };

  constructor(
    private onState: (s: UnackedState) => void,
    private read: () => Promise<UnackedDecision[]> = async () => (await api<{ decisions?: UnackedDecision[] }>("/todos/decisions/unacked")).decisions ?? [],
  ) {}

  /** Read again soon (several calls in a row make one read). */
  refresh(now = false) {
    if (this.closed || this.state.unsupported) return;
    const due = Date.now() + (now ? 0 : SETTLE_MS);
    if (this.timer !== undefined && this.due <= due && !now) return; // a read sooner is already on its way
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.load();
    }, due - Date.now());
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    this.timer = this.expiry = undefined;
  }

  private async load() {
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      const decisions = await this.read();
      if (!this.closed) this.set({ decisions, unsupported: false });
    } catch (e) {
      // the route-level 404 of a manager before this route: nothing to show, and no asking again
      if (!this.closed && isLegacySpacesRouteError(e)) this.set({ decisions: [], unsupported: true });
    } finally {
      this.reading = false;
      if (this.again && !this.closed) {
        this.again = false;
        void this.load();
      }
    }
  }

  private set(s: UnackedState) {
    const now = Date.now();
    this.state = { ...s, decisions: stillWaiting(s.decisions, now) };
    this.onState(this.state);
    this.armExpiry(now);
  }

  /** One timer for the earliest `waits_until` still ahead: then the row goes here at once (set filters it) and the list
   *  is read again, the manager's word on what else changed. A wait longer than EXPIRY_CHECK_MS looks again then. */
  private armExpiry(now: number) {
    clearTimeout(this.expiry);
    this.expiry = undefined;
    const next = this.closed ? undefined : nextExpiry(this.state.decisions, now);
    if (next === undefined) return;
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      if (this.closed) return;
      const at = Date.now();
      if (at < next) return this.armExpiry(at);
      this.set(this.state);
      // read in this same turn (a read already set for later is this one)
      clearTimeout(this.timer);
      this.timer = undefined;
      void this.load();
    }, Math.min(next - now, EXPIRY_CHECK_MS));
  }
}

/** Whether the group may list a call of to-do td: an open one, or a concern its report closed, whose report waits
 *  (which calls of it wait is the manager's rule, server/internal/assistant/todo_unacked.go waitsOn). */
export function listsUnacked(td: Pick<Todo, "done_at" | "kind" | "done_by">): boolean {
  return !td.done_at || (td.kind === "concern" && td.done_by === "reported");
}

/** The decisions grouped by to-do, the to-do with the latest call first, each group newest first (as the route gives
 *  them); `known` keeps the to-dos this page lists (another assistant's are not drawn here). */
export function groupByTodo(decisions: readonly TodoDecision[], known: (id: string) => boolean): { todoId: string; list: TodoDecision[] }[] {
  const groups = new Map<string, TodoDecision[]>();
  for (const d of decisions) {
    if (!known(d.todo_id)) continue;
    groups.set(d.todo_id, [...(groups.get(d.todo_id) ?? []), d]);
  }
  return [...groups].map(([todoId, list]) => ({ todoId, list }));
}

/** "I agree": the user's decision on the same question with the same choice, replacing the model's
 *  (POST /todos/{id}/decisions takes an earlier decision of the same to-do as supersedes_id). */
export function ackBody(d: TodoDecision): { question: string; choice: string; supersedes_id: string } {
  return { question: d.question, choice: d.choice, supersedes_id: d.id };
}

/** "No, change it": the user's decision on the same question with their own choice and why, replacing the model's. */
export function overruleBody(d: TodoDecision, choice: string, reason: string): { question: string; choice: string; reason: string; supersedes_id: string } {
  return { question: d.question, choice: choice.trim(), reason: reason.trim(), supersedes_id: d.id };
}

/** How many of a to-do's calls the group shows before "N more": the latest few. */
export const UNACKED_FIRST = 3;
