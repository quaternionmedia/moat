# MoatNet Configuration Review & Remediation Plan

## Context

The bootstrap config in `/root/moat/net/` validates (`tofu validate` passes) but
**validation only checks HCL syntax and provider schema — not OpenWrt semantics.**

Reviewing against the uapi provider guides
([firewall-rules](https://github.com/openwrt-iac/terraform-provider-uapi/blob/main/docs/guides/firewall-rules.md),
[adopting-named-sections](https://github.com/openwrt-iac/terraform-provider-uapi/blob/main/docs/guides/adopting-named-sections.md))
surfaces **4 critical defects that will fail the first apply or lock you out of
the router**, plus functional gaps that would leave the network non-working.

Honest summary: the config is a reasonable skeleton, but it is **not safe to
apply as written**.

**Target is a bench unit** (confirmed). That changes severity, not the fix list:
lockouts are recoverable via factory reset, so we can iterate directly on
hardware instead of doing a careful live-router import dance. C1 still breaks
the apply regardless of bench vs. live.

---

## CRITICAL — will fail apply or cause lockout

### C1. `lan` / `wan` named-section collisions → first apply fails partway

Every stock OpenWrt box ships `config interface 'lan'`, `config zone 'lan'`,
`config zone 'wan'`, and `config dhcp 'lan'`. The adoption guide is explicit:

> You cannot *create* a section whose name already exists — that returns `422`.

Our config tries to **create** all of these:

| Resource | `id` | Collides with stock section |
|---|---|---|
| `uapi_network_interface.moatnet["lan"]` | `lan` | `config interface 'lan'` |
| `uapi_firewall_zone.trusted["lan"]` | `lan` | `config zone 'lan'` |
| `uapi_firewall_zone.wan` | `wan` | `config zone 'wan'` |
| `uapi_dhcp_server.moatnet["lan"]` | `lan` | `config dhcp 'lan'` |

Apply will 422 on these while **having already created other zones** — leaving the
firewall in a half-built state. Fix: `tofu import` each stock section first.

### C2. Bridge VLAN ports are placeholders + no untagged port → lockout

> **Bench unit:** recoverable via factory reset, but still blocks a working
> apply until real port names are supplied.

`var.moatnet_trunk_ports = ["eth0:t", "eth1:t"]` is applied to **all 27 VLANs**, and
nothing is untagged anywhere.

Two failures stack:
1. `eth0`/`eth1` are almost certainly not the real port names (typical DSA boxes use
   `lan1`–`lan4`, `wan`).
2. Creating `bridge-vlan` sections makes netifd enable **`vlan_filtering` on `br-lan`**.
   With filtering on and **no port carrying an untagged PVID**, every access port
   stops passing untagged traffic — including the one your laptop is plugged into.

This is a hard lockout requiring serial console or failsafe mode. Needs real port
names and at least one untagged management port before any apply.

### C3. Moving `lan` onto `br-lan.3` drops management mid-apply

> **Bench unit:** low risk — just re-plug or reset. Keep the ordering fix anyway
> so the same config is safe when it reaches real hardware.

Stock `lan` sits on the untagged `br-lan`. Our config puts it on `br-lan.3`
(VLAN 3). Even after importing `lan` (C1), applying that device change while
connected over it severs the session mid-apply.

Management must move to the `config` VLAN (1) deliberately, on a port that is
untagged for VLAN 1, verified reachable *before* `lan` is retagged.

### C4. No DNS rule → every isolated/bailey client gets a lease and cannot resolve

`bailey` and `isolated` zones set `input = "DROP"`. We allow **only** DHCP
(udp 67/68). Port 53 to the router is never allowed, but the router *is* the
resolver handed out by DHCP.

Result: guest, iot, lab, k8s, kubernetes, and all 15 lighting/audio/video VLANs
get an address and then **resolve nothing**. Needs an ACCEPT for tcp+udp 53
(and 5353 if mDNS is wanted) on every zone with `input = DROP`.

---

## HIGH — functionally wrong

### H1. `drop_lateral_isolated` does not block lateral movement (and may break DHCP)

```hcl
match = { src_zone = each.key }   # no dest_zone
```

Per the firewall guide, a rule with `src_zone` and no `dest_zone` lands in the
**INPUT chain** — traffic *to the router*, not between zones. So this rule:

- does **not** do what its name and comment claim,
- is redundant with the zone's own `input = "DROP"`,
- and is a blanket DROP on router-bound traffic that, if fw4 emits it before
  `allow_dhcp`, **breaks DHCP**. Terraform guarantees no ordering between
  sibling resources.

Lateral movement is already blocked by `forward = "DROP"` plus the absence of
inter-zone forwardings. **Delete this rule.**

### H2. Home Assistant can control nothing

`home` (VLAN 4) is trusted, but zone `forward = "ACCEPT"` governs only
**intra-zone** traffic. Inter-zone requires a `uapi_firewall_forwarding`, and we
created only `*_to_wan`.

So HA on `home` cannot reach `iot`, `lights_*`, `audio_*`, or `video_*` — the
entire point of the VLAN. Same problem for viewing Frigate (`video_moat`) from
`lan`. Needs explicit forwardings, ideally narrowed to the actual control
protocols.

### H3. Drawbridge is an access point that broadcasts nothing

There is not a single `uapi_wireless_device` or `uapi_wireless_interface` in the
config. We provision VLANs and IPs on the AP but define **no SSIDs**, so no
client can associate. `guest` in particular wants `isolate = true`.

### H4. Drawbridge exposes management on every client VLAN

`interfaces.tf` gives Drawbridge a static `.2` on **every** VLAN in
`drawbridge_vlans` — including `guest` and `iot`. An untrusted guest can reach
the AP's management stack directly.

An AP bridging tagged VLANs needs **one** management IP (on `config`), with
`proto = "none"` on client VLANs.

### H5. Drawbridge has no gateway or DNS

No `gateway`/`dns` on any Drawbridge interface, so the AP itself cannot reach
the internet for NTP or package updates. Its management interface needs
`gateway` + `dns` pointing at MoatNet.

---

## MEDIUM

| # | Finding | Fix |
|---|---|---|
| M1 | `uapi_firewall_defaults` unmanaged — global policy, `syn_flood`, `drop_invalid`, `flow_offloading` all left at whatever the box has | Add the resource, set explicitly; `flow_offloading` matters for WAN throughput |
| M2 | No NTP (123) allow for `input=DROP` zones — clock drift breaks TLS and scheduled light/Halloween shows | Add NTP accept, or hand out an upstream NTP server via DHCP option |
| M3 | `dhcp.tf` comment says `config` is excluded from DHCP; the code includes it (`k != "vwan"` only) | Reconcile comment and code |
| M4 | CSV calls `lights`/`audio`/`video` "Unrestricted", config isolates them to WAN-only | Confirm intent (see Q1) |
| M5 | No mDNS/SSDP reflection — HA discovery, AirPlay, Chromecast all dead across VLANs | Add `umdns`/avahi reflector, or accept and use static IPs |
| M6 | No IPv6: `ip6assign` unset on every interface, `uapi_dhcp_odhcpd` unmanaged | Set `ip6assign = 60` on delegated VLANs, or explicitly disable v6 |
| M7 | `.terraform.lock.hcl` is gitignored (`.gitignore:7`) | **Remove that line and commit the lock file** — it pins provider versions for reproducible builds |
| M8 | DHCP `start = 100, limit = 150` on /16 AV VLANs; wastes `.2`–`.99` and caps fleets at 150 | Widen `limit` on /16s; reserve low range for static infra |
| M9 | Local state stores both API tokens in plaintext `.tfstate` | Acceptable for now (gitignored); note before any shared/remote backend |

---

## LOW

- `local.vlan_networks.network` is computed but never referenced — dead code.
- `mtu_fix` on the WAN zone only matters for PPPoE; harmless otherwise.
- VLAN 8 is described as "Public Kubernetes access" but has no
  `uapi_firewall_redirect` — no inbound path exists (see Q5).

---

## Recommended Approach

Fix in dependency order. **Do not apply anything until Phase 1 is done.**

**Phase 1 — make it safe to apply (C1, C2, C3)**
Get real port names (see *Discovering your hardware ports* below), add an
untagged management port, and import stock `lan`/`wan` sections. On a bench unit
the safety net is the reset button — know how to trigger failsafe before starting.

**Phase 2 — make it correct (C4, H1)**
Add DNS/NTP accepts; delete the bogus lateral-drop rule.

**Phase 3 — make it useful (H2, H3, H4, H5)**
Inter-zone forwardings for HA and camera viewing; wireless SSIDs on Drawbridge;
collapse AP addressing to a single management IP.

**Phase 4 — hardening (M1–M9)**
Firewall defaults, IPv6 decision, lock file, pool sizing.

---

## Files to Modify

| File | Changes |
|---|---|
| `variables.tf` | Per-VLAN port membership map; radio/SSID vars; drop dead `network` local |
| `vlans.tf` | Per-VLAN tagged/untagged ports; **skip VLAN 2 entirely** |
| `interfaces.tf` | **`vwan` → standalone `eth0`, not `br-lan.2`**; import-friendly `lan`; AP single mgmt IP + `proto=none` on client VLANs |
| `firewall.tf` | Delete `drop_lateral_isolated`; add DNS/NTP rules, `firewall_defaults`, inter-zone forwardings |
| `dhcp.tf` | Fix comment/code mismatch; pool sizing; DHCP-option NTP/DNS |
| `wireless.tf` | **New** — radios + SSIDs on Drawbridge |
| `.gitignore` | Stop ignoring `.terraform.lock.hcl` |
| `imports.tf` | **New** — `import` blocks for stock `lan`/`wan` sections |

## Reuse

- `local.vlans` / `local.vlan_networks` (`variables.tf`) — keep as the single
  source of truth; all new resources should derive from it, not re-list VLANs.
- Zone tier locals `trusted_vlans` / `bailey_vlans` / `isolated_vlans`
  (`firewall.tf`) — reuse for the new DNS/NTP rules rather than new lists.
- OpenTofu **`import` blocks** (native, v1.5+) — declarative adoption, no
  imperative `tofu import` commands needed.

## Steps

- [ ] Add per-VLAN port membership map to `variables.tf` (table above)
- [ ] Move `vwan` to standalone `eth0`; drop VLAN 2 from `vlans.tf`
- [ ] Rework `vlans.tf` for per-VLAN tagged/untagged ports
- [ ] Add `imports.tf` with import blocks for stock `lan`/`wan` sections
- [ ] Add DNS + NTP accept rules for all `input=DROP` zones (C4)
- [ ] Delete `drop_lateral_isolated` (H1)
- [ ] Add `uapi_firewall_defaults` (M1)
- [ ] Add inter-zone forwardings: `home`→devices, `lan`→`video_moat`,
      `lan`/`home`→A/V primaries, `lan`→`k8s`/`kubernetes`
- [ ] Create `wireless.tf` — 5 SSIDs, guest isolated, IoT hidden + WPA2
- [ ] Collapse Drawbridge to single mgmt IP on `config` + `proto=none` elsewhere
- [ ] Fix `dhcp.tf` comment/code mismatch; widen /16 pools
- [ ] Fix `.gitignore` lock file line; commit lock file

## Verification

Static:
```sh
tofu validate && tofu fmt -check
tofu plan          # expect: imports reconcile clean, no destroy on lan/wan
```

**Apply with a safety net** — OpenWrt's confirm-or-rollback:
```sh
# on the router, before applying:
uci commit && /sbin/reload_config
# keep a second SSH session open; have serial/failsafe ready
```

Post-apply, per VLAN:
```sh
# lease + resolve + egress (catches C4)
nslookup openwrt.org 192.168.6.1 && ping -c1 1.1.1.1
# lateral movement must FAIL from an isolated VLAN
ping -c1 192.168.3.1     # expect timeout
# HA reachability must SUCCEED after H2
ping -c1 10.86.0.50      # from home VLAN
```

## Resolved Decisions

### Physical ports

| Box | Port | Role |
|---|---|---|
| MoatNet | `eth0` | WAN / internet uplink |
| MoatNet | `eth1` | Drawbridge (AP) trunk |
| MoatNet | `eth2` | Keep (trusted) trunk |
| MoatNet | `eth3` | Bailey (semi-trusted) trunk |
| MoatNet | `eth4` | Config / management access port |
| Drawbridge | `eth0` | sole uplink to MoatNet `eth1` |

### Consequence 1 — WAN must leave the bridge (new finding)

The current config puts `vwan` on `br-lan.2`. With `eth0` as a dedicated WAN
port that is wrong: **`eth0` must be a standalone `proto=dhcp` interface, not a
bridge member, and VLAN 2 gets no `bridge-vlan` section at all.**

The CSV's `192.168.2.0/24` for vWAN is then the *upstream* subnet MoatNet's WAN
port receives a lease from (a double-NAT bench setup), not something MoatNet
serves. No DHCP server on it — already correctly excluded.

### Consequence 2 — Drawbridge needs an untagged native VLAN or it self-locks

Drawbridge has exactly one port. If every VLAN on it is tagged, the AP becomes
unreachable the instant the config applies — there is no second port to recover
through.

**Fix:** VLAN 1 (`config`) is **untagged/native** on both `MoatNet eth1` and
`Drawbridge eth0`; client VLANs are tagged. Standard AP-uplink pattern, and
management survives the apply.

### Consequence 3 — the 15 A/V VLANs had no port assigned

The roles given cover `config`, trusted, semi-trusted, AP, and WAN — but the
lighting/audio/video VLANs (10–14, 20–24, 30–34) are wired device fleets that
need a physical home. **Assumption: they live on `eth3` (Bailey)** — the outer
courtyard is where the workshops and stage gear belong. Say the word if they
should be on Keep or a sixth port instead.

### Port / VLAN membership map — MoatNet `br-lan` (eth1–eth4; eth0 excluded)

| VLAN | Name | eth1 Drawbridge | eth2 Keep | eth3 Bailey | eth4 Config |
|---|---|---|---|---|---|
| 1 | config | **untagged** | tagged | tagged | **untagged** |
| 2 | vwan | — *(not bridged; lives on eth0)* | — | — | — |
| 3 | lan | tagged | **untagged** | — | — |
| 4 | home | tagged | tagged | — | — |
| 5 | work | tagged | tagged | — | — |
| 6 | guest | tagged | — | — | — |
| 7 | lab | — | — | **untagged** | — |
| 8 | k8s | — | — | tagged | — |
| 9 | qm | — | tagged | — | — |
| 10–14 | lights_* | — | — | tagged | — |
| 20–24 | audio_* | — | — | tagged | — |
| 30–34 | video_* | — | — | tagged | — |
| 80 | kubernetes | — | — | tagged | — |
| 86 | iot | tagged | — | tagged | — |

Each trunk gets a sensible untagged native VLAN so a plain laptop plugged into
it still works. `eth4` is untagged VLAN 1 only — the guaranteed way back in.

### Port map — Drawbridge `br-lan` (eth0 only)

| VLAN | Name | eth0 |
|---|---|---|
| 1 | config | **untagged** (management) |
| 3 / 4 / 5 / 6 / 86 | lan, home, work, guest, iot | tagged |

Drawbridge addressing: **one** IP, `192.168.1.2/24` on `config`, with
`gateway`/`dns` = `192.168.1.1`. All client VLANs `proto = "none"` — bridged to
WiFi, no IP, no management surface. Fixes H4 and H5.

### Wireless (Q3)

| SSID | VLAN | Encryption | Notes |
|---|---|---|---|
| `Lab` | `lan` (3) | WPA2/WPA3 mixed | primary trusted |
| `Lab-home` | `home` (4) | WPA2/WPA3 mixed | Home Assistant + trusted IoT |
| `Lab-work` | `work` (5) | WPA2/WPA3 mixed | |
| `Lab-guest` | `guest` (6) | WPA2/WPA3 mixed | `isolate = true` |
| `Lab-iot` | `iot` (86) | **WPA2 only** | `hidden = true`, 2.4 GHz |

Two notes on this mapping:

- **`Lab` → the `lan` VLAN, not the `lab` VLAN.** VLAN 7 is also called `lab` and
  is a separate wired-only network on Bailey. Five SSIDs map to the five
  wireless VLANs, so `Lab` is the trusted primary. Flagging because the names
  collide.
- **`Lab-iot` is WPA2-only on purpose.** WPA3 and even WPA2/WPA3 mixed mode
  break a lot of cheap IoT hardware. Hidden + WPA2 is the compatible choice.

Passwords come from environment variables (`TF_VAR_wifi_key_*`), never committed.

### Firewall intent (Q2, Q4, Q5)

- **Q2 — yes:** `home` → `iot`, `lights_*`, `audio_*`, `video_*`, one direction.
  A forwarding is directional already; conntrack returns the replies, so HA can
  reach devices and devices cannot initiate back.
- **Q2 — plus:** `lan` → `video_moat` for Frigate viewing.
- **Q4 — default:** the "unrestricted" primaries `lights` / `audio` / `video`
  are reachable from `lan` and `home`; no inbound from the internet, no
  cross-talk to `work` or `qm`.
- **Q5 — default:** `k8s` and `kubernetes` reachable from `lan` only. No WAN
  port forwards until a specific service and port is named.
- **IPv6 — deferred:** no `ip6assign` for the bench build. Revisit before this
  config reaches real hardware (M6).

---

## Assumptions to Confirm

Not blocking — I'll build on these unless corrected:

1. **A/V VLANs sit on `eth3` (Bailey).** No port role was given for the 15
   lighting/audio/video VLANs.
2. **SSID `Lab` maps to the `lan` VLAN (3)**, while the separate `lab` VLAN (7)
   stays wired-only on Bailey.
3. **`Lab-iot` is WPA2-only**, not WPA3 — compatibility with cheap IoT gear.
4. **`eth0` leaves the bridge entirely** and becomes a plain DHCP WAN client;
   VLAN 2 gets no bridge section.
5. **Native untagged VLANs on each trunk** (`eth2`→lan, `eth3`→lab) so a plain
   laptop works on any port.
