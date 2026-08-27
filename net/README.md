# MoatNet — OpenWrt fleet, as OpenTofu

## Layout

```
vlans.tf       VLAN catalog (from MoatNet.csv) — vendor-neutral
policy.tf      Firewall trust tiers + forwardings — vendor-neutral, keyed by device NAME
inventory.tf   THE device list — hardware facts (ports, VLANs, wireless, adoption)
devices.tf     Composes inventory + policy into module inputs; the module block itself
providers.tf   One uapi provider instance per OpenWrt device
imports.tf     Adopts stock lan/wan/radio sections instead of colliding with them
variables.tf   Secrets only (device_tokens, wireless_keys)
outputs.tf
modules/openwrt-device/   Generic factory: creates whatever its input maps describe
```

## Adding a device

Add an entry to `devices` in `inventory.tf`. No new resource blocks, no new
provider block, no new module block.

```hcl
"gatehouse" = {
  endpoint   = "https://192.168.1.3/api/v3"
  role       = "ap"                                    # advisory only
  vlan_ports = { config = ["eth0:u*"], lan = ["eth0:t"] }
  ip_vlans   = { config = { ipaddrs = ["192.168.1.3"], gateway = "192.168.1.1" } }
  dhcp_vlans = []
}
```

Add its token to `TF_VAR_device_tokens`. That's the whole change.

- Omit `ip_vlans` entirely and every `vlan_ports` key gets a real IP at the
  VLAN's catalog gateway address — the mechanical default for a router.
- Give `ip_vlans` explicit keys (like above) and only those VLANs get an IP;
  everything else in `vlan_ports` still gets a bodiless `proto=none`
  interface (needed for wireless/bridging to attach to), just no address.
- Want this device to run firewall policy? Add a same-named key to
  `local.policy` in `policy.tf`. Nothing keys off `role` — an entry simply
  existing (or not) in `policy` is what turns firewall resources on.
- `platform` defaults to `"openwrt"` and is the seam for a future non-OpenWrt
  device — see *Adding a non-OpenWrt device* below. Leave it alone for now.

## Targeting one device

```sh
tofu plan  -target='module.openwrt["moatnet"]'
tofu apply -target='module.openwrt["moatnet"]'
```

Ordering matters here regardless of targeting: Drawbridge's management IP
lives on a VLAN MoatNet serves, so MoatNet must be applied first.

## Retiring a device

Two applies, not one — a provider instance can't be removed from config while
resources still reference it, so the module and the provider can't drop the
same device in the same plan (see `plans/modular-refactor.md`, finding F3):

```sh
# 1. Set enabled = false on the device in inventory.tf, apply.
#    Its module instance disappears; the provider instance survives.
tofu apply
# 2. Remove the device's entry from inventory.tf entirely.
tofu apply
```

## Adding a non-OpenWrt device (future)

Module `source` is resolved at `init` time and can't be an expression, so a
second platform isn't a per-device switch inside `openwrt-device` — it's one
more module block, filtered by `platform`, added beside it in `devices.tf`:

```hcl
module "mikrotik" {
  for_each = { for k, v in var.devices : k => v if v.platform == "mikrotik" && v.enabled }
  source   = "./modules/mikrotik-device"
  vlans    = local.vlans              # same catalog
  firewall = try(local.policy[each.key], null) # same policy
}
```

Nothing above this line changes. This only stays true as long as `vlans.tf`
and `policy.tf` keep expressing VLANs and firewall intent as plain data
(VLAN names, zone names) rather than uapi resource shapes — that discipline,
not a plugin system, is what makes a second vendor additive instead of a
rewrite.

## Bootstrap (one-time, per physical device)

```sh
ssh root@<device-ip>
opkg update && opkg install uapi
uapi-token create --name tofu
```

Note the token and endpoint; add them to `TF_VAR_device_tokens` /
`inventory.tf`. uapi ships a self-signed cert (`insecure = true` handles that
for now — install a real one via `luci-app-acme` before this leaves the
bench).

## Design history

Full rationale, verified OpenTofu constraints (provider `for_each`, `import`
being root-only, etc.), and the original firewall/topology review live in
`plans/`.
