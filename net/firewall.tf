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
  network  = [uapi_network_interface.moatnet["vwan"].id]
  input    = "DROP"
  forward  = "DROP"
  masq     = true
  mtu_fix  = true
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

# Drop and log inter-zone lateral movement from isolated zones (close the portcullis)
resource "uapi_firewall_rule" "drop_lateral_isolated" {
  for_each = local.isolated_vlans
  provider = uapi.moatnet

  id     = "lateral_drop_${each.key}"
  name   = "drop-lateral-${each.key}"
  target = "DROP"
  match = {
    src_zone = each.key
  }
}
