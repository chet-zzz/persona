package assistant

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/db"
)

// Decided for you, not acknowledged (todo_unacked.go): which of the model's decisions wait for the owner, and the route
// that lists them across the open to-dos. Questions and choices are placeholders.

func TestUnackedDecisionsRule(t *testing.T) {
	at := func(m int) time.Time { return time.Date(2026, 11, 14, 10, m, 0, 0, time.UTC) }
	dec := func(id, source, question string, m int, mod func(*db.TodoDecisionRow)) db.TodoDecisionRow {
		d := db.TodoDecisionRow{ID: id, TodoID: "t", Question: question, Choice: "A", Source: source, CreatedAt: at(m)}
		if mod != nil {
			mod(&d)
		}
		return d
	}
	list := []db.TodoDecisionRow{
		dec("old", "agent", "Branch?", 1, func(d *db.TodoDecisionRow) { d.SupersededBy = "new" }),
		dec("new", "agent", "Branch?", 2, func(d *db.TodoDecisionRow) { d.SupersedesID = "old" }),
		dec("acked", "agent", "Layout?", 3, func(d *db.TodoDecisionRow) { d.SupersededBy = "mine1" }),
		dec("mine1", "manual", "Layout?", 4, func(d *db.TodoDecisionRow) { d.SupersedesID = "acked" }),
		dec("said", "outcome", "Retries?", 5, nil),
		dec("card", "card", " retries? ", 6, nil), // the owner's answer on the same question, after it
		dec("later", "agent", "Font?", 7, nil),
		dec("user", "manual", "Font?", 6, nil), // the owner's, but before it
		dec("hand", "manual", "Port?", 8, nil),
		dec("thread", "thread", "Name?", 8, nil),
		dec("odd", "something-new", "Colour?", 9, nil),                                        // a source nobody knows is a model's
		dec("other", "agent", "Retries?", 1, func(d *db.TodoDecisionRow) { d.TodoID = "t2" }), // another to-do's owner answer does not count
	}
	var got []string
	for _, d := range unackedDecisions(list) {
		got = append(got, d.ID)
	}
	if want := []string{"odd", "later", "new", "other"}; !slices.Equal(got, want) {
		t.Fatalf("unacked = %v, want %v", got, want)
	}
}

func TestUnackedDecisionsRoute(t *testing.T) {
	if mem := newTodoEnv(t, nil); mem.do("GET", "/api/v1/todos/decisions/unacked", "").Code != http.StatusServiceUnavailable {
		t.Fatal("without a database the route answers 503")
	}
	database := todoTestDB(t)
	e := newTodoEnv(t, database)
	create := func(title string) string {
		var res struct{ Todo Todo }
		_ = json.Unmarshal(e.must("POST", "/api/v1/todos", `{"title":"`+title+`"}`).Body.Bytes(), &res)
		return res.Todo.ID
	}
	open, done := create("Fix the widget"), create("Ship the release")
	ctx := context.Background()
	// Distinct times, newest last, given rather than waited for; all before now, so the owner's answers below are later.
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	write := func(n int, id, todo, source, question string) {
		if _, err := database.InsertTodoDecision(ctx, db.TodoDecisionRow{ID: id, TodoID: todo, Question: question, Choice: "A",
			Source: source, CreatedAt: base.Add(time.Duration(n) * time.Second)}); err != nil {
			t.Fatal(err)
		}
	}
	write(1, "dec_a", open, db.DecisionAgent, "Which branch?")
	write(2, "dec_b", open, db.DecisionOutcome, "Where do retries go?")
	write(3, "dec_c", open, db.DecisionManual, "Which port?")
	write(4, "dec_d", done, db.DecisionAgent, "Which icon?")
	e.must("PATCH", "/api/v1/todos/"+done, `{"done":true}`)

	ids := func() []string { return unackedIDs(e) }
	if got := ids(); !slices.Equal(got, []string{"dec_b", "dec_a"}) {
		t.Fatalf("unacked = %v", got)
	}
	// "I agree": the owner's decision superseding the model's takes it off the list
	e.must("POST", "/api/v1/todos/"+open+"/decisions", `{"question":"Which branch?","choice":"A","supersedes_id":"dec_a"}`)
	if got := ids(); !slices.Equal(got, []string{"dec_b"}) {
		t.Fatalf("after I agree = %v", got)
	}
}

