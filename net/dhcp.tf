# DHCP servers on MoatNet (the quartermaster assigns billets)
#
# vwan (VLAN 2) is a DHCP client upstream on standalone eth0 — no server, and
# it's already absent from local.vlan_networks (see variables.tf).
#
# id = "lan" on the lan VLAN matches (and adopts) the stock section — see
# imports.tf.

resource "uapi_dhcp_server" "moatnet" {
  for_each = local.vlan_networks
  provider = uapi.moatnet

  id        = each.key
  interface = uapi_network_interface.moatnet[each.key].id

  # config (management, /24): a narrow, mostly-static pool.
  # /24 client VLANs: 150 addresses.
  # /16 device-fleet VLANs (lighting/audio/video/iot/etc.): room for real fleets.
  start = 100
  limit = each.key == "config" ? 10 : (each.value.prefix <= 24 ? 150 : 5000)

  leasetime = each.key == "guest" ? "2h" : "12h"
  ignore    = false
}

# Global dnsmasq config on MoatNet (the castle herald handles all name proclamations)
# ponytail: to adopt an existing dnsmasq section, run:
#   tofu import uapi_dhcp_dnsmasq.moatnet <existing-id>
resource "uapi_dhcp_dnsmasq" "moatnet" {
  provider          = uapi.moatnet
  domainneeded      = true
  boguspriv         = true
  rebind_protection = true
  expandhosts       = true
  authoritative     = true
  domain            = "moat.local"
}
