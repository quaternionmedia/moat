# moat governance adoption — shell handoff

The planning session had no working shell (kernel lacks landlock, so every
sandboxed command failed) and no file delete/move/`git`. The content work is
done in the tree; the steps below need a real shell. Run them from a clone of
this repo with `git`, `helm`, `uv`, `reuse`, and `gh` available.

## Done in-tree already (no shell needed)

- **Step 1** — test credentials stripped: `loki/values.yaml`,
  `charts/frigate/values.yaml`.
- **Step 4** — README bootstrap paths fixed (`charts/argo-cd`, `charts/groot`).
- **Step 10** — `adr/DRAFT-adoption-scope.md` written (ADR-0001, the adoption +
  conflict table). Still needs the verbatim `adr/README.md` / `adr/TEMPLATE.md`
  from the submodule (Step 7) and an `adr-lint` run.

## Step 2 — delete the dead `moat` script

```sh
git rm moat        # references docker-compose.yml/dev.yml/production.yml that do not exist
```

## Step 3 — one chart tree

```sh
for c in authentik influxdb loki openebs technitium tempo victoria-logs; do
  git mv "$c" "charts/$c"
done
# reference-safe: no internal path refs to these dirs, no name collisions under charts/.
# publish-chart.yaml globs charts/** so they become published.
```

## Step 5 — upstream `project/moat` branch (in a qm clone, not here)

```sh
git clone git@github.com:quaternionmedia/qm.git && cd qm
git checkout -b project/moat main
cp -r project-seed/adr adr                 # verbatim copy into a new adr/
git add adr && git commit -m "project/moat: seed adr"
git push -u origin project/moat            # no PR, per forking-a-project step 2
```

## Step 6 — submodule (in this repo)

```sh
git submodule add -b project/moat https://github.com/quaternionmedia/qm.git governance/qm
git config -f .gitmodules submodule.governance/qm.branch project/moat
```

## Step 7 — adr scaffolding + IDE discovery

```sh
cp governance/qm/project-seed/adr/README.md   adr/README.md
cp governance/qm/project-seed/adr/TEMPLATE.md adr/TEMPLATE.md   # keep adr/DRAFT-adoption-scope.md
cp -a governance/qm/project-seed/ide/. .       # -a preserves symlinks (Windows: enable symlink support first)
```

## Step 8 — the four project workflows (verbatim from the seed)

The corpus says copy `adr-lint.yml`, `submodule-check.yml`, `reuse-lint.yml`,
`one-pr-check.yml` verbatim. `submodule-check.yml` is a project-only workflow, so
locate the four under the seed (`governance/qm/project-seed/**/workflows/`), not
the org's own `.github/workflows/`:

```sh
find governance/qm/project-seed -name '*.yml' -path '*workflow*'   # confirm source paths
cp <seed>/adr-lint.yml <seed>/submodule-check.yml <seed>/reuse-lint.yml <seed>/one-pr-check.yml .github/workflows/
```

## Step 9 — AGENTS.md + REUSE licensing (needs a decision, then a sweep)

- **Licence choice is an owner/org decision** (the corpus uses Apache-2.0,
  CC-BY-SA-4.0, CC0-1.0, LicenseRef-QM-No-Grant). Not stamped here on purpose:
  a repo-wide SPDX sweep before the choice is churn if the choice differs. This
  is ADR-0001 row 9.
- After the choice:

```sh
mkdir -p LICENSES && reuse download <SPDX-ID>        # e.g. Apache-2.0
# add REUSE.toml, then annotate:
reuse annotate --copyright "Quaternion Media" --license <SPDX-ID> $(git ls-files)
reuse lint
```

- **AGENTS.md:** decide whether the project carries its own pointing at
  `governance/qm/AGENTS.md`, or relies on the submodule. Confirm against the
  corpus before adding.

## Step 11 — carried patches

Only build-time source found: `tower/Dockerfile` (a stub FastAPI service on the
end-of-life `python3.7-alpine3.8` base). Either register a row in the org
`registers/carried-patches.md`, or (recommended, per ADR-0001 rows 7/8) drop the
stub service and record "none".

## Step 12 — land it

```sh
git checkout -b evolve/adopt-governance
git add -A && git commit -m "adopt qm governance; strip test creds; normalize charts"
# gates locally BEFORE marking ready:
uv run --project governance/qm qm gates
python governance/qm/ci/run_workflows_locally.py
python governance/qm/ci/check_pr_base.py
git push -u origin evolve/adopt-governance
gh pr create --assignee <requester>            # request NO reviewer (async-contract)
gh pr merge --merge                            # author merges once every gate is green
# records stay Proposed until a second active code owner ratifies
```

## Verification (must all pass)

```sh
reuse lint
for d in charts/*/; do helm lint "$d" && helm template "$d" >/dev/null; done
grep -rn 'sVHgwClMflLX2WDwcCWS7dMN6j6WvNQyQagerVdz\|qwertyui\|password: frigate' . \
  && echo "LEAK REMAINS" || echo "creds clean"
uv run --project governance/qm qm gates      # adr-lint, reuse-lint, one-pr, namespace-guard, ...
```
