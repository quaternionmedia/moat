# moat Governance Adoption — Execution Checklist

**Start time:** _____  
**Executor:** _____  
**Environment:** shell with git, helm, uv, reuse, gh  

---

## ✅ Pre-flight Checks

- [ ] Working directory: `/root/moat`
- [ ] `git status` is clean (no uncommitted changes)
- [ ] All prerequisites available: `git`, `helm`, `uv`, `reuse`, `gh`
- [ ] SSH key available for `git@github.com` (for qm branch push)
- [ ] GitHub token available for `gh` (for PR creation)
- [ ] Internet access (to clone qm, push branches)

---

## 🚀 Automated Execution (Recommended)

**Option: Run the complete script**

```sh
cd /root/moat
bash EXECUTION-SCRIPT.sh 2>&1 | tee adoption-execution.log
```

- [ ] Script runs without errors
- [ ] All 6 phases complete
- [ ] Final verification passes (helm lint, secret scan, REUSE)
- [ ] git log shows new commits

If errors occur, stop and check troubleshooting section below.

---

## 🔧 Manual Execution (If Script Fails)

### Phase 0: Credential + Dead-Code Hygiene

**Step 2a: Delete dead `moat` script**
```sh
git rm moat
git commit -m "remove dead moat script (references nonexistent docker-compose files)"
```
- [ ] Script deleted
- [ ] Commit created

**Step 2b: Verify credential removal**
```sh
grep -rn 'sVHgwClMflLX2WDwcCWS7dMN6j6WvNQyQagerVdz\|qwertyui\|password: frigate' . \
  --exclude-dir=.git --exclude-dir=governance 2>/dev/null
```
- [ ] No results (credentials clean)

---

### Phase 1: Layout Normalization

**Step 3: Move 7 root charts to `charts/`**

```sh
for c in authentik influxdb loki openebs technitium tempo victoria-logs; do
  [ -d "$c" ] && git mv "$c" "charts/$c"
done
git add -A
git commit -m "normalize chart layout: move 7 root charts to charts/ — all charts now published via publish-chart.yaml glob"
```

- [ ] All 7 charts moved (or already in `charts/`)
- [ ] No file conflicts
- [ ] Commit created

**Verify moved charts render:**
```sh
for c in authentik influxdb loki openebs technitium tempo victoria-logs; do
  helm template "charts/$c" > /dev/null 2>&1 && echo "✓ $c" || echo "✗ $c FAILED"
done
```
- [ ] All charts pass `helm template`

---

### Phase 2: Governance Scaffolding

**Step 5: Create upstream `project/moat` branch (in qm repo)**

```sh
cd /tmp
git clone git@github.com:quaternionmedia/qm.git  # or use existing clone
cd qm
git fetch origin
git checkout -b project/moat main
cp -r project-seed/adr adr
git add adr
git commit -m "project/moat: seed adr from project-seed"
git push -u origin project/moat
cd /root/moat
```

- [ ] qm cloned
- [ ] `project/moat` branch created
- [ ] `adr/` copied
- [ ] Branch pushed to origin

**Step 6: Add qm as submodule**

```sh
git submodule add -b project/moat https://github.com/quaternionmedia/qm.git governance/qm
git config -f .gitmodules submodule.governance/qm.branch project/moat
git add .gitmodules governance/qm
git commit -m "add qm governance submodule at project/moat branch"
```

- [ ] Submodule added
- [ ] `.gitmodules` has `branch = project/moat`
- [ ] `governance/qm` directory present
- [ ] Commit created

**Step 7: Copy adr scaffolding and IDE**

```sh
mkdir -p adr .github
cp governance/qm/project-seed/adr/README.md adr/README.md
cp governance/qm/project-seed/adr/TEMPLATE.md adr/TEMPLATE.md
cp -a governance/qm/project-seed/ide/. .
git add adr/ .gitattributes
git commit -m "copy adr scaffolding and IDE discovery from project-seed"
```

- [ ] `adr/README.md` copied
- [ ] `adr/TEMPLATE.md` copied
- [ ] IDE discovery copied
- [ ] `adr/DRAFT-adoption-scope.md` still present (verify it exists)
- [ ] Commit created

