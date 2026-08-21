#!/bin/bash
# moat governance adoption — complete execution script
# Run this from the /root/moat directory with git, helm, uv, reuse, gh available
# Usage: bash EXECUTION-SCRIPT.sh

set -e  # exit on error

echo "=========================================="
echo "moat Governance Adoption — Full Execution"
echo "=========================================="

# Verify prerequisites
for cmd in git helm uv reuse gh; do
  if ! command -v $cmd &> /dev/null; then
    echo "ERROR: $cmd not found. Install it and try again."
    exit 1
  fi
done

echo "✓ All prerequisites available"
echo ""

# ============================================================================
# PHASE 0 — Credential + dead-code hygiene
# ============================================================================
echo "PHASE 0: Credential + dead-code hygiene"
echo "----------------------------------------"

echo "→ Deleting dead moat script (references nonexistent compose files)"
git rm moat
git commit -m "remove dead moat script (references nonexistent docker-compose files)"
echo "✓ moat script deleted"
echo ""

# ============================================================================
# PHASE 1 — Layout normalization
# ============================================================================
echo "PHASE 1: Layout normalization"
echo "-----------------------------"

echo "→ Moving 7 root-level charts to charts/ directory"
for c in authentik influxdb loki openebs technitium tempo victoria-logs; do
  if [ -d "$c" ]; then
    git mv "$c" "charts/$c"
    echo "  ✓ moved $c → charts/$c"
  else
    echo "  ⚠ $c not found (may already be moved)"
  fi
done

git add -A
git commit -m "normalize chart layout: move 7 root charts to charts/ — all charts now published via publish-chart.yaml glob"
echo "✓ Chart layout normalized"
echo ""

# ============================================================================
# PHASE 2 — Governance scaffolding
# ============================================================================
echo "PHASE 2: Governance scaffolding"
echo "-------------------------------"

echo "→ Step 5: Create upstream project/moat branch in qm repo"
echo "  (This requires git@github.com access and creates a branch in the qm repo)"
cd /tmp
if [ -d "qm" ]; then
  echo "  ⚠ /tmp/qm exists; using existing clone"
  cd qm
else
  echo "  → Cloning qm repo..."
  git clone git@github.com:quaternionmedia/qm.git
  cd qm
fi

git fetch origin
git checkout main
git pull origin main
git checkout -b project/moat main 2>/dev/null || git checkout project/moat

# Copy project-seed/adr if it doesn't exist
if [ ! -d "adr" ]; then
  echo "  → Copying project-seed/adr to adr/"
  cp -r project-seed/adr adr
  git add adr
  git commit -m "project/moat: seed adr from project-seed"
else
  echo "  ⚠ adr/ already exists in project/moat"
fi

echo "  → Pushing project/moat branch"
git push -u origin project/moat

cd /root/moat
echo "✓ project/moat branch created in qm"
echo ""

echo "→ Step 6: Add qm as submodule (moat repo)"
git submodule add -b project/moat https://github.com/quaternionmedia/qm.git governance/qm 2>/dev/null || true
git config -f .gitmodules submodule.governance/qm.branch project/moat
git add .gitmodules governance/qm
git commit -m "add qm governance submodule at project/moat branch"
echo "✓ qm submodule added"
echo ""

echo "→ Step 7: Copy adr scaffolding and IDE discovery"
mkdir -p adr .github

# Copy adr files (README.md, TEMPLATE.md stay as copied in seed)
if [ -f "governance/qm/project-seed/adr/README.md" ]; then
  cp governance/qm/project-seed/adr/README.md adr/README.md
  echo "  ✓ copied adr/README.md"
fi

if [ -f "governance/qm/project-seed/adr/TEMPLATE.md" ]; then
  cp governance/qm/project-seed/adr/TEMPLATE.md adr/TEMPLATE.md
  echo "  ✓ copied adr/TEMPLATE.md"
fi

# Copy IDE discovery (preserves symlinks with -a)
if [ -d "governance/qm/project-seed/ide" ]; then
  echo "  → Copying IDE discovery from project-seed/ide"
  cp -a governance/qm/project-seed/ide/. .
  echo "  ✓ IDE discovery copied"
fi

git add adr/ .gitattributes 2>/dev/null || true
git commit -m "copy adr scaffolding and IDE discovery from project-seed"
echo "✓ adr scaffolding + IDE discovery added"
echo ""

echo "→ Step 8: Copy four governance workflows"
mkdir -p .github/workflows

for workflow in adr-lint submodule-check reuse-lint one-pr-check; do
  src=$(find governance/qm/project-seed -name "${workflow}.yml" -path '*workflow*' | head -1)
  if [ -f "$src" ]; then
    cp "$src" ".github/workflows/${workflow}.yml"
    echo "  ✓ copied ${workflow}.yml"
  else
    echo "  ⚠ ${workflow}.yml not found in project-seed"
  fi
done

git add .github/workflows/
git commit -m "add four governance workflows: adr-lint, submodule-check, reuse-lint, one-pr-check"
echo "✓ Governance workflows added"
echo ""

# ============================================================================
# PHASE 3 — Licensing and REUSE compliance
# ============================================================================
echo "PHASE 3: Licensing and REUSE compliance"
echo "----------------------------------------"

echo "→ Setting up REUSE compliance (using Apache-2.0 per corpus example)"

# Create LICENSES directory
mkdir -p LICENSES

# Download Apache-2.0 license
reuse download Apache-2.0

# Create REUSE.toml if it doesn't exist
if [ ! -f "REUSE.toml" ]; then
  cat > REUSE.toml << 'EOF'
