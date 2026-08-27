# Modular Refactor — Any Device Targetable

## Context

Today `net/` is a flat root module with two hardcoded provider aliases
(`uapi.moatnet`, `uapi.drawbridge`) and 28 resource blocks that each name their
provider explicitly. Adding a third device means copying resource blocks and
editing every `provider =` line. Targeting one device means a 6-entry
`-exclude-file`.

Goal: adding a future device should be a **data entry, not new HCL**, and
targeting one device should be a single flag.

---

## Verified Findings (these drive the design)

### F1. OpenTofu supports `for_each` on provider configurations ✅

An OpenTofu-exclusive feature (Terraform does not have it), available since
1.9; we run 1.12.3. This is what makes a truly dynamic device list possible:

```hcl
provider "uapi" {
  alias    = "device"
  for_each = var.devices
  endpoint = each.value.endpoint
}
```

### F2. A `for_each`'d module CAN receive one provider instance ✅

Per the OpenTofu module-providers docs: you cannot pass the whole expanded set
into a child module, but *"it is valid for the parent module to assign a single
dynamic instance of a provider configuration to each instance of the module."*

```hcl
module "device" {
  for_each  = local.active_devices
  providers = { uapi = uapi.device[each.key] }
}
```

### F3. Provider `for_each` and module `for_each` must NOT be the same expression ⚠️

Documented warning. If both iterate `var.devices`, removing a device deletes the
provider instance and its resources in the same plan — and OpenTofu needs the
provider instance alive to destroy the resources. Deadlock.

**Mitigation:** provider iterates the full `var.devices`; the module iterates a
**filtered subset** (`if v.enabled`). Retiring a device is then two steps:
`enabled = false` → apply (resources destroyed) → remove the map entry → apply.
This mirrors the `if config != null` pattern in OpenTofu's own docs.

### F4. No state exists yet — the refactor is free ✅

`terraform.tfstate` is 0 bytes; nothing has been applied. **No `moved` blocks,
no `tofu state mv`, no migration risk.** Every resource address can change
freely. This will not be true after the first real apply, so doing the refactor
now is materially cheaper than doing it later.

### F5. `import` blocks support `for_each` ✅

So stock-section adoption (`lan`, `wan`, radios) becomes a data-driven map
input rather than six hand-written blocks.

### F6. The module must not declare its own `provider` blocks

*"A module containing its own provider configurations is not compatible with
the `for_each`, `count`, and `depends_on` meta-arguments."* The module gets
`required_providers` only; configuration is always injected.

### F7. Module `source` must be a literal string — it cannot be dynamic

Modules are installed at `tofu init`, before any variable is evaluated, so
`source` can never be an expression. **A second hardware platform therefore
cannot be selected per-device inside one module block** — it needs its own
module block. This is what shapes the multi-vendor answer below.

---

## Approach

One generic `openwrt-device` module that is a **thin resource factory**: it
creates whatever its input maps describe and nothing more. Empty map = no
resources of that kind. **No boolean feature flags** — the data decides.

Network-wide *policy* (VLAN catalog, firewall tiers, HA forwardings) stays at
the root, where it belongs; the module never knows what a "bailey" is.

```
net/
├── providers.tf              # provider "uapi" with for_each over OpenWrt devices
├── inventory.tf              # THE device list — add a device by adding an entry
├── devices.tf                # module "openwrt" block (one per platform)
├── vlans.tf                  # shared VLAN catalog (from MoatNet.csv)
├── policy.tf                 # firewall tiers + forwardings, computed at root
├── variables.tf              # tokens (sensitive), shared knobs
├── outputs.tf
└── modules/openwrt-device/
    ├── versions.tf           # required_providers ONLY (see F6)
    ├── variables.tf
    ├── network.tf            # wan iface, bridge VLANs, interfaces
    ├── firewall.tf           # zones/forwardings/rules/defaults (iff non-empty)
    ├── dhcp.tf               # servers + dnsmasq (iff non-empty)
    ├── wireless.tf           # radios + SSIDs (iff non-empty)
    ├── imports.tf            # for_each adoption of stock sections (F5)
    └── outputs.tf
```

**Targeting becomes one flag:**
```sh
tofu apply -target='module.openwrt["moatnet"]'
```
`exclude-drawbridge.txt` gets deleted.

**Adding a future OpenWrt device** = one entry in `inventory.tf` + its token.
No new resource blocks, no new provider block, no module block.

### The expansion seam for non-OpenWrt hardware

Because module `source` is static (F7), supporting a Mikrotik or UniFi box is
**not** a plugin system — it is one additional module block filtered by
`platform`:

```hcl
# today
module "openwrt" {
  for_each  = { for k, v in var.devices : k => v if v.platform == "openwrt" && v.enabled }
  source    = "./modules/openwrt-device"
  providers = { uapi = uapi.device[each.key] }
  vlans     = local.vlans          # vendor-neutral
  firewall  = local.policy[each.key]  # vendor-neutral
  ...
}

# later, additive — nothing above changes
module "mikrotik" {
  for_each = { for k, v in var.devices : k => v if v.platform == "mikrotik" && v.enabled }
  source   = "./modules/mikrotik-device"
  vlans    = local.vlans           # same catalog
  firewall = local.policy[each.key] # same policy
}
```

**The thing that actually buys future expansion is keeping the root layer
vendor-neutral** — `vlans.tf` and `policy.tf` must express *intent* (VLAN 6 is
guest; guest may reach wan; home may reach iot) as plain data, never as uapi
resource shapes. Get that right and a second platform is additive. Get it
wrong and every new vendor means rewriting the policy.

