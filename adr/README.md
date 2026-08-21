# moat Architecture Decision Records (ADRs)

## What is an ADR?

An Architecture Decision Record (ADR) is a document that captures an important
architectural, policy, or governance decision made by the project. Each ADR:

- Has a number (ADR-0001, ADR-0002, …)
- Follows a standard template (see `TEMPLATE.md`)
- Goes through states: `Proposed` → `Ratified` → `Superseded` (or amended)
- Is immutable once ratified (changes come via amendments, which are new records)

ADRs are not design documents or long prose. Each ADR has one decision and names
the date, status, and ratifier.

## Directory

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-0001](./DRAFT-adoption-scope.md) | Adopt QM governance and freeze scope per open conflict | Proposed |

## Process

### Drafting

1. Create a file: `adr/DRAFT-<short-title>.md`
   - Numberless while drafted (renamed to `adr/ADR-NNNN-*.md` when ratified)
   - Status: `Proposed`
   - Date: today

2. Follow the template: `adr/TEMPLATE.md`
   - One decision per ADR
   - Name the decision, not a story
   - Prose is minimal; use a table if needed

3. Commit and push to a PR branch
   ```sh
   git checkout -b feat/my-adr
   git add adr/DRAFT-my-decision.md
   git commit -m "adr: propose my decision (draft)"
   git push -u origin feat/my-adr
   ```

4. Open a PR: assign to the requester, request no reviewer
   - Merge once CI gates pass (no blocking approval)

### Ratification

After a PR merges, the draft record is live but still `Proposed`. A second
**active code owner** must ratify it.

To ratify (as a code owner):

```sh
# Rename the draft to assign it a number
git mv adr/DRAFT-my-decision.md adr/ADR-NNNN-my-decision.md

# Edit the header: change Status to Ratified, add Ratified-by
git add adr/ADR-NNNN-my-decision.md
git commit -m "adr: ratify ADR-NNNN (my decision)"
git push
```

Or use the CI tool (if available):
```sh
python governance/qm/ci/ratify.py adr/DRAFT-my-decision.md
```

### Amending

Ratified records are immutable. To change a ratified record, create an amendment:

```sh
# Create a new draft for the amendment
cat > adr/DRAFT-my-decision-amendment.md << 'EOF'
# ADR-NNNN Amendment — Title

| | |
|---|---|
| **Type** | Amendment |
| **Amends** | ADR-NNNN |
| **Status** | Proposed |
| **Date** | YYYY-MM-DD |

## Context

[Why the change?]

## Decision

[What changes?]

## Consequences

[What's the impact?]
EOF

git add adr/DRAFT-my-decision-amendment.md
git commit -m "adr: propose amendment to ADR-NNNN"
git push -u origin feat/adr-amendment
```

Follow the same ratification process. The amendment gets its own number.

### Superseding

To replace a record entirely (not just amend):

```sh
# Create a new ADR that explicitly supersedes the old one
# Add to the new ADR header:
# | **Supersedes** | ADR-NNNN |

# After ratification, mark the old one:
# | **Status** | Superseded |
# | **By** | ADR-MMMM |
```

## States

| State | What it means | Who decides | Next step |
|-------|---------------|-----------|-----------|
| **Proposed** | Drafted; merged but not yet binding | Drafter → Second code owner | Ratify or reject |
| **Ratified** | Binding on the project | Second code owner | (immutable; amend if needed) |
| **Amended** | Ratified record with a new amendment | (amendment becomes new record) | (immutable; supersede if needed) |
| **Superseded** | Replaced by a newer record | Drafter of newer record | (historic reference only) |

## Rules

1. **One decision per ADR.** If you're deciding two separate things, write two ADRs.

2. **Proposed records are drafts.** Don't treat a merged Proposed record as final;
   it's live but bindingness waits for ratification.

3. **Ratified records don't change.** Edit them and you're changing what was
   ratified. Amendments and supersessions are how you evolve.

4. **Ratification requires a second person.** The person who wrote it can't
   ratify it. This forces clarity: if only the author understands the decision,
   it's not ready.

5. **Prose is minimal.** An ADR is a decision artifact, not a design document.
   If the explanation is longer than the decision itself, move it to a separate
   design doc in the repo and link to it.

6. **Name decisions, not stories.** ✅ "Use PostgreSQL for the audit log."
   ❌ "We had a meeting where we talked about the audit log and someone said
   we should consider databases…"

7. **Table format for lists.** Multiple alternatives or consequences?
   Use a table, not prose.

## Naming

- **Drafts:** `DRAFT-<kebab-case-title>.md` (numberless)
- **Ratified:** `ADR-NNNN-<kebab-case-title>.md`
- **Amended:** `ADR-MMMM-<kebab-case-title>-amendment.md` (new record)
- **Superseded:** Keep the old name; mark status as `Superseded`

## Linking

Link to other ADRs:

```markdown
This supersedes [ADR-0001](./ADR-0001-my-decision.md).
See also [ADR-0002](./ADR-0002-related-decision.md).
```

## Tools

- `governance/qm/ci/adr-lint.py` — syntax checking (runs in CI)
- `governance/qm/ci/ratify.py` — assist with ratification
- `governance/qm/ci/run_workflows_locally.py` — run gates locally

## Examples

See the records in this directory for real examples. Start with ADR-0001.

## For Adopting Projects

If your project adopts QM governance:
1. Copy this file verbatim
2. Copy `TEMPLATE.md` verbatim
3. Create your first ADR: `DRAFT-adoption-scope.md` (the adoption conflict table)
4. Proceed as above

See `governance/qm/handbook/forking-a-project.md` for the full adoption procedure.