**Step 8: Copy 4 workflows**

```sh
mkdir -p .github/workflows
find governance/qm/project-seed -name '*.yml' -path '*workflow*'  # Locate source
# Copy these four:
cp governance/qm/project-seed/.../adr-lint.yml .github/workflows/
cp governance/qm/project-seed/.../submodule-check.yml .github/workflows/
cp governance/qm/project-seed/.../reuse-lint.yml .github/workflows/
cp governance/qm/project-seed/.../one-pr-check.yml .github/workflows/
git add .github/workflows/
git commit -m "add four governance workflows: adr-lint, submodule-check, reuse-lint, one-pr-check"
```

- [ ] All 4 workflows found in project-seed
- [ ] All 4 workflows copied to `.github/workflows/`
- [ ] No duplicate workflows
- [ ] Commit created

---

### Phase 3: Licensing and REUSE

**Step 9a: Create LICENSES directory and download Apache-2.0**

```sh
mkdir -p LICENSES
reuse download Apache-2.0
```

- [ ] `LICENSES/` directory created
- [ ] `LICENSES/Apache-2.0.txt` present

**Step 9b: Create REUSE.toml**

```sh
cat > REUSE.toml << 'EOF'
version = 1
SPDX-Version = "SPDX-2.3"
SPDX-DataLicense = "CC0-1.0"

[[annotations]]
path = "**"
precedence = "aggregate"
SPDX-FileCopyrightText = "Quaternion Media"
SPDX-FileNotice = "Project moat (github.com/quaternionmedia/moat)"
SPDX-License-Identifier = "Apache-2.0"

[[annotations]]
path = ["*.md", "*.yaml", "*.yml", ".gitignore", "LICENSE"]
SPDX-License-Identifier = "Apache-2.0"

[[annotations]]
path = ["adr/**", "charts/**"]
SPDX-License-Identifier = "Apache-2.0"
EOF
```

- [ ] `REUSE.toml` created
- [ ] File is valid TOML

**Step 9c: Annotate all tracked files with SPDX headers**

```sh
git ls-files | xargs reuse annotate \
  --copyright "Quaternion Media" \
  --license Apache-2.0 \
  --year "2025" \
  --recursive
```

- [ ] Annotation completed
- [ ] Files have SPDX headers

**Step 9d: Verify REUSE compliance**

```sh
reuse lint
```

- [ ] `reuse lint` passes (all checks green)
- [ ] No unattributed files

**Step 9e: Commit licensing**

```sh
git add LICENSES/ REUSE.toml
git commit -m "add REUSE licensing: Apache-2.0 headers and compliance setup"
```

- [ ] Commit created

---

### Phase 4: Add AGENTS.md

**Step 4.5: Create AGENTS.md**

```sh
cat > AGENTS.md << 'EOF'
# moat Project Agents

This project adopts the governance corpus at `governance/qm/`. For the agent
model and decision authority framework, see:

- **governance/qm/AGENTS.md** — the operative agent definition for this project

The governance corpus defines agents as follows: an agent is any entity (person,
team, service account) that can merge a PR or vote on a record.

## Project-specific notes

- **Adoption:** moat adopted the QM governance corpus per ADR-0001
  (`adr/DRAFT-adoption-scope.md`).
- **Records:** Records are drafted by contributors and ratified by active code
  owners; see `adr/` for the record set.
- **Submodule:** The corpus is pinned at `governance/qm` on branch
  `project/moat`.

See the corpus for the full AGENTS.md definition.
EOF
git add AGENTS.md
git commit -m "add AGENTS.md referencing governance/qm"
```

- [ ] `AGENTS.md` created
- [ ] Commit created

---

### Phase 5: Verification

**Helm lint all charts**

```sh
for d in charts/*/; do
  helm lint "$d" > /dev/null 2>&1 && echo "✓ $(basename $d)" || echo "✗ $(basename $d) FAILED"
done
```

- [ ] All charts pass lint
- [ ] No failures

**Secret scan**

