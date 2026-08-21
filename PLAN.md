# moat → qm governance compliance plan

## Context

`moat` (`git@github.com:quaternionmedia/moat.git`, branch `main`) is Quaternion
Media's homelab IaC repo: ~24 Helm charts (22 wrapping third-party upstreams,
plus `groot` and `technitium` which are template-only), OpenTofu/Proxmox/Talos
infra under `tofu/`, a stub FastAPI app in `tower/`, and one GitHub Actions
workflow that publishes charts.

The QM governance corpus lives at `github.com/quaternionmedia/qm`. It defines a
constitution (`AGENTS.md`), a charter of 12 principles (`PRINCIPLES.md`), binding
records in `records/`, a fork/adoption procedure (`handbook/forking-a-project.md`),
an eight-obligation contract every adopting project must satisfy
(`project-seed/adr/README.md`), a branch-namespace model, and ~13 CI gates.

**Goal:** review moat against that corpus and bring it into compliance.

## How QM compliance works (from the corpus)

A downstream repo adopts governance by:
1. Adding qm as a submodule at `governance/qm`.
2. Cutting a `project/moat` branch in qm, copying `project-seed/adr/` → `adr/`.
3. Pinning the submodule to that branch; `.gitmodules` gets `branch = project/moat`.
4. Copying 4 workflows verbatim: `adr-lint.yml`, `submodule-check.yml`,
   `reuse-lint.yml`, `one-pr-check.yml`.
5. Copying `project-seed/ide/` (preserving symlinks).
6. Seeding project records as numberless `DRAFT-*` drafts. **ADR-0001 is
   conventionally adoption + scope. Because moat predates adoption, ADR-0001's
   substance is a conflict table** — every known conflict with an org record,
   what it violates, and what compliance would look like. *Enumerating a conflict
   is not waiving it; scope is frozen per conflict while it stays open.*
7. Registering any carried patches in the org register.

Key rule (`README.md` invariants): every record is `Proposed` until a second
active code owner ratifies; agents **draft, never ratify**. Every change is a PR
you assign to the requester, request no reviewer, and merge yourself once gates
are green. One open PR per repo per contributor.

### The eight obligations (`project-seed/adr/README.md`)

| # | Obligation | moat exposure |
|---|---|---|
| 1 | Baseline component audit (table of every runtime component + licence + disposition) | HIGH — ~22 upstream charts; inventory already collected below |
| 2 | Licence gates, cumulatively (SBOM gate per image **and** dep-manifest gate per ecosystem) | HIGH — container images + `tower/` Python image + OpenTofu providers = multiple runtime shapes |
| 3 | Service inventory (third-party *services* in a runtime path + ownability test each) | MED — mostly self-hosted (ownable); ACME/Let's Encrypt, upstream Helm/OCI registries |
| 4 | Quarterly upstream scan (scheduled job watching pinned upstreams) | MISSING — none exists |
| 5 | Seam protocol named (each component record names protocol + replaceability) | MISSING — no records at all |
| 6 | Control-plane instance record (what the seam owns/refuses + size-smell thresholds) | `groot` + ArgoCD GitOps is the control plane; needs a record |
| 7 | Risk register (governance + abandonment risk for selected components) | MISSING |
| 8 | Carried patches registered (every build-time patch has a row before it ships) | `tower/` Dockerfile is a build-time source; otherwise likely none |

## Findings — current state (all missing unless noted)

- **No governance scaffolding at all:** no `governance/qm` submodule, no `adr/`,
  no `AGENTS.md`, no `records/`/`registers/`, no branch-namespace model.
- **No licensing / REUSE:** no `LICENSE`, no `LICENSES/`, no `REUSE.toml`, and
  **zero SPDX headers** in tracked files → `reuse-lint` gate fails everywhere.
- **Workflows:** only `publish-chart.yaml` exists; the 4 required governance
  workflows are absent.

### Quality / hygiene issues (mapped to principles & gates)

- **Committed credentials (P7 + secret-scan gate)** — all from a decommissioned
  test instance per owner, so **remove from the working tree; rotation not needed;
  history purge optional**:
  - `loki/values.yaml:47` — MinIO key/secret in the S3 URL (also duplicated in
    commented lines 51–52).
  - `charts/frigate/values.yaml:144` — RTSP camera creds + internal IP
    (`rtsp://moat0:qwertyui@10.31.0.153/...`).
  - `charts/frigate/values.yaml:153` — hardcoded `password: frigate`.
  - (Not leaks: `charts/cert-manager/templates/issuer-*.yml` `*SecretRef` entries
    are correct references to Kubernetes Secrets — keep as the target pattern.)
- **Dead `moat` bash script (P12):** references `docker-compose.yml`/`dev.yml`/
  `production.yml` that don't exist; contains a shell bug `if [ !-z ]`. Vestigial
  from a pre-Kubernetes era.
