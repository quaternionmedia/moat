# Network interfaces on MoatNet (one per VLAN — the castle's inner passages)
resource "uapi_network_interface" "moatnet" {
  for_each = local.vlan_networks
  provider = uapi.moatnet

  id     = each.key
  proto  = each.key == "vwan" ? "dhcp" : "static"
  device = "${var.moatnet_bridge}.${each.value.id}"

  # Static VLANs get the gateway address (.1) on their subnet
  ipaddrs = each.key == "vwan" ? null : [each.value.gateway]
  netmask = each.key == "vwan" ? null : each.value.netmask
}

# Network interfaces on Drawbridge (only the APs wire-facing VLANs)
resource "uapi_network_interface" "drawbridge" {
  for_each = toset(var.drawbridge_vlans)
  provider = uapi.drawbridge

  id     = each.key
  proto  = "static"
  device = "${var.drawbridge_bridge}.${local.vlan_networks[each.key].id}"

  # Drawbridge uses .2 as its address on each VLAN (the router is .1)
  ipaddrs = [cidrhost(local.vlans[each.key].cidr, 2)]
  netmask = local.vlan_networks[each.key].netmask
}
