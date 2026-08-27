resource "uapi_firewall_defaults" "this" {
  count    = var.firewall_defaults == null ? 0 : 1
  provider = uapi

  input              = var.firewall_defaults.input
  output_policy      = var.firewall_defaults.output_policy
  forward            = var.firewall_defaults.forward
  drop_invalid       = var.firewall_defaults.drop_invalid
  syn_flood          = var.firewall_defaults.syn_flood
  synflood_rate      = var.firewall_defaults.synflood_rate
  synflood_burst     = var.firewall_defaults.synflood_burst
  tcp_syncookies     = var.firewall_defaults.tcp_syncookies
  flow_offloading    = var.firewall_defaults.flow_offloading
  flow_offloading_hw = var.firewall_defaults.flow_offloading_hw
}

resource "uapi_firewall_zone" "this" {
  for_each = var.firewall_zones
  provider = uapi

  id      = each.key
  name    = each.key
  network = [for net_key in each.value.networks : uapi_network_interface.this[net_key].id]

  input         = each.value.input
  forward       = each.value.forward
  output_policy = each.value.output_policy
  masq          = each.value.masq
  mtu_fix       = each.value.mtu_fix
  family        = each.value.family
}

resource "uapi_firewall_forwarding" "this" {
  for_each = var.firewall_forwardings
  provider = uapi

  id   = each.key
  src  = uapi_firewall_zone.this[each.value.src].id
  dest = uapi_firewall_zone.this[each.value.dest].id
}

resource "uapi_firewall_rule" "this" {
  for_each = var.firewall_rules
  provider = uapi

  id     = each.key
  name   = coalesce(each.value.name, each.key)
  target = each.value.target

  match = {
    src_zone  = each.value.match.src_zone == null ? null : uapi_firewall_zone.this[each.value.match.src_zone].id
    dest_zone = each.value.match.dest_zone == null ? null : uapi_firewall_zone.this[each.value.match.dest_zone].id
    proto     = each.value.match.proto
    src_ip    = each.value.match.src_ip
    dest_ip   = each.value.match.dest_ip
    src_port  = each.value.match.src_port
    dest_port = each.value.match.dest_port
    family    = each.value.match.family
  }
}
