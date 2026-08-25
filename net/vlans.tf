# Bridge VLANs on MoatNet (the gatehouse - all VLANs terminate here)
resource "uapi_network_bridge_vlan" "moatnet" {
  for_each = local.vlans
  provider = uapi.moatnet

  id     = "vlan_${each.key}"
  device = var.moatnet_bridge
  vlan   = each.value.id
  ports  = var.moatnet_trunk_ports
}

# Bridge VLANs on Drawbridge (only the wireless-facing VLANs cross the drawbridge)
resource "uapi_network_bridge_vlan" "drawbridge" {
  for_each = toset(var.drawbridge_vlans)
  provider = uapi.drawbridge

  id     = "vlan_${each.key}"
  device = var.drawbridge_bridge
  vlan   = local.vlans[each.key].id
  ports  = var.drawbridge_trunk_ports
}
