# WAN — standalone DHCP client directly on eth0. Not a bridge member, not
# VLAN 2 in br-lan: the CSV's 192.168.2.0/24 is the *upstream* subnet this
# port receives a lease from, not something MoatNet serves.
#
# id = "wan" to match (and adopt) the stock section — see imports.tf.
resource "uapi_network_interface" "wan" {
  provider = uapi.moatnet
  id       = "wan"
  proto    = "dhcp"
  device   = var.moatnet_wan_port
}

# Remaining MoatNet interfaces, one per bridged VLAN (excludes vwan, handled
# above). id = "lan" on the lan VLAN matches the stock section — see imports.tf.
resource "uapi_network_interface" "moatnet" {
  for_each = local.vlan_networks
  provider = uapi.moatnet

  id      = each.key
  proto   = "static"
  device  = "${var.moatnet_bridge}.${each.value.id}"
  ipaddrs = [each.value.gateway]
  netmask = each.value.netmask
}

# Drawbridge management interface — the only IP Drawbridge holds, on the
# untagged config VLAN. Reachable at 192.168.1.2, gateway/DNS = MoatNet.
resource "uapi_network_interface" "drawbridge_mgmt" {
  provider = uapi.drawbridge
  id       = "config"
  proto    = "static"
  device   = "${var.drawbridge_bridge}.${local.vlans["config"].id}"
  ipaddrs  = [cidrhost(local.vlans["config"].cidr, 2)]
  netmask  = local.vlan_networks["config"].netmask
  gateway  = local.vlan_networks["config"].gateway
  dns      = [local.vlan_networks["config"].gateway]
}

# Drawbridge client VLANs — bridged straight to WiFi, no IP, no management
# surface reachable from guest/iot/etc. Fixes H4.
resource "uapi_network_interface" "drawbridge_client" {
  for_each = toset(var.drawbridge_client_vlans)
  provider = uapi.drawbridge

  id     = each.key
  proto  = "none"
  device = "${var.drawbridge_bridge}.${local.vlans[each.key].id}"
}
