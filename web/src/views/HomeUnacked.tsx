// The Overview's "Decided for you, not acknowledged" group (lib/unacked-decisions.ts): across the open to-dos (and the
// concerns a report closed), the model's calls the user has not acknowledged, with "I agree" / "No, change it" in place. Which calls wait is the manager's
// rule, read in one request (GET /todos/decisions/unacked). Home loads this chunk after its first paint; it draws
// nothing while there is nothing to acknowledge.
//
// Kept short on purpose: the owner cares about the calls that change the plan, not each detail. A decision is one or
// two lines (what was asked, what was chosen); why, when and by whom open under it. A to-do with many of the model's
// calls shows the latest few, the rest folded under "N more", and "I agree with all on this to-do" takes them at once.
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, t } from "../i18n";
import { errorText } from "../lib/api";
import { useScopedTodos } from "../lib/current-assistant";
import { useChosenManager, useKnownDefault } from "../lib/manager-choice";
import { href, onLinkClick, type Route } from "../lib/router";
import { addTodoDecision, type Todo, type TodoDecision } from "../lib/todos";
import { ackBody, groupByTodo, listsUnacked, overruleBody, UNACKED_FIRST, UnackedFeed, type UnackedState } from "../lib/unacked-decisions";
import { Button, cx, toast } from "../ui/atoms";
import { Icon } from "../ui/icons";
import { Group } from "./Home";

const field = "w-full rounded-control bg-field px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:ring-2 focus:ring-accent";

interface UnackedGroup {
  todo: Todo;
  list: TodoDecision[];
}

/** The groups to show, the to-do with the latest call first, and the feed to read again after a write. */
function useUnacked(): { feed: UnackedFeed | null; groups: UnackedGroup[] } {
  const todos = useScopedTodos();
  // the list is the current assistant's manager's (its request names a pick, lib/manager-choice.ts; without one the hub
  // sends it to the roster's default): the pick, else that default once known. Another manager is another list, read
  // afresh, and whether it has the route is asked again; nothing is read by the placeholder default.
  const chosen = useChosenManager();
  const knownDefault = useKnownDefault();
  const manager = chosen ?? knownDefault;
  const [state, setState] = useState<UnackedState>({ decisions: [], unsupported: false });
  const [feed, setFeed] = useState<UnackedFeed | null>(null);
  useEffect(() => {
    setState({ decisions: [], unsupported: false });
    if (!manager) {
      setFeed(null);
      return;
    }
    const made = new UnackedFeed(setState);
    setFeed(made);
    made.refresh(true);
    return () => made.close();
  }, [manager]);
  // a decision written anywhere moves its to-do's updated_at: the stamps of the to-dos it may list say when to read again
  const stamp = useMemo(() => todos.filter(listsUnacked).map((td) => td.id + "@" + td.updated_at).join(","), [todos]);
  const seen = useRef(stamp);
  useEffect(() => {
    if (!feed || seen.current === stamp) return;
    seen.current = stamp;
    feed.refresh();
  }, [feed, stamp]);
  const groups = useMemo(() => {
    const byId = new Map(todos.filter(listsUnacked).map((td) => [td.id, td]));
    return groupByTodo(state.decisions, (id) => byId.has(id)).map(({ todoId, list }) => ({ todo: byId.get(todoId)!, list }));
  }, [state, todos]);
  return { feed, groups };
}

/** Writes the user's decisions on a to-do one after another, then reads the list again; false when one failed (said). */
async function writeMine(feed: UnackedFeed, todoId: string, bodies: { question: string; choice: string; reason?: string; supersedes_id?: string }[]): Promise<boolean> {
  let ok = true;
  for (const body of bodies) {
    try {
      await addTodoDecision(todoId, body);
    } catch (e) {
      ok = false;
      toast(t("unacked-decisions.failed", { error: errorText(e) }), "error");
      break;
    }
  }
  feed.refresh(true);
  return ok;
}

/** "Its call": who made a decision, in words and a mark. */
function OriginTag() {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-chip bg-accent-tint px-1.5 text-xs font-medium text-accent-ink" data-origin="its">
      <Icon name="sparkles" size={11} />
      {t("unacked-decisions.origin_its")}
    </span>
  );
}

function sourceWords(d: TodoDecision): string {
  switch (d.source) {
    case "agent": return t("unacked-decisions.source_agent");
    case "outcome": return t("unacked-decisions.source_outcome");
    case "reported": return t("unacked-decisions.source_reported");
  }
  return "";
}

/**
 * One call in two lines: who, what was asked, what was chosen. Why, when and where it came from open under it.
 * "I agree" and "No, change it" (their own choice and why) each write the user's decision replacing it.
 */
