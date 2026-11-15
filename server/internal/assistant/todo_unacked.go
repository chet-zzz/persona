package assistant

import (
	"net/http"
	"sort"
	"strings"

	"github.com/nwverse/persona/server/internal/apierr"
	"github.com/nwverse/persona/server/internal/db"
)

// Decided for you, not acknowledged (docs/assistant/todos.md "Decisions made for you"). On a to-do, an Agent or the
// assistant records calls the owner never made (todo_decision_add, an outcome taken from a reply, a concern's reported
// outcome). Until the owner takes one as theirs, it is waiting for them: the Overview lists those across the open
// to-dos, with "I agree" (the owner's decision with the same question and choice, superseding it) and "No, change it"
// (their own choice, superseding it). Which decisions wait is decided here, once, so every client shows the same list.

// unackedLimit bounds the answer: the newest calls are the ones that can still change the work.
const unackedLimit = 200

// ownersDecision: a source that is the owner's own call (written by hand, an answer to an Agent's question card, said
// in the to-do's chat thread). Any other source, one this hub does not know included, is a model's: what nobody can
// show the owner made is theirs to acknowledge, not taken as theirs.
func ownersDecision(source string) bool {
	switch source {
	case db.DecisionManual, db.DecisionCard, db.DecisionThread:
		return true
	}
	return false
}

// sameQuestion: two decisions answer the same question, spaces and case aside.
func sameQuestion(a, b string) bool {
	norm := func(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }
	return norm(a) != "" && norm(a) == norm(b)
}

// unackedDecisions are the model's decisions in all (one or more to-dos' decisions, superseded ones included) that
// wait for the owner, newest first: in effect (nothing replaced them; a model's decision another model's decision
// replaced gives way to that one) and no decision of the owner's on the same to-do, written at or after it, answers the
// same question.
func unackedDecisions(all []db.TodoDecisionRow) []db.TodoDecisionRow {
	mine := map[string][]db.TodoDecisionRow{}
	for _, d := range all {
		if ownersDecision(d.Source) {
			mine[d.TodoID] = append(mine[d.TodoID], d)
		}
	}
	out := []db.TodoDecisionRow{}
	for _, d := range all {
		if ownersDecision(d.Source) || d.SupersededBy != "" {
			continue
		}
		answered := false
		for _, m := range mine[d.TodoID] {
			if !m.CreatedAt.Before(d.CreatedAt) && sameQuestion(m.Question, d.Question) {
				answered = true
				break
			}
		}
		if !answered {
			out = append(out, d)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID > out[j].ID
	})
	return out
}

func (s *Service) todoUnackedRoutes() {
	// GET /api/v1/todos/decisions/unacked: the model's decisions on open to-dos the owner has not acknowledged, newest
	// first, at most unackedLimit → {"decisions": [Decision]}. A concern's or a cancelled to-do's are left out: nothing
	// is left to change there.
	s.handle("GET /api/v1/todos/decisions/unacked", func(w http.ResponseWriter, r *http.Request) {
		st := s.todoDB()
		if st == nil {
			apierr.Write(w, http.StatusServiceUnavailable, errNoDecisionStore)
			return
		}
		if err := s.ensureTodosLoaded(r.Context()); err != nil {
			apierr.Write(w, http.StatusServiceUnavailable, errTodosUnavailable)
			return
		}
		all, err := st.OpenTodoDecisions(r.Context())
		if err != nil {
			apierr.Write(w, http.StatusInternalServerError, err)
			return
		}
		out := []db.TodoDecisionRow{}
		for _, d := range unackedDecisions(all) {
			t, ok := s.todoNow(d.TodoID)
			if !ok || t.DoneAt != nil || t.Cancelled() || t.isConcern() {
				continue
			}
			if out = append(out, d); len(out) == unackedLimit {
				break
			}
		}
		apierr.WriteJSON(w, map[string]any{"decisions": out})
	})
}