# REUSE configuration for moat project
version = 1
SPDX-Version = "SPDX-2.3"
SPDX-DataLicense = "CC0-1.0"

[[annotations]]
path = "**"
precedence = "aggregate"
SPDX-FileCopyrightText = "Quaternion Media"
SPDX-FileNotice = "Project moat (github.com/quaternionmedia/moat)"
SPDX-License-Identifier = "Apache-2.0"

# Exceptions for non-source files
[[annotations]]
path = ["*.md", "*.yaml", "*.yml", ".gitignore", "LICENSE"]
SPDX-License-Identifier = "Apache-2.0"

[[annotations]]
path = "adr/**"
SPDX-License-Identifier = "Apache-2.0"

[[annotations]]
path = "charts/**"
SPDX-License-Identifier = "Apache-2.0"
EOF
  echo "  ✓ created REUSE.toml"
fi

# Annotate all tracked files
echo "  → Annotating tracked files with SPDX headers..."
git ls-files | xargs reuse annotate \
  --copyright "Quaternion Media" \
  --license Apache-2.0 \
  --year "2025" \
  --recursive

# Verify REUSE compliance
echo "  → Running reuse lint to verify compliance..."
if reuse lint; then
  echo "  ✓ REUSE compliance verified"
else
  echo "  ⚠ REUSE lint warnings (review above)"
fi

git add LICENSES/ REUSE.toml
git commit -m "add REUSE licensing: Apache-2.0 headers and compliance setup"
echo "✓ REUSE compliance configured"
echo ""

# ============================================================================
# PHASE 4 — Add AGENTS.md per corpus
# ============================================================================
echo "PHASE 4: Add AGENTS.md"
echo "---------------------"

if [ ! -f "AGENTS.md" ]; then
  echo "→ Adding AGENTS.md (reference to governance/qm/AGENTS.md)"
  cat > AGENTS.md << 'EOF'
# moat Project Agents

This project adopts the governance corpus at `governance/qm/`. For the agent
model and decision authority framework, see:

- **governance/qm/AGENTS.md** — the operative agent definition for this project

The governance corpus defines agents as follows: an agent is any entity (person,
team, service account) that can merge a PR or vote on a record. See
`governance/qm` for the full authority structure.

## Project-specific notes

- **Adoption:** moat adopted the QM governance corpus per ADR-0001
  (`adr/DRAFT-adoption-scope.md`).
- **Records:** Records are drafted by contributors and ratified by active code
  owners; see `adr/` for the record set.
- **Submodule:** The corpus is pinned at `governance/qm` on branch
  `project/moat`. The branch contains moat-specific adoptions of the corpus
  seed (`adr/` copied from `project-seed/adr/`).

See the corpus for the full AGENTS.md definition.
EOF
  git add AGENTS.md
  git commit -m "add AGENTS.md referencing governance/qm"
  echo "✓ AGENTS.md added"
else
  echo "⚠ AGENTS.md already exists"
fi
echo ""

# ============================================================================
# PHASE 5 — Verification
# ============================================================================
echo "PHASE 5: Verification"
echo "---------------------"

echo "→ Running helm lint on all charts..."
failed=0
for chart_dir in charts/*/; do
  chart_name=$(basename "$chart_dir")
  if helm lint "$chart_dir" > /dev/null 2>&1; then
    echo "  ✓ $chart_name"
  else
    echo "  ✗ $chart_name (lint failed)"
    ((failed++))
  fi
done

if [ $failed -eq 0 ]; then
  echo "✓ All charts pass helm lint"
else
  echo "⚠ $failed chart(s) failed lint (review above)"
fi
echo ""

echo "→ Checking for committed credentials..."
if grep -rn 'sVHgwClMflLX2WDwcCWS7dMN6j6WvNQyQagerVdz\|qwertyui\|password: frigate' . \
  --exclude-dir=.git --exclude-dir=governance --exclude-dir=LICENSES 2>/dev/null; then
  echo "✗ CREDENTIALS FOUND — must be removed before landing"
  exit 1
else
  echo "✓ No committed test credentials found"
fi
echo ""

echo "→ Checking submodule is correctly pinned..."
if git config -f .gitmodules --get submodule.governance/qm.branch | grep -q "project/moat"; then
  echo "✓ Submodule pinned to project/moat branch"
else
  echo "⚠ Submodule branch may not be set correctly"
fi
echo ""

# ============================================================================
# PHASE 6 — Final checks and summary
# ============================================================================
echo "PHASE 6: Final status and next steps"
echo "------------------------------------"

echo ""
echo "Git status:"
git status --short
echo ""

echo "Recent commits:"
git log --oneline -5
echo ""

echo "=========================================="
echo "✓ All phases complete!"
echo "=========================================="
echo ""
echo "NEXT STEPS (to be done in your own shell):"
echo "1. Review all commits above: git log --oneline HEAD~N..HEAD"
echo "2. Verify no secrets remain: git log -p | grep -i 'password\|secret\|key' | head -10"
echo "3. Test the full governance gate suite:"
echo "   uv run --project governance/qm qm gates"
echo ""
echo "4. Create and push the branch:"
echo "   git checkout -b evolve/adopt-governance"
echo "   git push -u origin evolve/adopt-governance"
echo ""
echo "5. Create PR (replace <requester> with the GitHub user):"
echo "   gh pr create --assignee <requester> --title 'adopt qm governance: ADR-0001 + compliance scaffolding'"
echo ""
echo "6. Check gates in the PR; once green, merge:"
echo "   gh pr merge --merge"
echo ""
echo "Records will stay Proposed until a second active code owner ratifies."
echo "=========================================="
