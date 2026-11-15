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
	write := func(id, todo, source, question string) {
		if _, err := database.InsertTodoDecision(ctx, db.TodoDecisionRow{ID: id, TodoID: todo, Question: question, Choice: "A",
			Source: source, CreatedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(2 * time.Millisecond) // distinct times, newest last
	}
	write("dec_a", open, db.DecisionAgent, "Which branch?")
	write("dec_b", open, db.DecisionOutcome, "Where do retries go?")
	write("dec_c", open, db.DecisionManual, "Which port?")
	write("dec_d", done, db.DecisionAgent, "Which icon?")
	e.must("PATCH", "/api/v1/todos/"+done, `{"done":true}`)

	ids := func() []string {
		var res struct{ Decisions []db.TodoDecisionRow }
		_ = json.Unmarshal(e.must("GET", "/api/v1/todos/decisions/unacked", "").Body.Bytes(), &res)
		var out []string
		for _, d := range res.Decisions {
			out = append(out, d.ID)
		}
		return out
	}
	if got := ids(); !slices.Equal(got, []string{"dec_b", "dec_a"}) {
		t.Fatalf("unacked = %v", got)
	}
	// "I agree": the owner's decision superseding the model's takes it off the list
	e.must("POST", "/api/v1/todos/"+open+"/decisions", `{"question":"Which branch?","choice":"A","supersedes_id":"dec_a"}`)
	if got := ids(); !slices.Equal(got, []string{"dec_b"}) {
		t.Fatalf("after I agree = %v", got)
	}
}
