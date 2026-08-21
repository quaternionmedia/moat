# moat Project Agents

This project adopts the governance corpus at `governance/qm/`. For the agent
model and decision authority framework, see:

- **governance/qm/AGENTS.md** — the operative agent definition for this project

## What is an Agent?

Per the governance corpus, an agent is any entity (person, team, service account)
that can merge a pull request or vote on a record. The corpus defines:

1. **Agent model:** How decisions are made, who can vote, quorum rules
2. **Authority levels:** What each role can decide
3. **Veto scope:** What no single agent can decide alone

## moat's Agent Model

moat uses the agent model defined in `governance/qm/AGENTS.md`. After this repo
adopts the corpus (submodule at `governance/qm`), that file is the source of
truth for:

- Who can merge PRs in this repo
- What records require ratification
- How many code owners must sign off on a record

## Project-Specific Notes

### Adoption

moat adopted the QM governance corpus per **ADR-0001** (`adr/DRAFT-adoption-scope.md`).
This is a `Proposed` record that will bind once a second active code owner ratifies it.

### Records

All records in this project are drafted by contributors and ratified only by
active code owners. See `adr/` for the full record set.

### Submodule & Branch

The governance corpus is pinned at `governance/qm` on branch `project/moat`.
That branch contains moat-specific adoptions of the governance seed:
- `adr/` copied from `project-seed/adr/`
- CI workflows from `project-seed/workflows/`
- IDE discovery from `project-seed/ide/`

To update the corpus submodule:
```sh
cd governance/qm
git fetch origin project/moat
git checkout project/moat
git pull origin project/moat
cd ..
git add governance/qm
git commit -m "update governance submodule to latest project/moat"
```

## Decisions & Records

Every decision that affects the project lives in `adr/` as a numbered record.
Records follow the ADR (Architecture Decision Record) template and go through
these states:

| State | Meaning |
|-------|---------|
| **Proposed** | Drafted by contributor, waiting for ratification |
| **Ratified** | Signed off by a second active code owner; now binding |
| **Amended** | A ratified record with a new amendment; re-ratified |
| **Superseded** | A newer record replaces this one |

See `adr/README.md` for the full record discipline.

## How to Propose a Change

1. Create a branch: `git checkout -b feat/my-decision`
2. Draft or amend a record in `adr/DRAFT-*.md` (numberless, proposed state)
3. Commit and push: `git push -u origin feat/my-decision`
4. Open PR: Assign to the requester, request no reviewer
5. Merge once gates are green: You merge it (no external approval step)
6. Record stays `Proposed` until a second active code owner ratifies it

Per the corpus adoption contract: "one open PR per repo per contributor."

## Second Ratifier

Records drafted by an agent stay `Proposed` until a second **active code owner**
ratifies them. An active code owner is:

- Listed in `governance/qm/AGENTS.md`
- Not the original drafter
- A person (not a service account)

Once ratified, the record binds the project and becomes immutable (amendments
are new records).

## For Maintainers

If you're an active code owner:

1. **Review drafts** in PRs targeting this repo
2. **Ratify records** by commenting `@adr-bot ratify` or running:
   ```sh
   python governance/qm/ci/ratify.py adr/DRAFT-*.md
   ```
3. **Amend ratified records** only via a new amendment record (not in-place edits)

See `governance/qm/handbook/` for full governance procedures.

---

**See also:**
- `governance/qm/AGENTS.md` — full agent model (via submodule)
- `governance/qm/PRINCIPLES.md` — the 12 binding principles
- `adr/` — all project records
- `governance/qm/handbook/` — procedures and workflows