// unackedIDs is GET /api/v1/todos/decisions/unacked as the apps read it, the decisions' ids in its order.
func unackedIDs(e *todoEnv) []string {
	e.t.Helper()
	var res struct{ Decisions []db.TodoDecisionRow }
	if err := json.Unmarshal(e.must("GET", "/api/v1/todos/decisions/unacked", "").Body.Bytes(), &res); err != nil {
		e.t.Fatal(err)
	}
	out := []string{}
	for _, d := range res.Decisions {
		out = append(out, d.ID)
	}
	return out
}

// A concern's report (#8535: the reported decisions) through its real lifecycle: the main conversation records the
// concern and reports it (todo_create kind concern, concern_report: db.ReportConcern closes it in the same write), and
// the report waits while it keeps the concern closed. Reopened, it no longer does; the next report is the one that waits.
func TestUnackedDecisionsReportedConcern(t *testing.T) {
	e := newConcernEnv(t)
	ctx := context.Background()
	if _, err := e.tool("todo_create", map[string]any{"title": "Will the release slip", "kind": "concern"}); err != nil {
		t.Fatal(err)
	}
	c := onlyTodo(e.s)
	if got := unackedIDs(e.todoEnv); len(got) != 0 {
		t.Fatalf("an open concern with no report: %v", got)
	}
	report := func(text string) db.TodoDecisionRow {
		t.Helper()
		if _, err := e.tool("concern_report", map[string]any{"id": c.ID, "report": text}); err != nil {
			t.Fatal(err)
		}
		ds, err := e.s.todoDB().ListTodoDecisions(ctx, c.ID, true)
		if err != nil {
			t.Fatal(err)
		}
		last := ds[len(ds)-1]
		if last.Source != db.DecisionReported || last.Choice != text {
			t.Fatalf("the report: %+v", ds)
		}
		return last
	}

	first := report("It will not slip: Thursday as planned")
	if got := e.get(c.ID); got.DoneAt == nil || got.DoneBy != db.DoneByReported {
		t.Fatalf("the report did not close it: %+v", got)
	}
	if got := unackedIDs(e.todoEnv); !slices.Equal(got, []string{first.ID}) {
		t.Fatalf("the reported concern required by #8535 is absent: %v, want %s", got, first.ID)
	}

	// Reopened, the answer was not enough: its report no longer waits, and nothing else of the concern does.
	e.must("PATCH", "/api/v1/todos/"+c.ID, `{"done":false}`)
	if got := unackedIDs(e.todoEnv); len(got) != 0 {
		t.Fatalf("the report of a reopened concern: %v", got)
	}
	second := report("It slips a day: the patch lands Friday")
	if got := unackedIDs(e.todoEnv); !slices.Equal(got, []string{second.ID}) {
		t.Fatalf("after the second report = %v, want only %s", got, second.ID)
	}

	// "I agree" on it, as the web writes it (the same question and choice, superseding it): off the list, and the
	// concern stays closed.
	body, _ := json.Marshal(map[string]string{"question": second.Question, "choice": second.Choice, "supersedes_id": second.ID})
	e.must("POST", "/api/v1/todos/"+c.ID+"/decisions", string(body))
	if got := unackedIDs(e.todoEnv); len(got) != 0 {
		t.Fatalf("after I agree on the report: %v", got)
	}
	if got := e.get(c.ID); got.DoneAt == nil || got.DoneBy != db.DoneByReported {
		t.Fatalf("acknowledging the report reopened the concern: %+v", got)
	}
}

