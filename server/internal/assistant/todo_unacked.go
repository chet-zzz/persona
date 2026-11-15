package assistant

import (
	"net/http"
	"sort"
	"strings"
	"time"

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

// reportedWait is how long a concern's report waits after the report closed it: what the owner was told in the chat is
// worth taking as theirs while it is fresh, and the concerns reported before this list existed do not all come back.
const reportedWait = 7 * 24 * time.Hour

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

// waitsOn: decision d of t, one of unackedDecisions, is listed. On a to-do or a task, while it is open and not
// cancelled (closed, nothing is left to change). On a concern, only its report, and only while that report keeps it
// closed: latest is the concern's newest report, and now is not past waitsUntil. An open concern's earlier report is
// not listed: reopening it said the answer was not enough, and the next report is what will wait.
func waitsOn(t Todo, d db.TodoDecisionRow, latest string, now time.Time) bool {
	if !t.isConcern() {
		return t.DoneAt == nil && !t.Cancelled()
	}
	until := waitsUntil(t)
	return d.Source == db.DecisionReported && d.ID == latest && t.DoneBy == db.DoneByReported && !until.IsZero() &&
		!now.After(until)
}

// waitsUntil is when t's listed decision stops waiting with nothing written: a closed concern's report, reportedWait
// after the report closed it (listed up to and at that instant). Zero when only a change to t ends the wait (an open
// to-do's calls). The answer carries it so an open Overview drops the row on time without the to-do changing.
func waitsUntil(t Todo) time.Time {
	if !t.isConcern() || t.DoneAt == nil {
		return time.Time{}
	}
	return t.DoneAt.Add(reportedWait)
}

// unackedDecision is one listed decision as the route answers it: the decision, and waits_until when it stops
// waiting on its own (waitsUntil).
type unackedDecision struct {
	db.TodoDecisionRow
	WaitsUntil *time.Time `json:"waits_until,omitempty"`
}

func (s *Service) todoUnackedRoutes() {
	// GET /api/v1/todos/decisions/unacked: the model's decisions the owner has not acknowledged, newest first, at most
	// unackedLimit → {"decisions": [Decision + waits_until]}: on the open to-dos, and the report of each concern it closed
	// (waitsOn), that one with waits_until (waitsUntil).
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
		now := time.Now()
		if s.unackedNow != nil {
			now = s.unackedNow()
		}
		all, err := st.OpenTodoDecisions(r.Context(), now.Add(-reportedWait))
		if err != nil {
			apierr.Write(w, http.StatusInternalServerError, err)
			return
		}
		latest := map[string]string{} // each concern's newest report (all is oldest first)
		for _, d := range all {
			if d.Source == db.DecisionReported {
				latest[d.TodoID] = d.ID
			}
		}
		out := []unackedDecision{}
		for _, d := range unackedDecisions(all) {
			t, ok := s.todoNow(d.TodoID)
			if !ok || !waitsOn(t, d, latest[d.TodoID], now) {
				continue
			}
			item := unackedDecision{TodoDecisionRow: d}
			if until := waitsUntil(t); !until.IsZero() {
				item.WaitsUntil = &until
			}
			if out = append(out, item); len(out) == unackedLimit {
				break
			}
		}
		apierr.WriteJSON(w, map[string]any{"decisions": out})
	})
}
