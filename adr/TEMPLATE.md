# ADR-XXXX — [Decision Title]

| | |
|---|---|
| **Status** | Proposed |
| **Date** | YYYY-MM-DD |
| **Author** | [Your name] |
| **Pends on** | [Any blockers, e.g., "second code owner ratification"] |

## Context

[Briefly: what situation prompted this decision? What problem are we solving?
Keep it to 2–3 sentences. Link to issues or previous ADRs if relevant.]

## Decision

[The decision itself. One sentence if possible. E.g., "We will use PostgreSQL for
the audit log." Not a story about how we got here, just what we decided.]

## Rationale

[Why this over alternatives? Keep it concise.]

| Option | Pros | Cons |
|--------|------|------|
| A | | |
| B | | |
| C (chosen) | | |

Or prose:

We chose PostgreSQL because:
- Schema flexibility (JSON columns for unstructured audit metadata)
- ACID guarantees (audit log must never be lost or corrupted)
- Team expertise (existing Postgres clusters in production)

SQLite was rejected because we need multi-writer concurrency.
DynamoDB was rejected because licensing and operational complexity.

## Consequences

[What does this decision require us to do? What does it enable or forbid?]

- ✅ Enables: [outcome 1]
- ⚠️ Requires: [action 1]
- ❌ Forbids: [constraint 1]

## Alternatives Considered

[If needed, expand on alternatives. If the main section was complete, you can
delete this section.]

## Revision Triggers

[When should we revisit this decision? E.g., "If audit log grows beyond 10TB,
we revisit sharding strategy."]

## Amendments

*None.*

[If this ADR is amended, list amendments here:
- ADR-XXXX Amendment 1 — [title]
- ADR-XXXX Amendment 2 — [title]
]

## See Also

[Links to related decisions, design docs, or issues.]

---

## Drafting Notes

- **Delete this section** before submitting the ADR
- One decision per ADR; if it feels like two decisions, write two ADRs
- Prose is minimal; use tables for alternatives and consequences
- Naming matters: "Use PostgreSQL for audit log" not "Database discussion"
- Keep it under one page if possible
- If you need to explain background, link to a design doc instead
