resource "uapi_network_bridge_vlan" "this" {
  for_each = var.bridge_vlans
  provider = uapi

  id     = each.key
  device = var.bridge
  vlan   = each.value.vlan
  ports  = each.value.ports
}

resource "uapi_network_interface" "this" {
  for_each = var.interfaces
  provider = uapi

  id      = each.key
  proto   = each.value.proto
  device  = each.value.device
  ipaddrs = each.value.ipaddrs
  netmask = each.value.netmask
  gateway = each.value.gateway
  dns     = each.value.dns
}
