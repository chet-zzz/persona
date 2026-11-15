// What the Overview's "Decided for you, not acknowledged" group reads (views/HomeUnacked.tsx): the model's decisions on
// open to-dos that the owner has not acknowledged. Which ones wait is the manager's rule
// (server/internal/assistant/todo_unacked.go, docs/assistant/todos.md "Decisions made for you"), behind one route,
// GET /todos/decisions/unacked; this file only reads it and writes the owner's answers.
//   - read once when the group mounts, and again (at most every few hundred ms) when an open to-do changes: the hub
//     bumps a to-do's `updated_at` whenever a decision is written, so the open to-dos' stamps say when to read;
//   - a manager without the route (its route-level 404) is asked once, and the group then shows nothing.
import { api } from "./api";
import { isLegacySpacesRouteError, type TodoDecision } from "./todos";

const SETTLE_MS = 400;

export type UnackedState = { decisions: TodoDecision[]; unsupported: boolean };

/** Reads the list now and whenever `refresh` is called (coalesced); `onState` hears each read. A failed read keeps the
 *  list it had. */
export class UnackedFeed {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due = 0;
  private closed = false;
  private reading = false;
  private again = false;
  private state: UnackedState = { decisions: [], unsupported: false };

  constructor(
    private onState: (s: UnackedState) => void,
    private read: () => Promise<TodoDecision[]> = async () => (await api<{ decisions?: TodoDecision[] }>("/todos/decisions/unacked")).decisions ?? [],
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
    this.state = s;
    this.onState(s);
  }
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
