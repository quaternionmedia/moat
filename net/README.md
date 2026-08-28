# MoatNet — Pulumi TypeScript

Production-grade OpenWrt fleet management (MoatNet router + Drawbridge AP) via Pulumi and the bridged `openwrt-iac/uapi` provider.

## Architecture

```
src/
├── vlans.ts         # VLAN catalog (MoatNet.csv as types) — vendor-neutral
├── policy.ts        # Firewall intent (zones/forwardings/rules) — vendor-neutral
├── inventory.ts     # Device list (endpoints, roles, port topology)
├── device.ts        # OpenwrtDevice ComponentResource factory
└── index.ts         # Per-device provider + device instantiation
```

**Why Pulumi?** The flat HCL approach had tight coupling between generic data and resource shapes. Pulumi's ComponentResource breaks this tie: `device.ts` computes the actual resource config from generic device + policy inputs, catching topology mismatches at compile time (typed `vlan_ports` and `ip_vlans`) rather than at apply.

**Vendor-neutral tiers:** Policy is pure data (firewall zones keyed by VLAN name, forwardings by source/dest pair names). A future Mikrotik or Vyatta module could consume `policy.ts` unchanged.

**Per-device providers, no for_each trap:** Each device gets a real `uapi.Provider` instance in a plain `for` loop (see `index.ts`). The OpenTofu `for_each` limitation that forced a two-step retirement dance (step F3 in the old refactor plan) simply doesn't exist in Pulumi.

## Setup

### Prerequisites

- Pulumi CLI 3.147+
- Node 18+ (npm 9+)
- Real endpoint URLs and API tokens for moatnet and drawbridge

### First-time setup

```bash
# Set up local state backend
pulumi login --local
export PULUMI_CONFIG_PASSPHRASE="<passphrase>"

# Create stack
pulumi stack init bench

# Set device endpoints + tokens (secrets encrypted with PULUMI_CONFIG_PASSPHRASE)
pulumi config set --path 'tokens:moatnet'    "$(uapi-token get moatnet)"
pulumi config set --path 'tokens:drawbridge' "$(uapi-token get drawbridge)"

# Install dependencies
npm install
```

### Building and previewing

```bash
# Compile TypeScript (required before preview/up)
npm run build

# Dry-run: shows what will be created/updated/deleted
export PULUMI_CONFIG_PASSPHRASE="<passphrase>"
npm run preview

# Apply
npm run up
```

## Adding a device

Three edits, all in `src/inventory.ts`:

```typescript
export const INVENTORY: Record<string, Device> = {
  moatnet: { ... },
  drawbridge: { ... },
  my_new_device: {          // ← Add device name
    endpoint: "https://192.168.x.y/api/v3",  // ← Endpoint
    role: "router",         // ← "router" or "ap"
    vlan_ports: {           // ← Which VLANs on which ports (from VLAN_NETWORKS keys)
      config: ["eth0:u*"],  //   "u*" = untagged, "t" = tagged
      lan: ["eth0:t"],
      iot: ["eth1:t"],
    },
    // (no ip_vlans? defaults to every vlan_ports key getting .1 gateway)
    // (no dhcp_vlans? defaults to all of ip_vlans)
  }
};
```

Then set its token:

```bash
pulumi config set --secret --path 'tokens:my_new_device' "$(uapi-token get my_new_device)"
```

That's it. No new provider block, no new module block, no new resource definitions. The ComponentResource expands the device config into the full resource tree.

### Retiring a device

```typescript
// In src/inventory.ts:
// my_device: { ... } ← just delete this entry
```

