# Bridge VLANs on MoatNet. vwan (VLAN 2) is intentionally absent — eth0 is a
# standalone WAN client, not a bridge member (see interfaces.tf).
resource "uapi_network_bridge_vlan" "moatnet" {
  for_each = var.moatnet_vlan_ports
  provider = uapi.moatnet

  id     = "vlan_${each.key}"
  device = var.moatnet_bridge
  vlan   = local.vlans[each.key].id
  ports  = each.value
}

# Bridge VLANs on Drawbridge — config untagged (management), client VLANs
# tagged onto the sole uplink port.
resource "uapi_network_bridge_vlan" "drawbridge" {
  for_each = var.drawbridge_vlan_ports
  provider = uapi.drawbridge

  id     = "vlan_${each.key}"
  device = var.drawbridge_bridge
  vlan   = local.vlans[each.key].id
  ports  = each.value
}
