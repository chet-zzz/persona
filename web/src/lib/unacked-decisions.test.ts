// @vitest-environment node
// The Overview group's pure parts: the bodies of "I agree" / "No, change it", and the manager's list grouped by to-do.
// Which decisions wait is the manager's rule (server/internal/assistant/todo_unacked_test.go); when a concern's report
// stops waiting on its own the answer says (waits_until), and the feed drops it then and reads once more (#8557 review).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ackBody, EXPIRY_CHECK_MS, groupByTodo, listsUnacked, nextExpiry, overruleBody, stillWaiting, UnackedFeed, type UnackedDecision, type UnackedState } from "./unacked-decisions";
import type { TodoDecision } from "./todos";

const at = (m: number) => new Date(Date.UTC(2026, 10, 14, 10, m)).toISOString();
const decision = (id: string, todo: string, patch: Partial<TodoDecision> = {}): TodoDecision =>
  ({ id, todo_id: todo, question: "Which?", choice: "A", reason: "", source: "agent", source_machine: "", source_session: "", source_message: "", supersedes_id: "", superseded_by: "", created_at: at(1), ...patch });

describe("not acknowledged", () => {
  it("'I agree' and 'No, change it' write the user's decision on the same question, replacing the model's", () => {
    const d = decision("d1", "t", { question: "Branch?", choice: "fix/a" });
    expect(ackBody(d)).toEqual({ question: "Branch?", choice: "fix/a", supersedes_id: "d1" });
    expect(overruleBody(d, " main ", " keep it simple ")).toEqual({ question: "Branch?", choice: "main", reason: "keep it simple", supersedes_id: "d1" });
  });

  it("may list an open to-do's calls and a concern's its report closed, never another closed to-do's", () => {
    expect(listsUnacked({ done_at: null })).toBe(true);
    expect(listsUnacked({ done_at: at(2), kind: "concern", done_by: "reported" })).toBe(true);
    expect(listsUnacked({ done_at: at(2) })).toBe(false);
    expect(listsUnacked({ done_at: at(2), done_by: "reported" })).toBe(false);
  });

  it("groups the newest-first list by to-do, the to-do with the latest call first, leaving out to-dos the page does not list", () => {
    const list = [decision("c", "t2", { created_at: at(3) }), decision("b", "t1", { created_at: at(2) }), decision("x", "gone", { created_at: at(2) }), decision("a", "t2", { created_at: at(1) })];
    expect(groupByTodo(list, (id) => id !== "gone").map((g) => [g.todoId, g.list.map((d) => d.id)])).toEqual([["t2", ["c", "a"]], ["t1", ["b"]]]);
  });
});

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();
/** A call on an open to-do (it waits until the to-do changes), or a concern's report waiting until `until` (ms). */
const call = (id: string): UnackedDecision => decision(id, "t_" + id);
const report = (id: string, until: number): UnackedDecision => ({ ...decision(id, "c_" + id, { source: "reported" }), waits_until: iso(until) });

describe("when a concern's report stops waiting", () => {
  // waits_until is the last instant listed (the manager's waitsOn: not past it)
  it.each<[string, UnackedDecision[], number, string[], number | undefined]>([
    ["nothing listed", [], T0, [], undefined],
    ["an open to-do's call never expires on its own", [call("a")], T0 + 365 * DAY, ["a"], undefined],
    ["a report a week ahead", [report("r", T0 + WEEK)], T0, ["r"], T0 + WEEK + 1],
    ["a report a millisecond before its cutoff", [report("r", T0 + WEEK)], T0 + WEEK - 1, ["r"], T0 + WEEK + 1],
    ["a report exactly at its cutoff", [report("r", T0 + WEEK)], T0 + WEEK, ["r"], T0 + WEEK + 1],
    ["a report a millisecond past its cutoff", [report("r", T0 + WEEK)], T0 + WEEK + 1, [], undefined],
    ["a report long past", [report("r", T0 - DAY)], T0, [], undefined],
    ["two reports: the earlier cutoff is next", [report("late", T0 + WEEK), call("a"), report("soon", T0 + DAY)], T0, ["late", "a", "soon"], T0 + DAY + 1],
    ["two reports, the first past: the other is next", [report("late", T0 + WEEK), call("a"), report("soon", T0 + DAY)], T0 + 2 * DAY, ["late", "a"], T0 + WEEK + 1],
    ["an unreadable waits_until is left to the manager", [{ ...call("x"), waits_until: "not a time" }], T0, ["x"], undefined],
  ])("%s", (_name, list, now, shown, next) => {
    expect(stillWaiting(list, now).map((d) => d.id)).toEqual(shown);
    expect(nextExpiry(list, now)).toBe(next);
  });
});

/** One step of a feed's life: move the clock to `at` (ms; reached by fake timers, never waited for), then optionally
 *  have its to-do change (refresh, the hook's updated_at stamp moving, and its coalescing wait) or the page close it;
 *  then what it shows, how many reads it made, and how many timers are left. */
interface Step { at: number; then?: "refresh" | "close"; shown: string[]; reads: number; timers?: number }

