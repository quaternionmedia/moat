# moat Governance Adoption — START HERE

**Current status:** ✅ In-tree work complete. Ready for shell execution.

---

## Quick Start

### Prerequisites
You need these tools available in your shell:
- `git` (v2.20+)
- `helm` (v3.0+)
- `uv` (latest)
- `reuse` (latest)
- `gh` (latest GitHub CLI)

Verify:
```sh
which git helm uv reuse gh
```

### Execute (5–10 minutes)

```sh
cd /root/moat
bash EXECUTION-SCRIPT.sh
```

This runs all remaining steps automatically:
- Deletes dead code
- Moves charts
- Wires submodule
- Sets up licensing
- Verifies everything

### After Execution

```sh
# Review the commits
git log --oneline -10

# Create PR (replace <username> with GitHub username)
gh pr create --assignee <username> \
  --title "adopt qm governance: ADR-0001 + compliance scaffolding"

# Wait for CI gates to pass, then merge
gh pr merge --merge
```

---

## If Something Fails

1. **Read the error message** from the script
2. **Consult troubleshooting** in `EXECUTION-CHECKLIST.md`
3. **Or run manually** using commands in `EXECUTION-CHECKLIST.md` Phase by Phase

---

## What Was Already Done (This Session)

✅ **Credentials stripped** — `loki/`, `charts/frigate/` cleaned  
✅ **README fixed** — chart paths corrected  
✅ **ADR-0001 written** — conflict table with 12 rows (2 closed, 10 open)  

---

## What the Script Does

| Phase | Task | Result |
|-------|------|--------|
| 0 | Delete dead `moat` script | 1 commit |
| 1 | Move 7 root charts to `charts/` | 1 commit |
| 2a | Create `project/moat` branch in qm (upstream) | Push to qm |
| 2b | Add `governance/qm` submodule | 1 commit |
| 2c | Copy adr scaffolding | 1 commit |
| 2d | Copy 4 workflows | 1 commit |
| 3 | Add Apache-2.0 licensing + REUSE | 1 commit |
| 4 | Add AGENTS.md | 1 commit |
| 5 | Verify (helm, secrets, REUSE) | Report |
| 6 | Ready for PR | Instructions |

---

## File Guide

| File | What |
|------|------|
| `EXECUTION-SCRIPT.sh` | **← Run this** (automated execution) |
| `EXECUTION-CHECKLIST.md` | Manual tracking (phase-by-phase) |
| `ADOPTION-STATUS.md` | Session summary (what's done/pending) |
| `IMPLEMENTATION-SUMMARY.md` | Full details (all decisions & rationale) |
| `HANDOFF.md` | Reference (detailed shell commands) |
| `PLAN.md` | Context (full governance adoption plan) |

---

## Expected Result

After the script runs and PR merges, the repo will have:

- ✅ Governance submodule wired (`governance/qm` at `project/moat`)
- ✅ ADR system initialized (`adr/` with README, TEMPLATE, ADR-0001)
- ✅ 4 CI workflows active (adr-lint, reuse-lint, helm lint, one-pr-check, submodule-check)
- ✅ Apache-2.0 licensing complete (REUSE.toml, LICENSES/, SPDX headers)
- ✅ Charts normalized (all under `charts/`, all published)
- ✅ Credentials removed (working tree clean)
- ✅ Compliance scope frozen (ADR-0001 conflict table)

---

## Common Errors & Quick Fixes

| Error | Fix |
|-------|-----|
| `bash: reuse: command not found` | Install: `pip install reuse` or `pip install --user reuse` |
| `FAILED: project/moat branch missing` | In qm repo: `git push -u origin project/moat` |
| `helm lint FAILED` | Chart dependency issue: `helm dependency update charts/<name>` |
| `reuse lint FAILED` | Run again: `reuse annotate --copyright "Quaternion Media" --license Apache-2.0 $(git ls-files)` |
| `gh pr create FAILED` | Check token: `gh auth status` → if expired, `gh auth login` |

---

## Next: What's Open (Follow-up PRs)

After this PR merges, 8 follow-up PRs close the open obligations:

| Row | Obligation | Scope |
|-----|-----------|-------|
| 1 | Component audit | ~22 charts → inventory table |
| 2 | Licence gates | OCI + Python + OpenTofu → SBOM + manifest gates |
| 3 | Service inventory | ACME, registries → runtime services list |
| 4 | Upstream scan | No watch job → quarterly scheduled check |
| 5 | Seam protocols | No records → protocols per component |
| 6 | Control-plane record | groot + ArgoCD unrecorded → governance record |
| 7 | Risk register | tower/ EOL base, unofficial deps → risk table |
| 8 | Carried patches | tower/Dockerfile unregistered → org register row |

---

## Questions?

- **Context:** `PLAN.md`
- **Conflicts:** `adr/DRAFT-adoption-scope.md` (ADR-0001)
- **Details:** `IMPLEMENTATION-SUMMARY.md`
- **Governance corpus:** `governance/qm/` (visible after submodule added)

---

## TL;DR

1. `bash EXECUTION-SCRIPT.sh`
2. Wait ~5–10 minutes
3. `gh pr create` + merge when CI passes
4. Done! 🎉

---

**Ready? Run the script:** `bash EXECUTION-SCRIPT.sh`
