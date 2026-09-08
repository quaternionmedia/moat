# Migrate to Pulumi

## Context

Goal: a cleaner, more programmatic interface than HCL. Pulumi is a good fit —
`policy.tf`'s `merge([...]...)` splat gymnastics become ordinary typed
functions.

But the **specific package named** (`joneshf/openwrt` v0.0.20) is the same
provider this project evaluated and rejected in its very first session, for
the same reason it would break things now.

---

## ⚠️ Blocking finding: the named package cannot express this network

`joneshf/openwrt` v0.0.20 exposes exactly **13 resources**. Verified against
the live Pulumi registry nav:

```
DhcpDhcp  DhcpDnsmasq  DhcpDomain  DhcpHost  DhcpOdhcpd
NetworkDevice  NetworkGlobals  NetworkInterface
NetworkSwitch  NetworkSwitchVlan
SystemSystem  WirelessWifiDevice  WirelessWifiIface
```

**There are no firewall resources of any kind.** Mapping the current config
(counts read straight out of the live OpenTofu config):

| Current (`openwrt-iac/uapi`) | Count | `joneshf/openwrt` | Status |
|---|---:|---|---|
| `network_interface` | 32 | `NetworkInterface` | ✅ maps |
| `dhcp_server` | 25 | `DhcpDhcp` | ✅ maps |
| `dhcp_dnsmasq` | 1 | `DhcpDnsmasq` | ✅ maps |
| `wireless_device` | 2 | `WirelessWifiDevice` | ✅ maps |
| `wireless_interface` | 9 | `WirelessWifiIface` | ✅ maps |
| `network_bridge_vlan` | 31 | `NetworkSwitchVlan` | ⚠️ **wrong mechanism** |
| `firewall_zone` | 26 | — | ❌ **none** |
| `firewall_forwarding` | 50 | — | ❌ **none** |
| `firewall_rule` | 70 | — | ❌ **none** |
| `firewall_defaults` | 1 | — | ❌ **none** |

**147 resources have no equivalent. 31 more need a mechanism that likely
doesn't exist on the hardware.** Only 69 of 247 migrate cleanly.

### What that means concretely

Everything the firewall review fixed would be lost, and not recoverable by
writing more Pulumi code:

- Guest and IoT isolation (`input=DROP`, WAN-egress-only)
- Home Assistant's one-way reach into lighting/audio/video/IoT
- The DNS/NTP accepts that stop isolated clients from getting a lease they
  can't resolve with (defect C4)
- `lan` → Frigate camera access
- SYN-flood protection, `drop_invalid`, flow offloading

### Two further problems

**`NetworkSwitchVlan` is not a substitute for `network_bridge_vlan`.** It maps
to uci `config switch_vlan` — the legacy *swconfig* stack. OpenWrt 21.02+ moved
to DSA, where `switch_vlan` sections do not exist at all. On modern hardware
this resource has nothing to configure, so the entire 27-VLAN topology has no
expression.

**The auth model is a security downgrade.** uapi uses a scoped bearer token
(`uapi-token create`). `joneshf/openwrt` uses LuCI JSON-RPC with the device's
**root username and password**, which would need `luci-mod-rpc` installed and
root credentials in Pulumi config.

Also worth knowing: v0.0.20 was published April 2023 and has had no release
since.

---

## ✅ The good news: the actual goal doesn't require that package

Pulumi bridges **any** Terraform provider, and the current one is eligible —
verified present on the Terraform registry as `openwrt-iac/uapi` v3.0.1:

```sh
pulumi package add terraform-provider openwrt-iac/uapi
```

This is the *same mechanism* `joneshf/openwrt` itself uses — its own registry
readme says to install it via `pulumi package add terraform-provider
joneshf/openwrt`. Neither is a "native" Pulumi provider; both are dynamically
bridged. **So choosing uapi costs nothing in Pulumi-nativeness.**

Result: full Pulumi programmability, all 247 resources intact, scoped-token
auth retained.

---

## Recommended Approach — Option A

Pulumi (TypeScript or Python) + bridged `openwrt-iac/uapi`.

The refactor already did the hard architectural work; this is largely a
transliteration of a clean design into a better language.

```
net/
├── Pulumi.yaml
├── Pulumi.<stack>.yaml        # config + secrets
├── src/
│   ├── vlans.ts               # VLAN catalog — plain typed data
│   ├── policy.ts              # tiers/forwardings/rules as real functions
│   ├── inventory.ts           # device list
│   ├── device.ts              # OpenwrtDevice ComponentResource
│   └── index.ts               # instantiate per device
└── (all *.tf and modules/ deleted — recoverable from git)
```

**Where Pulumi genuinely improves on the HCL:**

| HCL pain today | Pulumi |
|---|---|
| `merge([for ...]...)` splat to flatten SSID×radio | `.flatMap()` |
| `try(local.policy[k], {})` for absent keys | optional types, real null-safety |
| Type errors only at `tofu validate` | compile-time in the editor |
| `check` block for advisory `role` validation | a plain function + unit test |
| Provider `for_each` + F3 subset trap | an ordinary `for` loop over devices |
| VLAN names are bare strings; a typo is a runtime error | `as const` catalog → `VlanName` literal union, typos fail to compile |