// waitsOn and waitsUntil: which of unackedDecisions a to-do lists, a concern's report included, how long that report
// waits, and the instant the answer says it stops (listed at it, gone just after).
func TestUnackedDecisionsWaitOn(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { at := now.Add(-d); return &at }
	report := db.TodoDecisionRow{ID: "rep", Source: db.DecisionReported}
	agent := db.TodoDecisionRow{ID: "ag", Source: db.DecisionAgent}
	concern := func(done *time.Time, by string) Todo {
		return Todo{Kind: db.KindConcern, DoneAt: done, DoneBy: by}
	}
	until := func(done *time.Time) time.Time { return done.Add(reportedWait) }
	for _, c := range []struct {
		name   string
		t      Todo
		d      db.TodoDecisionRow
		latest string
		want   bool
		until  time.Time // zero: the wait ends only with a change to the to-do
	}{
		{"an open to-do", Todo{}, agent, "", true, time.Time{}},
		{"a closed to-do", Todo{DoneAt: ago(time.Minute)}, agent, "", false, time.Time{}},
		{"a cancelled to-do", Todo{DoneAt: ago(time.Minute), DoneBy: db.DoneByCancelled}, agent, "", false, time.Time{}},
		{"a concern its report just closed", concern(ago(0), db.DoneByReported), report, "rep", true, until(ago(0))},
		{"a concern closed by its report", concern(ago(time.Hour), db.DoneByReported), report, "rep", true, until(ago(time.Hour))},
		{"its report a nanosecond before the cutoff", concern(ago(reportedWait-time.Nanosecond), db.DoneByReported), report, "rep", true, until(ago(reportedWait - time.Nanosecond))},
		{"its report exactly at the cutoff", concern(ago(reportedWait), db.DoneByReported), report, "rep", true, now},
		{"its report a nanosecond past the cutoff", concern(ago(reportedWait+time.Nanosecond), db.DoneByReported), report, "rep", false, now.Add(-time.Nanosecond)},
		{"its report a week and more ago", concern(ago(reportedWait+time.Minute), db.DoneByReported), report, "rep", false, now.Add(-time.Minute)},
		{"an earlier report of it", concern(ago(time.Hour), db.DoneByReported), report, "rep2", false, until(ago(time.Hour))},
		{"a reopened concern's report", concern(nil, ""), report, "rep", false, time.Time{}},
		{"a concern closed by hand, not its report", concern(ago(time.Hour), ""), report, "rep", false, until(ago(time.Hour))},
		{"another decision on a concern", concern(ago(time.Hour), db.DoneByReported), agent, "rep", false, until(ago(time.Hour))},
		{"another decision on an open concern", concern(nil, ""), agent, "", false, time.Time{}},
	} {
		if got := waitsOn(c.t, c.d, c.latest, now); got != c.want {
			t.Errorf("%s: waits %v, want %v", c.name, got, c.want)
		}
		if got := waitsUntil(c.t); !got.Equal(c.until) {
			t.Errorf("%s: waits until %v, want %v", c.name, got, c.until)
		}
	}
}

// unackedList is GET /api/v1/todos/decisions/unacked as the apps read it, waits_until included.
func unackedList(e *todoEnv) []unackedDecision {
	e.t.Helper()
	var res struct{ Decisions []unackedDecision }
	if err := json.Unmarshal(e.must("GET", "/api/v1/todos/decisions/unacked", "").Body.Bytes(), &res); err != nil {
		e.t.Fatal(err)
	}
	return res.Decisions
}

