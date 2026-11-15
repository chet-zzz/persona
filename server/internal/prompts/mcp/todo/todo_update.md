Change one of the user's Persona to-dos: its title, notes, due date, reminder, priority, project or place in a request (part_of, after). Only what you give changes; "" or [] clears a field. A new reminder time is pushed again. Done at once, nothing to confirm, also for a task's to-do. To mark it done or open it again use todo_complete / todo_reopen.

```json
{
  "type": "object",
  "required": ["id"],
  "properties": {
    "id": {
      "type": "string",
      "description": "the to-do's id (todo_…)"
    },
    "title": {
      "type": "string",
      "description": "the new title"
    },
    "notes": {
      "type": "string",
      "description": "the new notes (they replace the old ones: keep what should stay)"
    },
    "due": {
      "type": "string",
      "description": "the new due date: a day (2026-11-15) or a moment (2026-11-15 18:00 in the user's time zone, RFC 3339)"
    },
    "remind": {
      "type": "string",
      "description": "the new reminder: a moment (2026-11-14 09:00, RFC 3339) or 30m / 2h / 1d from now, not in the past"
    },
    "priority": {
      "type": "string",
      "enum": ["high", "normal", "low"]
    },
    "project": {
      "type": "string",
      "description": "its knowledge-base project: an existing one's slug or name (kb_list projects), never a near-duplicate"
    },
    "part_of": {
      "type": "string",
      "description": "the request's to-do this one is a piece of; changing it clears after"
    },
    "after": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "that request's pieces it waits for (replacing the old ones)"
    }
  }
}
```
