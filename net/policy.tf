# Vendor-neutral network policy: which VLANs trust each other, and the
# router's global settings. Expressed as plain data (VLAN names, zone names)
# — never a uapi resource shape — so a second platform module could consume
# this unchanged. Keyed by device NAME, not role: role stays advisory only.

locals {
  # ── Trust tiers ───────────────────────────────────────────────────────────
  trusted_vlans = toset(["config", "lan", "home", "work", "qm"])
  bailey_vlans  = toset(["k8s", "kubernetes", "lab"])
  isolated_vlans = toset([
    "guest",
    "iot",
    "lights", "lights_moat", "lights_studio", "lights_halloween", "lights_home",
    "audio", "audio_moat", "audio_studio", "audio_halloween", "audio_home",
    "video", "video_moat", "video_studio", "video_halloween", "video_home",
  ])
  no_input_accept_vlans = setunion(local.bailey_vlans, local.isolated_vlans)

  # Home Assistant reaches its devices; devices cannot reach back (a
  # forwarding is directional — conntrack handles the replies).
  ha_device_vlans = toset([
    "iot",
    "lights", "lights_moat", "lights_studio", "lights_halloween", "lights_home",
    "audio", "audio_moat", "audio_studio", "audio_halloween", "audio_home",
    "video", "video_moat", "video_studio", "video_halloween", "video_home",
  ])

  # "Unrestricted" primaries: reachable from lan + home (Q4 default).
  av_primaries = toset(["lights", "audio", "video"])

  # ── MoatNet: the router's policy ─────────────────────────────────────────
  moatnet_zones = merge(
    { wan = { networks = ["wan"], input = "DROP", forward = "DROP", masq = true, mtu_fix = true } },
    { for v in local.trusted_vlans : v => { networks = [v], input = "ACCEPT", forward = "ACCEPT" } },
    { for v in local.bailey_vlans : v => { networks = [v], input = "DROP", forward = "DROP" } },
    { for v in local.isolated_vlans : v => { networks = [v], input = "DROP", forward = "DROP" } },
  )

  moatnet_forwardings = merge(
    { for v in setunion(local.trusted_vlans, local.bailey_vlans, local.isolated_vlans) :
      "fwd_${v}_wan" => { src = v, dest = "wan" }
    },
    { for v in local.ha_device_vlans : "fwd_home_${v}" => { src = "home", dest = v } },
    { fwd_lan_video_moat = { src = "lan", dest = "video_moat" } },
    { for p in local.av_primaries : "fwd_lan_${p}" => { src = "lan", dest = p } },
    { for p in local.av_primaries : "fwd_home_${p}_av" => { src = "home", dest = p } },
    { for v in toset(["k8s", "kubernetes"]) : "fwd_lan_${v}" => { src = "lan", dest = v } },
  )

  moatnet_rules = merge(
    { for v in local.trusted_vlans : "ping_${v}" => {
      target = "ACCEPT"
      match  = { src_zone = v, proto = ["icmp"] }
    } },
    { for v in setunion(local.trusted_vlans, local.no_input_accept_vlans) : "dhcp_${v}" => {
      target = "ACCEPT"
      match  = { src_zone = v, proto = ["udp"], src_port = ["68"], dest_port = ["67"] }
    } },
    { for v in local.no_input_accept_vlans : "dns_${v}" => {
      target = "ACCEPT"
      match  = { src_zone = v, proto = ["tcp", "udp"], dest_port = ["53"] }
    } },
    { for v in local.no_input_accept_vlans : "ntp_${v}" => {
      target = "ACCEPT"
      match  = { src_zone = v, proto = ["udp"], dest_port = ["123"] }
    } },
  )

  moatnet_defaults = {
    input              = "DROP"
    output_policy      = "ACCEPT"
    forward            = "DROP"
    drop_invalid       = true
    syn_flood          = true
    synflood_rate      = 25
    synflood_burst     = 50
    tcp_syncookies     = true
    flow_offloading    = true
    flow_offloading_hw = false # ponytail: enable if hardware NAT-offload is confirmed present
  }

  moatnet_dnsmasq = {
    domain            = "moat.local"
    domainneeded      = true
    boguspriv         = true
    rebind_protection = true
    expandhosts       = true
    authoritative     = true
  }

  # Keyed by device name, not role — devices.tf does a plain lookup with a
  # {} default, so an AP (or any future device absent here) gets no firewall
  # resources without ever branching on `role`.
  policy = {
    moatnet = {
      zones       = local.moatnet_zones
      forwardings = local.moatnet_forwardings
      rules       = local.moatnet_rules
      defaults    = local.moatnet_defaults
      dnsmasq     = local.moatnet_dnsmasq
    }
  }
}