The `for_each` provider constraint (finding F3 in the refactor plan — provider
and module iteration must differ, retiring a device takes two applies) simply
**disappears**: in Pulumi a provider is just an object you construct in a loop.

### Imports / adoption

Nothing is deployed (state is empty), so there is no state migration. But
stock OpenWrt sections still need adopting or creates will 422:

| Device | Sections |
|---|---|
| moatnet | `interface lan`, `interface wan`, `zone lan`, `zone wan`, `dhcp lan` |
| drawbridge | `interface lan`, possibly `radio0`/`radio1` |

In Pulumi this is the `import` resource option, which is *per-resource and
declarative* — closer to the intent than OpenTofu's root-only `import` blocks
(which forced `imports.tf` to live apart from the module that owns the
resources):

```ts
new uapi.NetworkInterface("lan", {...}, { import: "lan", provider: p });
```

---

## Option B — proceed with `joneshf/openwrt` anyway

Only viable if the firewall is managed outside Pulumi (hand-written
`/etc/config/firewall`, a separate OpenTofu stack, or Ansible). Would also
need confirmation the hardware is old enough to use swconfig rather than DSA.

Not recommended, but a legitimate choice if the intent is "Pulumi manages
interfaces/DHCP/WiFi only."

---

## Files to Modify

| Path | Action |
|---|---|
| `Pulumi.yaml`, `Pulumi.<stack>.yaml` | **New** — project + stack config |
| `src/vlans.ts` | **New** — port of `vlans.tf` catalog |
| `src/policy.ts` | **New** — port of `policy.tf` tiers |
| `src/inventory.ts` | **New** — port of `inventory.tf` |
| `src/device.ts` | **New** — `ComponentResource`, port of `modules/openwrt-device/` |
| `src/index.ts` | **New** — per-device instantiation + imports |
| `package.json`, `tsconfig.json` | **New** |
| `.gitignore` | Add `node_modules/`, `Pulumi.*.yaml` secrets stay encrypted so may be committed |
| `README.md` | Rewrite for Pulumi workflow |
| `*.tf`, `modules/`, `.terraform*` | **Delete** (recoverable from git) |

## Reuse

The current config is the specification — the design carries over directly:

- `vlans.tf` — the VLAN catalog, already vendor-neutral plain data
- `policy.tf` — `trusted/bailey/isolated` tiers, `ha_device_vlans`,
  `av_primaries`; already expressed as data, not resource shapes
- `inventory.tf` — port maps, `ip_vlans`/`dhcp_vlans` null-default semantics
- `modules/openwrt-device/` — resource-factory shape maps 1:1 onto a
  `ComponentResource`
- `devices.tf` — the mechanical derivations (passthrough interfaces from
  `vlan_ports` minus `ip_vlans`; DHCP pool sizing by prefix)
- `plans/net-review.md` — **the C1–C4/H1–H5 findings still apply.** The
  hard-won ones (import-or-422, untagged management port, DNS/NTP accepts,
  `src_zone`-only rules hitting INPUT not FORWARD) must survive the port.

## Steps

*(assumes Option A; pending Q1)*

- [ ] `pulumi login --local`; scaffold TS project; set `PULUMI_CONFIG_PASSPHRASE`
- [ ] `pulumi package add terraform-provider openwrt-iac/uapi`; **verify the
      generated SDK's resource/property names against the table above**
- [ ] Port VLAN catalog as an `as const` object (see "Typing the catalog")
- [ ] Port policy tiers as typed functions
- [ ] Port inventory incl. `ip_vlans`/`dhcp_vlans` null-default semantics
- [ ] Build `OpenwrtDevice` ComponentResource
- [ ] Wire per-device providers (plain loop — no `for_each` constraint)
- [ ] Add `import` options for stock sections
- [ ] Move secrets to `pulumi config set --secret`
- [ ] `pulumi preview` parity check against the 247-resource OpenTofu plan
- [ ] Port the advisory `role` check as a unit-testable function
- [ ] Delete `*.tf`, `modules/`, `.terraform*`; rewrite `README.md` for Pulumi

## Verification

```sh
pulumi preview                      # resource count parity vs OpenTofu's 247
pulumi preview --diff               # confirm imports show no replace/destroy
pulumi preview --target 'urn:...::moatnet::**'   # per-device targeting
```

Acceptance:
1. Preview totals match the OpenTofu plan per device and per resource type
   (moatnet: 26 zones / 50 forwardings / 70 rules / 25 DHCP; drawbridge:
   9 SSID×band / 2 radios / 6 bridge VLANs).
2. Adopted sections preview as *no-ops*, never destroy/create.
3. Adding a scratch device stays a data-only change.

---

## Resolved Decisions

| # | Decision |
|---|---|
| Q1 | **Option A** — Pulumi with `openwrt-iac/uapi` bridged via `pulumi package add terraform-provider`. Nothing lost. |
| Q2 | **TypeScript** (node v24.18.1, npm 11.12.1 present). |
| Q3 | **Local backend** — `pulumi login --local`. |
| Q4 | **Replace** — delete `*.tf` + `modules/`. Verified all are committed to git, so the reference implementation stays recoverable via history. |

