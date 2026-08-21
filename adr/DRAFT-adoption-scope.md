# ADR-XXXX — Adopt QM governance and freeze scope per open conflict

| | |
|---|---|
| **Status** | Draft |
| **Date** | 2026-08-17 |
| **Pends on** | `governance/qm` submodule wired at a pinned commit; the org licence set chosen for this repo; a second active code owner to ratify |

## Context

moat is a homelab IaC repo: Helm charts wrapping third-party upstreams,
OpenTofu/Proxmox/Talos infrastructure under `tofu/`, a small FastAPI service in
`tower/`, and one chart-publishing workflow. It predates its adoption of the QM
governance corpus (`github.com/quaternionmedia/qm`).

The corpus requires an adopting project that predates the corpus to open its
record set with a conflict table: every known conflict with an org record, what
it violates, and what compliance would look like. Enumerating a conflict is not
waiving it; scope is frozen per conflict while it stays open.

## Decision

moat adopts the QM governance corpus and pins it as a submodule at
`governance/qm`. The conflicts below are the frozen scope. Each open row holds
its subject frozen: no change may deepen the surface a row names until that row
closes.

§1 — Adoption. This repo tracks the corpus through `governance/qm` and carries
its own `adr/` copied from `project-seed/adr/`. Records are drafted here and
ratified only by a second active code owner; every change lands as a pull
request whose author merges it once gates are green.

§2 — Conflict table. The rows below are the complete set of known conflicts at
adoption. A closed row is fixed in the adopting pull request; an open row names
what compliance requires and freezes its subject until met.

| # | Conflict | Org record / gate it violates | Reproduction / pinning | What compliance looks like | Status |
|---|---|---|---|---|---|
| 1 | No baseline component audit | open-license (obligation 1) | ~22 third-party charts pinned across `charts/` and root-level chart dirs | A table in this record: every runtime component, its licence, its disposition | Open |
| 2 | No cumulative licence gates | open-license §4 (obligation 2) | Three runtime shapes ship: OCI images via charts, the `tower/` Python image, OpenTofu provider binaries | An SBOM gate per image and a dependency-manifest gate per ecosystem | Open |
| 3 | No service inventory | open-license §6 (obligation 3) | ACME/Let's Encrypt, upstream Helm and OCI registries reached at runtime; no written list | A list of every third-party service in a runtime path with the ownability test answered | Open |
| 4 | No quarterly upstream scan | open-license §4 (obligation 4) | Pinned chart and image versions with no watch job | A scheduled job watching pinned upstreams for licence and archive changes | Open |
| 5 | No seam protocol named | seams (obligation 5) | No component-selection records exist | Each component-selection record names its protocol and answers the replaceability test | Open |
| 6 | No control-plane record | build-the-seam (obligation 6) | `groot` chart plus ArgoCD is the GitOps control plane, unrecorded | A record naming what the control plane owns, refuses to own, and its size-smell thresholds | Open |
| 7 | No risk register | open-license, seams (obligation 7) | `tower/` base image `python3.7-alpine3.8` is end-of-life; `charts/cert-manager` carries a commented dependency from an unofficial repo | A design-doc section recording governance and abandonment risk per selected component | Open |
| 8 | Carried patches unregistered | contribution (obligation 8) | `tower/Dockerfile` is a build-time source, not a release artifact | Each build-time patch has a row in the org register before it ships, or the register records none | Open |
| 9 | No REUSE licensing | reuse-lint gate | No `LICENSE`, `LICENSES/`, `REUSE.toml`; zero SPDX headers | Licences chosen, `LICENSES/` and `REUSE.toml` present, SPDX headers on tracked files, `reuse lint` green | Open |
| 10 | Split chart layout | P9 minimal, legible deliverables | 7 charts sit at repo root; `publish-chart.yaml` globs `charts/**` and skips them | One `charts/` tree; every chart published; README paths match | Open |
| 11 | Committed test credentials | P7, secret-scan gate | MinIO key in `loki/values.yaml`; RTSP and ONVIF creds in `charts/frigate/values.yaml` | Credentials removed from the tree; injected at deploy time from a Secret | Closed |
| 12 | Stale install docs | P6, P12 | README install steps referenced chart paths that do not resolve | README steps resolve against the real chart paths | Closed |

## Consequences

- Scope is frozen per open row: charts, images, and services are held as-is
  until the obligation a row names is met. Fixing a row is in scope; widening
  the surface it guards is not.
- Row 11 and row 12 close in the adopting pull request; the credentials came
  from a decommissioned test instance, so removal from the tree is enough and
  no rotation is required.
- The remaining rows convert into follow-up pull requests, one obligation each,
  each closing its row in this table.
- Until a second active code owner exists, this record stays `Proposed` and
  binds nothing on its own.

## Alternatives considered

1. **Satisfy all eight obligations before adopting.** Rejected: the corpus
   makes adoption the act of enumerating gaps, not closing them, and a single
   pull request closing eight obligations would fail the one-decision-per-record
   discipline and the one-open-PR slot.
2. **Adopt without a conflict table.** Rejected: the adoption clause requires
   the table for a project that predates the corpus; adoption without it is not
   compliant.
3. **Copy the seed and stop.** Rejected: a project is not compliant because it
   copied the seed; the obligations nothing generates still bind.

## Revision triggers

- A new third-party component, image, or service enters a runtime path.
- An open row closes, or a closed row reopens.
- The org record set that a row cites changes.

## Amendments

*None.*