```sh
grep -rn 'sVHgwClMflLX2WDwcCWS7dMN6j6WvNQyQagerVdz\|qwertyui\|password: frigate' . \
  --exclude-dir=.git --exclude-dir=governance --exclude-dir=LICENSES 2>/dev/null && \
  echo "✗ CREDENTIALS FOUND" || echo "✓ Clean"
```

- [ ] No credentials found

**Submodule check**

```sh
git config -f .gitmodules --get submodule.governance/qm.branch
```

- [ ] Output: `project/moat`

**Git status**

```sh
git status --short
```

- [ ] All changes staged
- [ ] No untracked files (except EXECUTION-SCRIPT.sh, adoption-execution.log)

**Git log (last 10 commits)**

```sh
git log --oneline -10
```

- [ ] New commits visible (from this session)
- [ ] Messages clearly describe each step

---

### Phase 6: Create and Land PR

**Checkout feature branch (if not already on one)**

```sh
git checkout -b evolve/adopt-governance
```

- [ ] Branch created or already checked out

**Push to origin**

```sh
git push -u origin evolve/adopt-governance
```

- [ ] Branch pushed
- [ ] No conflicts

**Create PR**

```sh
gh pr create \
  --assignee <GitHub-username> \
  --title "adopt qm governance: ADR-0001 + compliance scaffolding" \
  --body "Adopt QM governance corpus per PLAN.md and ADR-0001. Closes #<issue-if-any>"
```

- [ ] PR created
- [ ] Assigned to requester
- [ ] No reviewer requested

**Monitor gates in CI**

- [ ] adr-lint passes
- [ ] reuse-lint passes
- [ ] helm lint passes
- [ ] one-pr-check passes
- [ ] submodule-check passes
- [ ] (any project-specific gates) pass

**Merge PR**

```sh
gh pr merge --merge
```

- [ ] PR merged
- [ ] Branch closed

---

## 📊 Summary

**Phases completed:**
- [ ] Phase 0: Credential + dead-code hygiene
- [ ] Phase 1: Layout normalization
- [ ] Phase 2: Governance scaffolding
- [ ] Phase 3: Licensing and REUSE
- [ ] Phase 4: AGENTS.md
- [ ] Phase 5: Verification
- [ ] Phase 6: PR creation and merge

**Verification:**
- [ ] `reuse lint` passes
- [ ] `helm lint` passes on all charts
- [ ] Secret scan clean
- [ ] All commits present
- [ ] Submodule pinned correctly

**Post-adoption:**
- [ ] PR merged
- [ ] Records stay `Proposed` (awaiting second code owner ratification)
- [ ] Follow-up issues created for open obligations (1–10)

**Completion time:** _____  
**Notes:** _______________________________________________

---

## 🐛 Troubleshooting

### reuse annotate hangs
- Try without `--recursive`:
  ```sh
  git ls-files | xargs reuse annotate --copyright "Quaternion Media" --license Apache-2.0 --year 2025
  ```

### helm lint fails on a chart
- Check if the chart moved without updating internal references:
  ```sh
  helm template charts/<name> --debug
  ```
- May need to run `helm dependency update` on the chart

### git submodule add fails
- Use HTTPS instead:
  ```sh
  git submodule add -b project/moat https://github.com/quaternionmedia/qm.git governance/qm
  ```
- Or ensure SSH key is loaded:
  ```sh
  ssh-add ~/.ssh/id_ed25519  # or your key path
  ```

### gh pr create fails
- Verify token: `gh auth status`
- May need to re-authenticate: `gh auth login`

### project/moat branch doesn't exist in qm
- Verify you pushed it: `git push -u origin project/moat` in the qm repo
- Check: `git ls-remote origin | grep project/moat`

---

## ✨ Final Notes

- Records drafted by contributors stay `Proposed` until a second active code owner ratifies (per corpus).
- Each open obligation becomes a follow-up PR (one per row in ADR-0001 conflict table).
- The ADR itself is not ratified; it serves as the binding contract for what compliance means until rows close.
- See `governance/qm/handbook/` for the full adoption and governance procedures.
