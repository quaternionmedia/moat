# DHCP servers on MoatNet (the quartermaster assigns billets)
#
# vwan (VLAN 2) is a DHCP client upstream — no server needed.
# config (VLAN 1) is management-only — static assignments only, pool kept small.

locals {
  # VLANs that get a DHCP pool. All except vwan (WAN client) and config (static mgmt).
  dhcp_vlans = toset([for k, v in local.vlans : k if k != "vwan"])
}

resource "uapi_dhcp_server" "moatnet" {
  for_each = local.dhcp_vlans
  provider = uapi.moatnet

  id        = each.key
  interface = each.key
  start     = 100
  limit     = each.key == "config" ? 10 : 150  # config VLAN gets a narrow billet pool
  leasetime = each.key == "guest" ? "2h" : "12h"
  ignore    = false
}

# Global dnsmasq config on MoatNet (the castle herald handles all name proclamations)
# ponytail: to adopt an existing dnsmasq section, run:
#   tofu import uapi_dhcp_dnsmasq.moatnet <existing-id>
resource "uapi_dhcp_dnsmasq" "moatnet" {
  provider = uapi.moatnet
  domainneeded      = true
  boguspriv         = true
  rebind_protection = true
  expandhosts       = true
  authoritative     = true
  domain            = "moat.local"
}