- **Stale README (P6/P12):** install steps say `helm install argo-cd argo-cd/`
  and `helm template groot/`, but those charts live under `charts/` — commands
  fail as written.
- **Inconsistent layout (P9):** 7 charts sit at repo root (`authentik`,
  `influxdb`, `loki`, `openebs`, `technitium`, `tempo`, `victoria-logs`) while
  the rest are under `charts/`. `publish-chart.yaml` only publishes `charts/**`,
  so the root charts are silently unpublished. Undocumented split.
- **Abandonment risk:** `tower/Dockerfile` uses
  `tiangolo/uvicorn-gunicorn-fastapi:python3.7-alpine3.8` (2019-era, Python 3.7
  EOL); `tower/main.py` is a stub returning `'sup!'`. `charts/cert-manager` has a
  commented-out dependency from an unofficial repo (`kittizz.github.io`).

### Component inventory (obligation-1 raw material — already collected)

22 third-party chart dependencies pinned, e.g. authentik 2025.2.4, argo-cd 9.5.11,
cert-manager 1.19.3, cilium 1.19.1, traefik 39.0.8, loki 6.28.0, grafana 12.3.0,
prometheus 29.5.0, openebs 4.2.0, metallb 0.15.3, etc. (full table available).
Template-only: `groot` (bootstrap/control-plane), `technitium`.

## Blind-test log (claims verified against the filesystem, not asserted)

- `find` for `LICENSE*/COPYING/REUSE.toml/AGENTS.md/PRINCIPLES.md/CLAUDE.md/docker-compose*/dev.yml/production.yml` → **none found**. Confirms missing licences + dead script references.
- `find` for `records|adr|registers|handbook|perspectives|governance` dirs → **none found**. Confirms no governance scaffolding.
- `grep` for `SPDX-*` in tracked files → **none** (only an untracked git sample hook). Confirms reuse-lint would fail.
- `read loki/values.yaml` around line 47 → credential is **uncommented/in-use**, not just a comment. (Owner confirms it and the frigate creds are from a dead test instance → remove, no rotation.)
- `grep` for `://user:pass@` and `path:`-refs to the 7 root charts → found 2 extra frigate creds; **no internal path references** to the root charts, so moving them to `charts/` is reference-safe.
- `read .git/config` → remote is `quaternionmedia/moat`, branch `main`. Confirms moat is in-scope for QM governance.

## Environment constraint (affects the "run tests" ask)

The bash sandbox (landlock) is **not available in this kernel**
(`SANDBOX_SETUP_FAILED (landlock): not enforced`). I could not run `helm lint`,
`helm template`, `git`, `reuse lint`, or `uv run qm gates` locally this session.
All verification above was done via read/grep/find (filesystem truth) + web fetch
of the corpus. The plan therefore targets **CI** to run the real gates, and any
local gate-runs must happen in an environment with a working shell.

## Recommended approach (lazy-but-correct first step)

Do **not** try to satisfy all eight obligations up front. The corpus explicitly
says a project is compliant by *enumerating* gaps, not closing them all:
"a project that cannot satisfy one records the gap and what compliance would look
like… scope is frozen per conflict while it stays open."

So the minimal compliant landing is:
1. Wire the scaffolding (submodule, `adr/`, 4 workflows, licences/REUSE).
2. Write **ADR-0001 (adoption + scope) with the conflict table** enumerating every
   gap found above and what compliance looks like for each.
3. Strip the committed test credentials from the working tree (dead instance —
   no rotation), and note them as closed conflict rows in ADR-0001.

Then close obligations incrementally in follow-up PRs (component audit table,
SBOM/licence gates, service inventory, quarterly scan, control-plane record,
risk register, carried-patch rows).

## Files to create / modify

- `.gitmodules`, `governance/qm` (submodule) — new
- `adr/` (copied from `project-seed/adr/`) + `adr/DRAFT-adoption-scope.md` (ADR-0001) — new
- `.github/workflows/adr-lint.yml`, `submodule-check.yml`, `reuse-lint.yml`, `one-pr-check.yml` — new
- `LICENSE`, `LICENSES/`, `REUSE.toml`, SPDX headers across tracked files — new
- `AGENTS.md` — new (per corpus)
- `loki/values.yaml`, `charts/frigate/values.yaml` — strip test credentials
- `moat` (dead script) — delete; `README.md` — fix stale install steps
- **Move 7 root charts** (`authentik`, `influxdb`, `loki`, `openebs`,
  `technitium`, `tempo`, `victoria-logs`) → `charts/` (no name collisions, no
  internal path refs; `publish-chart.yaml` globs `charts/**` so they become
  published). Update README paths accordingly.