describe("the feed drops an expired report on time, with nothing written to its to-do", () => {
  afterEach(() => vi.useRealTimers());
  const flush = async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); };

  const cases: { name: string; answers: UnackedDecision[][]; steps: Step[] }[] = [
    {
      name: "an open to-do's call: no timer, never read again",
      answers: [[call("a")]],
      steps: [{ at: T0, shown: ["a"], reads: 1, timers: 0 }, { at: T0 + 30 * DAY, shown: ["a"], reads: 1, timers: 0 }],
    },
    {
      name: "a reported, unacknowledged concern: listed through its cutoff, gone just after and read once more",
      answers: [[report("r", T0 + WEEK)], []],
      steps: [
        { at: T0, shown: ["r"], reads: 1, timers: 1 },
        // a week is many hourly looks, each local: no read before the cutoff
        { at: T0 + 3 * DAY, shown: ["r"], reads: 1, timers: 1 },
        { at: T0 + WEEK - 1, shown: ["r"], reads: 1, timers: 1 },
        { at: T0 + WEEK, shown: ["r"], reads: 1, timers: 1 },
        { at: T0 + WEEK + 1, shown: [], reads: 2, timers: 0 },
        { at: T0 + 30 * DAY, shown: [], reads: 2, timers: 0 },
      ],
    },
    {
      name: "the manager's clock a little behind: the row stays gone here, and no read loop",
      answers: [[report("r", T0 + WEEK)]], // every read still lists it
      steps: [
        { at: T0 + WEEK + 1, shown: [], reads: 2, timers: 0 },
        { at: T0 + 30 * DAY, shown: [], reads: 2, timers: 0 },
      ],
    },
    {
      name: "acknowledged before its cutoff: the next read drops it and the timer with it",
      answers: [[report("r", T0 + WEEK)], []],
      steps: [
        { at: T0 + DAY, then: "refresh", shown: [], reads: 2, timers: 0 },
        { at: T0 + WEEK + 1, shown: [], reads: 2, timers: 0 },
      ],
    },
    {
      name: "the to-do changes but the report still waits: the timer stays on the same cutoff",
      answers: [[report("r", T0 + WEEK)], [report("r", T0 + WEEK), call("a")], [call("a")]],
      steps: [
        { at: T0 + DAY, then: "refresh", shown: ["r", "a"], reads: 2, timers: 1 },
        { at: T0 + WEEK, shown: ["r", "a"], reads: 2, timers: 1 },
        { at: T0 + WEEK + 1, shown: ["a"], reads: 3, timers: 0 },
      ],
    },
    {
      name: "reopened before its cutoff (the to-do changes): the manager no longer lists it",
      answers: [[report("r", T0 + WEEK)], []],
      steps: [
        { at: T0 + 2 * DAY, then: "refresh", shown: [], reads: 2, timers: 0 },
      ],
    },
    {
      name: "two reports with different cutoffs leave one after the other",
      answers: [[report("late", T0 + WEEK), call("a"), report("soon", T0 + 2 * DAY)], [report("late", T0 + WEEK), call("a")], [call("a")]],
      steps: [
        { at: T0, shown: ["late", "a", "soon"], reads: 1, timers: 1 },
        { at: T0 + 2 * DAY, shown: ["late", "a", "soon"], reads: 1, timers: 1 },
        { at: T0 + 2 * DAY + 1, shown: ["late", "a"], reads: 2, timers: 1 },
        { at: T0 + WEEK, shown: ["late", "a"], reads: 2, timers: 1 },
        { at: T0 + WEEK + 1, shown: ["a"], reads: 3, timers: 0 },
      ],
    },
    {
      name: "a report already past when read is never shown",
      answers: [[report("old", T0 - 1), call("a")]],
      steps: [{ at: T0, shown: ["a"], reads: 1, timers: 0 }],
    },
    {
      name: "closed (the page goes): no timer left, no read at the cutoff",
      answers: [[report("r", T0 + WEEK)]],
      steps: [
        { at: T0 + DAY, then: "close", shown: ["r"], reads: 1, timers: 0 },
        { at: T0 + WEEK + 1, shown: ["r"], reads: 1, timers: 0 },
      ],
    },
  ];

  it.each(cases)("$name", async ({ answers, steps }) => {
    vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "Date"] });
    let reads = 0;
    let shown: string[] = [];
    const feed = new UnackedFeed((s: UnackedState) => { shown = s.decisions.map((d) => d.id); }, async () => answers[Math.min(reads++, answers.length - 1)]);
    feed.refresh(true);
    await flush();
    for (const step of steps) {
      await vi.advanceTimersByTimeAsync(step.at - Date.now());
      await flush();
      if (step.then === "close") feed.close();
      if (step.then === "refresh") {
        feed.refresh();
        await vi.advanceTimersByTimeAsync(500); // past the coalescing wait (SETTLE_MS); refresh steps are far from any cutoff
        await flush();
      }
      const label = `at T0+${(step.at - T0) / DAY}d`;
      expect(shown, label).toEqual(step.shown);
      expect(reads, label).toBe(step.reads);
      if (step.timers !== undefined) expect(vi.getTimerCount(), label).toBe(step.timers);
    }
    feed.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a timer is never set further than EXPIRY_CHECK_MS ahead, so a held timer is late by at most that", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["setTimeout", "clearTimeout", "Date"] });
    const feed = new UnackedFeed(() => {}, async () => [report("r", T0 + WEEK)]);
    feed.refresh(true);
    await flush();
    const spy = vi.spyOn(globalThis, "setTimeout");
    await vi.advanceTimersByTimeAsync(EXPIRY_CHECK_MS);
    expect(spy.mock.calls.map(([, ms]) => ms)).toEqual([EXPIRY_CHECK_MS]);
    feed.close();
  });
});