// #8557 review: a reported concern leaves the list when its seven days run out, with nothing written to the to-do,
// and the answer says when beforehand (waits_until) so an open Overview can drop it on time. The route's clock is moved
// (Service.unackedNow), never waited for; two concerns reported one after the other expire in that order, while an open
// to-do's call (no waits_until) stays throughout.
func TestUnackedDecisionsReportedConcernExpires(t *testing.T) {
	e := newConcernEnv(t)
	ctx := context.Background()
	clock := time.Now()
	e.s.unackedNow = func() time.Time { return clock }
	concern := func(title, text string) (*Todo, string) {
		t.Helper()
		before := map[string]bool{}
		for _, td := range e.list() {
			before[td.ID] = true
		}
		if _, err := e.tool("todo_create", map[string]any{"title": title, "kind": "concern"}); err != nil {
			t.Fatal(err)
		}
		var id string
		for _, td := range e.list() {
			if !before[td.ID] {
				id = td.ID
			}
		}
		if _, err := e.tool("concern_report", map[string]any{"id": id, "report": text}); err != nil {
			t.Fatal(err)
		}
		ds, err := e.s.todoDB().ListTodoDecisions(ctx, id, true)
		if err != nil {
			t.Fatal(err)
		}
		got := e.get(id)
		if got == nil || got.DoneAt == nil || got.DoneBy != db.DoneByReported {
			t.Fatalf("the report did not close %s: %+v", id, got)
		}
		return got, ds[len(ds)-1].ID
	}
	open := e.create("Fix the widget")
	first, firstRep := concern("Will the release slip", "It will not slip")
	second, secondRep := concern("Is the backup covered", "Yes, nightly")
	if !second.DoneAt.After(*first.DoneAt) {
		t.Fatalf("the reports closed at %v and %v: the second is not later", first.DoneAt, second.DoneAt)
	}
	if _, err := e.s.todoDB().InsertTodoDecision(ctx, db.TodoDecisionRow{ID: "dec_open", TodoID: open.ID, Question: "Which branch?",
		Choice: "A", Source: db.DecisionAgent, CreatedAt: first.DoneAt.Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	firstEnd, secondEnd := first.DoneAt.Add(reportedWait), second.DoneAt.Add(reportedWait)
	stamps := func() map[string]time.Time {
		out := map[string]time.Time{}
		for _, id := range []string{first.ID, second.ID, open.ID} {
			out[id] = e.get(id).UpdatedAt
		}
		return out
	}
	unchanged := stamps()

	for _, step := range []struct {
		name string
		at   time.Time
		want []string // ids, newest first
	}{
		{"just reported", second.DoneAt.Add(time.Minute), []string{secondRep, firstRep, "dec_open"}},
		{"a day on", second.DoneAt.Add(24 * time.Hour), []string{secondRep, firstRep, "dec_open"}},
		{"a nanosecond before the first's cutoff", firstEnd.Add(-time.Nanosecond), []string{secondRep, firstRep, "dec_open"}},
		{"exactly at the first's cutoff", firstEnd, []string{secondRep, firstRep, "dec_open"}},
		{"a nanosecond past the first's cutoff", firstEnd.Add(time.Nanosecond), []string{secondRep, "dec_open"}},
		{"exactly at the second's cutoff", secondEnd, []string{secondRep, "dec_open"}},
		{"a nanosecond past the second's cutoff", secondEnd.Add(time.Nanosecond), []string{"dec_open"}},
		{"a month on", secondEnd.Add(30 * 24 * time.Hour), []string{"dec_open"}},
	} {
		clock = step.at
		var ids []string
		for _, d := range unackedList(e.todoEnv) {
			ids = append(ids, d.ID)
			var want *time.Time
			switch d.ID {
			case firstRep:
				want = &firstEnd
			case secondRep:
				want = &secondEnd
			}
			if (d.WaitsUntil == nil) != (want == nil) || want != nil && !d.WaitsUntil.Equal(*want) {
				t.Errorf("%s: %s waits until %v, want %v", step.name, d.ID, d.WaitsUntil, want)
			}
		}
		if !slices.Equal(ids, step.want) {
			t.Errorf("%s: listed %v, want %v", step.name, ids, step.want)
		}
	}
	// the to-dos were never touched: only the clock moved
	if now := stamps(); !maps.EqualFunc(now, unchanged, time.Time.Equal) {
		t.Fatalf("a to-do changed: %v, was %v", now, unchanged)
	}
}
