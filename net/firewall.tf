# Firewall zones and baseline rules on MoatNet
#
# Zone groupings follow a "trust the keep, guard the moat" policy:
#   - Trusted zones (lan, home, work, qm, config): full outbound, no inbound from untrusted
#   - Semi-trusted (k8s, kubernetes, lab):          outbound only
#   - Isolated (guest, iot, lights_*, audio_*, video_*): outbound to WAN only
#   - Infrastructure (vwan):                        the WAN zone

# ── WAN zone (the outer moat) ─────────────────────────────────────────────────

resource "uapi_firewall_zone" "wan" {
  provider = uapi.moatnet
  id       = "wan"
  name     = "wan"
  network  = [uapi_network_interface.wan.id]
  input    = "DROP"
  forward  = "DROP"
  masq     = true
  mtu_fix  = true
}

# Global firewall policy (was previously left at whatever the box shipped with)
resource "uapi_firewall_defaults" "moatnet" {
  provider           = uapi.moatnet
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

# ── Trusted zones (the keep) ──────────────────────────────────────────────────

locals {
  trusted_vlans = toset(["config", "lan", "home", "work", "qm"])
}

resource "uapi_firewall_zone" "trusted" {
  for_each = local.trusted_vlans
  provider = uapi.moatnet

  id      = each.key
  name    = each.key
  network = [uapi_network_interface.moatnet[each.key].id]
  input   = "ACCEPT"
  forward = "ACCEPT"
}

# ── Semi-trusted zones (the outer bailey) ─────────────────────────────────────

locals {
  bailey_vlans = toset(["k8s", "kubernetes", "lab"])
}

resource "uapi_firewall_zone" "bailey" {
  for_each = local.bailey_vlans
  provider = uapi.moatnet

  id      = each.key
  name    = each.key
  network = [uapi_network_interface.moatnet[each.key].id]
  input   = "DROP"
  forward = "DROP"
}

# ── Isolated zones (beyond the drawbridge) ────────────────────────────────────
#
# guest, iot, and all AV/lighting VLANs: internet egress only, no lateral movement

locals {
  isolated_vlans = toset([
    "guest",
    "iot",
    "lights", "lights_moat", "lights_studio", "lights_halloween", "lights_home",
    "audio", "audio_moat", "audio_studio", "audio_halloween", "audio_home",
    "video", "video_moat", "video_studio", "video_halloween", "video_home",
  ])
}

resource "uapi_firewall_zone" "isolated" {
  for_each = local.isolated_vlans
  provider = uapi.moatnet

  id      = each.key
  name    = each.key
  network = [uapi_network_interface.moatnet[each.key].id]
  input   = "DROP"
  forward = "DROP"
}

# ── Forwardings ───────────────────────────────────────────────────────────────

# Trusted → WAN
resource "uapi_firewall_forwarding" "trusted_to_wan" {
  for_each = local.trusted_vlans
  provider = uapi.moatnet

  id   = "fwd_${each.key}_wan"
  src  = each.key
  dest = "wan"
}

# Bailey → WAN
resource "uapi_firewall_forwarding" "bailey_to_wan" {
  for_each = local.bailey_vlans
  provider = uapi.moatnet

  id   = "fwd_${each.key}_wan"
  src  = each.key
  dest = "wan"
}

# Isolated → WAN (internet egress, nothing else)
resource "uapi_firewall_forwarding" "isolated_to_wan" {
  for_each = local.isolated_vlans
  provider = uapi.moatnet

  id   = "fwd_${each.key}_wan"
  src  = each.key
  dest = "wan"
}

# ── Baseline rules ────────────────────────────────────────────────────────────

# Allow ICMP echo from trusted zones (the watchmen know their own keep)
resource "uapi_firewall_rule" "allow_ping_trusted" {
  for_each = local.trusted_vlans
  provider = uapi.moatnet

  id     = "ping_${each.key}"
  name   = "allow-ping-${each.key}"
  target = "ACCEPT"
  match = {
    src_zone = each.key
    proto    = ["icmp"]
  }
}

# Allow DHCP on all zones (4-step handshake, no zone-crossing needed)
resource "uapi_firewall_rule" "allow_dhcp" {
  for_each = merge(
    { for k in local.trusted_vlans : k => k },
    { for k in local.bailey_vlans : k => k },
    { for k in local.isolated_vlans : k => k },
  )
  provider = uapi.moatnet

  id     = "dhcp_${each.key}"
  name   = "allow-dhcp-${each.key}"
  target = "ACCEPT"
  match = {
    src_zone  = each.key
    proto     = ["udp"]
    src_port  = ["68"]
    dest_port = ["67"]
  }
}

# Lateral movement from isolated/bailey zones is already blocked: each zone's
# `forward = "DROP"` plus the absence of any inter-zone forwarding IS the
# block. A rule matching only `src_zone` (no `dest_zone`) lands in the INPUT
# chain instead — traffic *to the router*, not between zones. That rule
# (`drop_lateral_isolated`) was redundant with `input = "DROP"` on those zones
# and, being unordered relative to the DHCP/DNS accepts below, risked
# swallowing them. Removed.

# ── DNS + NTP for zones with input=DROP ────────────────────────────────────────
#
# Without this, bailey/isolated clients get a DHCP lease pointing at the
# router as resolver, then can't resolve anything (C4).

locals {
  no_input_accept_vlans = setunion(local.bailey_vlans, local.isolated_vlans)
}

resource "uapi_firewall_rule" "allow_dns" {
  for_each = local.no_input_accept_vlans
  provider = uapi.moatnet

  id     = "dns_${each.key}"
  name   = "allow-dns-${each.key}"
  target = "ACCEPT"
  match = {
    src_zone  = each.key
    proto     = ["tcp", "udp"]
    dest_port = ["53"]
  }
}

resource "uapi_firewall_rule" "allow_ntp" {
  for_each = local.no_input_accept_vlans
  provider = uapi.moatnet

  id     = "ntp_${each.key}"
  name   = "allow-ntp-${each.key}"
  target = "ACCEPT"
  match = {
    src_zone  = each.key
    proto     = ["udp"]
    dest_port = ["123"]
  }
}

# ── Inter-zone forwardings (Q2, Q4, Q5) ─────────────────────────────────────────

locals {
  # Home Assistant reaches its devices; devices cannot reach back (forwarding
  # is directional — conntrack handles the replies).
  ha_device_vlans = toset([
    "iot",
    "lights", "lights_moat", "lights_studio", "lights_halloween", "lights_home",
    "audio", "audio_moat", "audio_studio", "audio_halloween", "audio_home",
    "video", "video_moat", "video_studio", "video_halloween", "video_home",
  ])

  # "Unrestricted" primaries reachable from lan + home (Q4 default).
  av_primaries = toset(["lights", "audio", "video"])
}

resource "uapi_firewall_forwarding" "home_to_devices" {
  for_each = local.ha_device_vlans
  provider = uapi.moatnet

  id   = "fwd_home_${each.key}"
  src  = "home"
  dest = each.key
}

# lan -> video_moat: view Frigate cameras from the trusted network.
resource "uapi_firewall_forwarding" "lan_to_video_moat" {
  provider = uapi.moatnet
  id       = "fwd_lan_video_moat"
  src      = "lan"
  dest     = "video_moat"
}

# lan + home -> the "unrestricted" AV primaries.
resource "uapi_firewall_forwarding" "lan_to_av_primaries" {
  for_each = local.av_primaries
  provider = uapi.moatnet

  id   = "fwd_lan_${each.key}"
  src  = "lan"
  dest = each.key
}

resource "uapi_firewall_forwarding" "home_to_av_primaries" {
  for_each = local.av_primaries
  provider = uapi.moatnet

  id   = "fwd_home_${each.key}_av"
  src  = "home"
  dest = each.key
}

# lan -> k8s / kubernetes: LAN-reachable only, no WAN port forwards (Q5 default).
resource "uapi_firewall_forwarding" "lan_to_k8s" {
  for_each = toset(["k8s", "kubernetes"])
  provider = uapi.moatnet

  id   = "fwd_lan_${each.key}"
  src  = "lan"
  dest = each.key
}