---

## Implementation Detail

### Typing the catalog (why not parse the CSV)

Tempting to parse `MoatNet.csv` at build time, but that produces `string`
keys and throws away the main reason to use TypeScript. A hand-written `as
const` object gives a literal union instead:

```ts
export const vlans = {
  config: { id: 1, cidr: "192.168.1.0/24" },
  lan:    { id: 3, cidr: "192.168.3.0/24" },
  // ...
} as const;

export type VlanName = keyof typeof vlans;   // "config" | "lan" | ...
```

Every VLAN reference in policy, inventory and port maps is then checked at
compile time — `"lights_studo"` becomes a red squiggle instead of a 422 at
apply. The CSV stays as the human-facing source document.

### Provider per device

The F3 `for_each` trap is simply gone — a provider is an object in a loop:

```ts
for (const [name, dev] of Object.entries(inventory)) {
  const provider = new uapi.Provider(`uapi-${name}`, {
    endpoint: dev.endpoint,
    token:    cfg.requireSecret(`token_${name}`),
    insecure: true,
  });
  new OpenwrtDevice(name, { ...dev, vlans, policy: policy[name] },
                    { providers: { uapi: provider } });
}
```

Children of the `ComponentResource` inherit the provider through `{ parent:
this }`. Retiring a device is deleting a map entry — one `pulumi up`, no
two-step dance.

### SDK naming — VERIFIED against the generated SDK ✅

Class names were as predicted (`NetworkInterface`, `FirewallZone`,
`NetworkBridgeVlan`, ...), and all firewall resources are present. But the
inference was **wrong in two ways** that would have broken every resource:

**1. The Terraform `id` field is renamed `<resource>Id`** — it would collide
with Pulumi's built-in `id`:

| Terraform | TypeScript |
|---|---|
| `uapi_network_interface.id` | `networkInterfaceId` |
| `uapi_firewall_zone.id` | `firewallZoneId` |
| `uapi_network_bridge_vlan.id` | `networkBridgeVlanId` |
| `uapi_firewall_rule.id` | `firewallRuleId` |
| `uapi_dhcp_server.id` | `dhcpServerId` |
| `uapi_wireless_device.id` | `wirelessDeviceId` |

(`firewallDefaults` and `dhcpDnsmasq` take no id — matches TF, where it's
read-only on those.)

**2. List-typed fields are pluralized.** `FirewallRuleMatch` is:

```
srcZone destZone protos srcIps destIps srcPorts destPorts dscp mark family
```

So TF `proto = ["tcp","udp"]` / `dest_port = ["53"]` becomes
`protos: ["tcp","udp"]` / `destPorts: ["53"]`. Likewise `dhcpDnsmasq.server`
→ `servers`.

Verified field lists per resource:

```
networkInterface   proto device ipaddrs netmask gateway dns ip6assign ... networkInterfaceId
networkBridgeVlan  device vlan ports networkBridgeVlanId
firewallZone       name networks input forward outputPolicy masq mtuFix family firewallZoneId
firewallForwarding src dest enabled family firewallForwardingId
firewallDefaults   input outputPolicy forward dropInvalid synFlood synfloodRate
                   synfloodBurst tcpSyncookies flowOffloading flowOffloadingHw
dhcpServer         interface start limit leasetime ignore dhcpOptions ... dhcpServerId
dhcpDnsmasq        domain domainneeded boguspriv rebindProtection expandhosts
                   authoritative servers ...
wirelessDevice     type band htmode channel country txpower wirelessDeviceId
wirelessInterface  device network mode ssid encryption key hidden isolate wirelessInterfaceId
```

### Secrets

```sh
pulumi config set --secret --path 'tokens.moatnet'    <uapi-token>
pulumi config set --secret --path 'tokens.drawbridge' <uapi-token>
pulumi config set --secret --path 'wifiKeys.Lab'      <passphrase>
```

Structured config keeps the shape of today's `TF_VAR_device_tokens` map.
Local backend still encrypts secrets (passphrase-based) — `PULUMI_CONFIG_PASSPHRASE`
will need to be set.

### Imports

Use the per-resource `import` option; remove it once the first `up` succeeds:

```ts
new uapi.NetworkInterface("lan", {...}, { import: "lan", parent: this });
```

---

## Carry-over risks (unchanged by the language switch)

These are hardware/OpenWrt facts, not OpenTofu artifacts — they must survive
the port. Full detail in `plans/net-review.md`:

- **C1** stock `lan`/`wan`/`zone`/`dhcp` sections must be imported or creates 422
- **C2** `eth4` must stay untagged VLAN 1, or the box locks itself out
- **C4** DNS + NTP accepts on every `input=DROP` zone
- **H1** a rule with `srcZone` and no `destZone` lands in INPUT, not FORWARD
- Drawbridge's single port needs untagged native VLAN 1, or the AP self-locks
- Check `uci show wireless` for pre-existing `radio0`/`radio1` before first up
