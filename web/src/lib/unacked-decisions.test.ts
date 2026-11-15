// @vitest-environment node
// The Overview group's pure parts: the bodies of "I agree" / "No, change it", and the manager's list grouped by to-do.
// Which decisions wait is the manager's rule (server/internal/assistant/todo_unacked_test.go).
import { describe, expect, it } from "vitest";
import { ackBody, groupByTodo, overruleBody } from "./unacked-decisions";
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

  it("groups the newest-first list by to-do, the to-do with the latest call first, leaving out to-dos the page does not list", () => {
    const list = [decision("c", "t2", { created_at: at(3) }), decision("b", "t1", { created_at: at(2) }), decision("x", "gone", { created_at: at(2) }), decision("a", "t2", { created_at: at(1) })];
    expect(groupByTodo(list, (id) => id !== "gone").map((g) => [g.todoId, g.list.map((d) => d.id)])).toEqual([["t2", ["c", "a"]], ["t1", ["b"]]]);
  });
});
