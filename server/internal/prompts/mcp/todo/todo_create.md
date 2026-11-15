Add a to-do to the user's Persona to-dos, when the user asks you to note something to do or to remind them of it (or agrees to your suggestion): it shows on the To-dos page of the app. It is the user's own to-do, with no agent on it: work for an agent is task_plan. Done at once, nothing to confirm. An open to-do with the same title and due date is not made twice: you get that one back. Dates are in the user's time zone. With kind concern it records a concern of the user's instead: open until you report its outcome with concern_report. In a leader conversation it records a piece of your direction's work instead: it shows under your direction as not started, you supervise it, and to have an agent do it you use task_plan with its todo_id (no second to-do); finish one done without an agent with todo_complete. With part_of it records a piece of a request split into several to-dos, to hand out when its turn comes the same way (task_plan with its todo_id).

```json
{
  "type": "object",
  "required": ["title"],
  "properties": {
    "title": {
      "type": "string",
      "description": "what is to be done, in a line, in the user's language"
    },
    "notes": {
      "type": "string",
      "description": "details: where it came from, links, amounts, what to bring"
    },
    "due": {
      "type": "string",
      "description": "when it is due: a day (2026-11-15) when only the day is known, else a moment (2026-11-15 18:00, or RFC 3339 with its offset); 2h / 3d from now also work"
    },
    "remind": {
      "type": "string",
      "description": "when to push the phone about it: a moment (2026-11-14 09:00, or RFC 3339), or 30m / 2h / 1d from now; not in the past. Leave it out unless the user asked for a reminder or the deadline is close and matters"
    },
    "priority": {
      "type": "string",
      "enum": ["high", "normal", "low"],
      "description": "normal when left out"
    },
    "kind": {
      "type": "string",
      "enum": ["todo", "concern"],
      "description": "concern (main conversation only): something the user raised and wants answered; only concern_report closes it. todo: the default"
    },
    "project": {
      "type": "string",
      "description": "the knowledge-base project it belongs to (the To-dos page groups by it): the slug or name of an existing project, usually a long-term one for an area of the user's work (kb_list projects). Set it when the area is clear; never make up a near-duplicate"
    },
    "part_of": {
      "type": "string",
      "description": "for a piece of a request split into several to-dos: the id of the to-do that stands for the request"
    },
    "after": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "with part_of: the ids of that request's pieces it waits for"
    }
  }
}
```