Preview will show all resources for that device marked for deletion. If you want a "graceful" retirement (keep the config but don't touch it), set `enabled: false` instead.

## Firewall policy

`src/policy.ts` defines firewall intent as plain data:

- **`TRUSTED_VLANS`**: config, lan, home, work, qm → input=ACCEPT, forward=ACCEPT
- **`BAILEY_VLANS`**: k8s, kubernetes, lab → input=DROP, forward=DROP
- **`ISOLATED_VLANS`**: guest, iot, lights*, audio*, video* → input=DROP, forward=DROP
- **Forwardings**: "home→device VLANs" (HA control), "lan→video_moat", "lan/home→AV primaries", "trusted/bailey/isolated→wan"
- **Rules**: ICMP from trusted, DHCP/DNS/NTP from everywhere, DROP for INPUT on isolated zones

All keyed by **device name**, not role. Devices absent from `POLICY` (like Drawbridge) get zero firewall resources.

## Critical OpenWrt facts (carried from the original refactor)

**C1.** Stock `lan`/`wan` sections must be adopted or creates will 422. Use `adopt.interfaces` / `adopt.firewall_zones` / `adopt.dhcp_servers`.

**C2.** MoatNet's eth4 must stay untagged VLAN 1 (`eth4:u*`), or the box locks itself out.

**C4.** Every INPUT-only zone (bailey + isolated) needs DNS/NTP accepts, or clients get a lease they can't resolve.

**H1.** A `match = { srcZone: "x" }` rule without `destZone` lands in INPUT chain, not FORWARD. Don't rely on implicit FORWARD placement.

**Drawbridge:** Single eth0 port must carry untagged VLAN 1 (management), or the AP self-locks. All client VLANs are tagged. Client VLANs have no IP (only DHCP clients do), so they attach straight to WiFi SSIDs via `proto=none` passthrough interfaces.

## Secrets

Tokens are stored in Pulumi config (encrypted by `PULUMI_CONFIG_PASSPHRASE`):

```bash
pulumi config set --secret --path 'tokens:moatnet' "..."
pulumi config get --secret tokens:moatnet        # retrieve (requires passphrase)
pulumi config ls --all                            # list all (masked if secret)
```

The stack YAML file (`~/.pulumi/stacks/moatnet/bench.json` for local backend) is encrypted at rest and never decrypted to disk when `--secret` is used.

## Per-device targeting

```bash
# Create/update only drawbridge's resources
npm run build
export PULUMI_CONFIG_PASSPHRASE="..."
pulumi up --target 'urn:pulumi:bench::moatnet::moat:device:OpenwrtDevice::drawbridge'

# Or a specific resource within a device
pulumi up --target 'urn:pulumi:bench::moatnet::moat:device:OpenwrtDevice::drawbridge::uapi:index:NetworkInterface::lan'
```

## Testing role validation

Role validation is advisory (never affects behavior). To test it:

```bash
npx ts-node src/roles.test.ts
```

## Monitoring and debugging

```bash
# Full resource list + types
pulumi stack --show-all

# Export resource state as JSON
pulumi export > stack-export.json

# Destroy everything
pulumi destroy

# Destroy only one device
pulumi destroy --target 'urn:pulumi:bench::moatnet::moat:device:OpenwrtDevice::drawbridge'
```

## Future: non-OpenWrt platforms

To add a Mikrotik or Vyatta device module:

1. Create `src/device-mikrotik.ts` with a `MikrotikDevice` ComponentResource
2. Add a new provider alias in `index.ts` (e.g., `providers: { mikrotik: mkt_provider }`)
3. Add device entries to `INVENTORY` with `platform: "mikrotik"`
4. Consume the same `policy.ts` (zones/forwardings/rules are vendor-neutral)

No changes to `vlans.ts` or `policy.ts` needed — they're the stable interface.

## References

- [openwrt-iac/uapi provider](https://github.com/openwrt-iac/terraform-provider-uapi)
- [Pulumi TypeScript SDK](https://www.pulumi.com/docs/reference/pkg/nodejs/pulumi/pulumi/)
- [Pulumi ComponentResource](https://www.pulumi.com/docs/concepts/resources/#autonaming)
- `MoatNet.csv` — source of VLAN definitions (now typed in `src/vlans.ts`)
- `plans/net-review.md` — original defect findings (all carry forward to Pulumi)
- `plans/pulumi-migration.md` — full migration plan + decision history