That costs **zero extra code today** — it is a naming and data-shape
discipline, not an abstraction layer. Concretely, today's only concessions are:

1. The module block is named `openwrt`, not `device`, so a future platform sits
   beside it rather than forcing a state move.
2. Each inventory entry carries `platform = "openwrt"` (defaulted), used solely
   as a filter.

No interfaces-with-one-implementation, no vendor adapter layer. Those get built
when a second vendor actually arrives.

---

## Files to Modify

| Path | Action |
|---|---|
| `modules/openwrt-device/*` | **New** — generic factory module |
| `providers.tf` | Rewrite: single `for_each` provider block, filtered to `platform == "openwrt"` |
| `inventory.tf` | **New** — device inventory map |
| `devices.tf` | **New** — `module "openwrt"` block |
| `policy.tf` | **New** — firewall tiers/forwardings lifted out of `firewall.tf` |
| `vlans.tf` | Becomes the shared VLAN catalog only (bridge-VLAN resources move into module) |
| `interfaces.tf`, `firewall.tf`, `dhcp.tf`, `wireless.tf`, `imports.tf` | Deleted at root; contents become module templates |
| `variables.tf` | Slim to tokens + shared knobs |
| `exclude-drawbridge.txt` | Delete — superseded by `-target='module.device[...]'` |

## Reuse

- `local.vlans` / `local.vlan_networks` (`variables.tf`) — the VLAN catalog is
  already the single source of truth; it moves to `vlans.tf` unchanged and is
  passed into each module instance.
- Zone tier locals `trusted_vlans` / `bailey_vlans` / `isolated_vlans` and
  `ha_device_vlans` / `av_primaries` (`firewall.tf`) — lift to `policy.tf`
  as-is; the computed zone/forwarding lists become module inputs.
- All 28 existing resource blocks — bodies are reused nearly verbatim inside
  the module; only `provider =` lines drop and `for_each` sources change to
  module inputs.

## Steps

- [ ] Create `modules/openwrt-device` skeleton (`versions.tf`, `variables.tf`)
- [ ] Move network resources (wan, bridge VLANs, interfaces) into module
- [ ] Move firewall resources into module, driven by input lists
- [ ] Move DHCP + dnsmasq into module
- [ ] Move wireless (radios + SSIDs) into module
- [ ] Convert adoption to `for_each` import blocks (F5)
- [ ] Write root `providers.tf` with provider `for_each` (platform-filtered)
- [ ] Write `inventory.tf` with moatnet + drawbridge entries, incl. `role` + `platform`
- [ ] Write `devices.tf` with the `module "openwrt"` block (enabled-subset per F3)
- [ ] Lift firewall policy to vendor-neutral `policy.tf`
- [ ] Add `role` validation (advisory: warn if an `ap` declares firewall zones)
- [ ] Delete superseded root files + `exclude-drawbridge.txt`
- [ ] Document "adding a device" in a short README section

## Verification

```sh
tofu init && tofu validate && tofu fmt -check

# Whole-network plan must match today's resource count (171) — no drift
tofu plan

# Single-device targeting, the point of the exercise
tofu plan -target='module.openwrt["moatnet"]'
tofu plan -target='module.openwrt["drawbridge"]'
```

Acceptance criteria:

1. MoatNet-only plan yields the same **171 resources** the current
   `-exclude-file` run produces — proves no behavioural drift.
2. A scratch third device added to `inventory.tf` plans cleanly with **zero**
   new HCL (then remove it).
3. `enabled = false` on drawbridge plans a clean destroy of only its resources,
   with the provider instance surviving (proves the F3 mitigation works).

---

## Resolved Decisions

| # | Decision |
|---|---|
| Q1 | **Single state.** Targeting via `-target='module.openwrt["x"]'`. |
| Q2 | **All OpenWrt for now**, structured so other platforms are additive — see *The expansion seam* above. |
| Q3 | **Firewall policy at root**, in vendor-neutral `policy.tf`. |
| Q4 | **Yes to `role`**, advisory only — validation and documentation, never branching logic. |

### Inventory entry shape

```hcl
variable "devices" {
  type = map(object({
    endpoint = string
    role     = string                          # "router" | "ap"  (advisory)
    platform = optional(string, "openwrt")     # filter only; expansion seam
    enabled  = optional(bool, true)            # F3 mitigation
    insecure = optional(bool, true)

    bridge   = optional(string, "br-lan")
    wan_port = optional(string)                # null => no WAN interface

    vlan_ports = optional(map(list(string)), {})
    interfaces = optional(map(any), {})
    dhcp       = optional(map(any), {})
    wireless   = optional(any)
    adopt      = optional(map(string), {})     # stock sections to import (F5)
  }))
}
```

Tokens live in a **separate** sensitive map (`var.device_tokens`, keyed by the
same device name) so the inventory itself stays readable and non-sensitive.

`role` validation is advisory: a `validation` block that rejects an `ap` which
declares firewall zones or DHCP servers, since that is almost always a mistake
rather than an intent.

---

## Risks

- **Retiring a device is two applies, not one** (F3). Documented in the README
  section; `enabled = false` first, remove the entry second.
- **`-target` produces a partial plan.** Fine for iterating on a bench unit, but
  a clean targeted run does not validate the whole config — run an untargeted
  `tofu plan` before declaring done.
- **This is the cheap moment** (F4). The same refactor after a real apply needs
  ~171 `moved` blocks.