## Decisions (resolved with owner)

1. **Minimal landing** — enumerate gaps in ADR-0001's conflict table and land;
   do not attempt full obligation closure this pass (compliant-by-enumeration).
2. **Full adoption model** — build both the `governance/qm` submodule and the
   upstream `project/moat` branch in qm.
3. **Credentials** — all from a defunct test instance; remove from the tree, no
   rotation, history purge optional.
4. **Layout + dead code** — move all charts under `charts/`; delete stale code
   (`moat` script) and fix the stale README.
5. **Sandbox** — the execution phase runs in a full-featured sandbox, so gates
   (`helm`, `reuse`, `git`, `uv run qm`) run for real (not this planning session).

## Execution status

The execution environment had **no working shell** (kernel lacks landlock; every
`bash` call failed) and no delete/move/`git`. Content steps were completed in the
tree; git/network/decision steps are handed off with exact commands in
`HANDOFF.md`.

- **Done in-tree:** Step 1 (creds stripped), Step 4 (README paths), Step 10
  (ADR-0001 draft `adr/DRAFT-adoption-scope.md`).
- **Blocked on shell → `HANDOFF.md`:** Step 2 (`git rm`), Step 3 (`git mv`),
  Steps 5–8 (branch/submodule/seed/workflow copies), Step 9 (licence decision +
  SPDX sweep), Step 11 (org register), Step 12 (PR).

## Steps (execution checklist)

**Phase 0 — credential + dead-code hygiene (independent, do first)**
- [ ] Strip credentials from `loki/values.yaml` (lines 47, 51–52) and
      `charts/frigate/values.yaml` (lines 144, 153); replace with Secret refs /
      placeholders following the cert-manager `*SecretRef` pattern.
- [ ] Delete the dead `moat` bash script (references nonexistent compose files).

**Phase 1 — layout normalization**
- [ ] `git mv` the 7 root charts into `charts/`.
- [ ] Fix README install steps (`charts/argo-cd`, `charts/groot`, correct clone/
      bootstrap commands) and remove references to the deleted `moat` script.

**Phase 2 — governance scaffolding (upstream first)**
- [ ] In qm: cut `project/moat` off `main`, copy `project-seed/adr/` verbatim into
      a new `adr/` on that branch, push (no PR, per fork step 2).
- [ ] In moat: add qm as submodule at `governance/qm`; set `.gitmodules`
      `branch = project/moat`; pin submodule to that branch tip.
- [ ] Copy `adr/` scaffolding into moat; copy `project-seed/ide/` preserving
      symlinks.
- [ ] Copy the 4 workflows verbatim: `adr-lint.yml`, `submodule-check.yml`,
      `reuse-lint.yml`, `one-pr-check.yml`.
- [ ] Add `AGENTS.md` per corpus; add `LICENSE`, `LICENSES/`, `REUSE.toml`, and
      SPDX headers across tracked files until `reuse lint` passes.

**Phase 3 — ADR-0001 adoption + scope with conflict table**
- [ ] Draft `adr/DRAFT-adoption-scope.md` (numberless, `Proposed`, agent drafts /
      never ratifies). Conflict table rows — one per gap, each with: what it
      violates (org record), reproduction/pinning, what compliance looks like,
      status (open = scope frozen / closed = fixed this pass):
  - Obligations 1–8 not yet satisfied → open rows (component audit, cumulative
    licence gates, service inventory, quarterly upstream scan, seam protocols,
    control-plane record, risk register, carried patches).
  - Committed test credentials → closed (Phase 0).
  - Inconsistent chart layout / unpublished root charts → closed (Phase 1).
  - Missing SPDX/REUSE → closed (Phase 2).
  - `tower/` EOL base image + stub app; cert-manager unofficial commented dep →
    open rows in the risk-register conflict.
- [ ] Register any carried patches (`tower/` build-time image) in the org
      `registers/carried-patches.md`, or record "none" explicitly.

**Phase 4 — land**
- [ ] Open one PR on a `project/`-style branch, assign the requester, request no
      reviewer, run gates, merge once green (async-contract). Records stay
      `Proposed` pending a second code owner's ratification.

## Verification (execution phase — full sandbox available)

- `reuse lint` passes; every tracked file has SPDX info.
- `helm lint` + `helm template` render for every chart after the move (esp. the
  7 relocated root charts and `groot`).
- `uv run qm gates` and the 4 copied workflows all green in CI.
- `check_pr_base.py` confirms branch parentage; `run_workflows_locally.py` green.
- Secret-scan gate green; `grep -r` for the stripped keys returns nothing in the
  working tree.
- `adr-lint` passes on ADR-0001 (header/status/index well-formed, no banned
  narration vocabulary, no vendor/model names in prose, no template placeholders
  left, restatements name their record).