function DecisionLine({ d, todoId, feed }: { d: TodoDecision; todoId: string; feed: UnackedFeed }) {
  const [more, setMore] = useState(false);
  const [changing, setChanging] = useState(false);
  const [choice, setChoice] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (body: Parameters<typeof writeMine>[2][number]) => {
    setBusy(true);
    const ok = await writeMine(feed, todoId, [body]);
    setBusy(false);
    if (ok) setChanging(false);
  };
  return (
    <li className="min-w-0 rounded-control bg-surface px-2 py-1.5 shadow-hairline" data-decision={d.id}>
      <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="flex w-full min-w-0 items-start gap-2 text-left">
        <OriginTag />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs leading-4 text-ink">{d.question}</span>
          <span className="block truncate text-xs leading-4 font-medium text-ink">
            <span className="font-normal text-ink-3">{t("unacked-decisions.chose")}</span>
            {d.choice}
          </span>
        </span>
        <Icon name={more ? "chevron" : "chevronRight"} size={13} className="mt-1 shrink-0 text-ink-3" />
      </button>
      {more && (
        <div className="mt-1.5 space-y-0.5 pl-1 text-xs text-ink-3" data-decision-more="">
          {d.reason && <p className="text-xs text-ink-2">{t("unacked-decisions.because", { reason: d.reason })}</p>}
          <p>{[formatDate(d.created_at, { dateStyle: "medium", timeStyle: "short" }), sourceWords(d)].filter(Boolean).join(" · ")}</p>
        </div>
      )}
      {!changing && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Button tone="secondary" size="sm" icon="check" busy={busy} className="whitespace-nowrap" onClick={() => void run(ackBody(d))} testId="decision-ack">{t("unacked-decisions.ack")}</Button>
          <Button tone="quiet" size="sm" icon="pencil" disabled={busy} className="whitespace-nowrap" onClick={() => setChanging(true)} testId="decision-change">{t("unacked-decisions.overrule")}</Button>
        </div>
      )}
      {changing && (
        <form className="mt-2 space-y-1.5" onSubmit={(e) => { e.preventDefault(); if (choice.trim()) void run(overruleBody(d, choice, reason)); }} data-overrule="">
          <input aria-label={t("unacked-decisions.overrule_choice")} placeholder={t("unacked-decisions.overrule_choice")} value={choice} onChange={(e) => setChoice(e.target.value)} className={field} />
          <textarea aria-label={t("unacked-decisions.overrule_reason")} placeholder={t("unacked-decisions.overrule_reason")} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={cx(field, "resize-none")} />
          <div className="flex items-center justify-end gap-2">
            <Button tone="quiet" size="sm" className="whitespace-nowrap" onClick={() => setChanging(false)}>{t("unacked-decisions.cancel")}</Button>
            <Button type="submit" tone="primary" size="sm" busy={busy} disabled={!choice.trim()} className="whitespace-nowrap">{t("unacked-decisions.overrule_save")}</Button>
          </div>
        </form>
      )}
    </li>
  );
}

/** One to-do's calls: its title (opens the to-do), the latest few, the rest under "N more", and "I agree with all" when
 *  there are two or more. */
function TodoUnacked({ g, feed }: { g: UnackedGroup; feed: UnackedFeed }) {
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const to: Route = { name: "todos", id: g.todo.id };
  const shown = all ? g.list : g.list.slice(0, UNACKED_FIRST);
  const ackAll = async () => {
    setBusy(true);
    await writeMine(feed, g.todo.id, g.list.map(ackBody));
    setBusy(false);
  };
  return (
    <div className="min-w-0 space-y-1.5" data-unacked-group={g.todo.id}>
      <a href={href(to)} onClick={(e) => onLinkClick(e, to)} className="block truncate text-meta font-medium text-ink hover:underline">{g.todo.title}</a>
      <ul className="space-y-1.5">
        {shown.map((d) => <DecisionLine key={d.id} d={d} todoId={g.todo.id} feed={feed} />)}
      </ul>
      {(g.list.length > shown.length || g.list.length > 1) && (
        <div className="flex flex-wrap items-center gap-2">
          {g.list.length > shown.length && <Button tone="quiet" size="sm" className="whitespace-nowrap" onClick={() => setAll(true)}>{t("unacked-decisions.more_unacked", { count: g.list.length - shown.length })}</Button>}
          {g.list.length > 1 && <Button tone="quiet" size="sm" icon="check" busy={busy} className="whitespace-nowrap" onClick={() => void ackAll()} testId="decision-ack-all">{t("unacked-decisions.ack_all")}</Button>}
        </div>
      )}
    </div>
  );
}

export default function HomeUnacked() {
  const { feed, groups } = useUnacked();
  if (!feed || !groups.length) return null;
  const count = groups.reduce((n, g) => n + g.list.length, 0);
  return (
    <Group title={t("unacked-decisions.title")} count={count} grid>
      {groups.map((g) => <TodoUnacked key={g.todo.id} g={g} feed={feed} />)}
    </Group>
  );
}
