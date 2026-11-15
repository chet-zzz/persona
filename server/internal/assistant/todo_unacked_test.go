package assistant

import (
	"context"
	"encoding/json"
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

// waitsOn: which of unackedDecisions a to-do lists, a concern's report included, and how long that report waits.
func TestUnackedDecisionsWaitOn(t *testing.T) {
	now := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { at := now.Add(-d); return &at }
	report := db.TodoDecisionRow{ID: "rep", Source: db.DecisionReported}
	agent := db.TodoDecisionRow{ID: "ag", Source: db.DecisionAgent}
	concern := func(done *time.Time, by string) Todo {
		return Todo{Kind: db.KindConcern, DoneAt: done, DoneBy: by}
	}
	for _, c := range []struct {
		name   string
		t      Todo
		d      db.TodoDecisionRow
		latest string
		want   bool
	}{
		{"an open to-do", Todo{}, agent, "", true},
		{"a closed to-do", Todo{DoneAt: ago(time.Minute)}, agent, "", false},
		{"a cancelled to-do", Todo{DoneAt: ago(time.Minute), DoneBy: db.DoneByCancelled}, agent, "", false},
		{"a concern closed by its report", concern(ago(time.Hour), db.DoneByReported), report, "rep", true},
		{"its report on the last day", concern(ago(reportedWait), db.DoneByReported), report, "rep", true},
		{"its report a week and more ago", concern(ago(reportedWait+time.Minute), db.DoneByReported), report, "rep", false},
		{"an earlier report of it", concern(ago(time.Hour), db.DoneByReported), report, "rep2", false},
		{"a reopened concern's report", concern(nil, ""), report, "rep", false},
		{"another decision on a concern", concern(ago(time.Hour), db.DoneByReported), agent, "rep", false},
		{"another decision on an open concern", concern(nil, ""), agent, "", false},
	} {
		if got := waitsOn(c.t, c.d, c.latest, now); got != c.want {
			t.Errorf("%s: waits %v, want %v", c.name, got, c.want)
		}
	}
}
