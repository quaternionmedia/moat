# Adopts stock named sections in place instead of creating duplicates.
# Per the provider's adoption guide: creating a section whose name already
# exists on the box returns 422. Every one of these names ships on a stock
# OpenWrt install, so each must be imported once before `tofu apply` can
# succeed cleanly.
#
#   tofu plan     # after adding an import block, plan should show "no changes"
#                 # (or an in-place update) for the adopted resource, never a
#                 # destroy/create.

# MoatNet: stock `wan` interface -> our standalone eth0 WAN client
import {
  to = uapi_network_interface.wan
  id = "wan"
}

# MoatNet: stock `lan` interface -> our VLAN-3 lan interface
import {
  to = uapi_network_interface.moatnet["lan"]
  id = "lan"
}

# MoatNet: stock `lan` / `wan` firewall zones
import {
  to = uapi_firewall_zone.trusted["lan"]
  id = "lan"
}

import {
  to = uapi_firewall_zone.wan
  id = "wan"
}

# MoatNet: stock `lan` DHCP server
import {
  to = uapi_dhcp_server.moatnet["lan"]
  id = "lan"
}

# Drawbridge: stock `lan` interface -> our client-VLAN `lan` (proto=none)
import {
  to = uapi_network_interface.drawbridge_client["lan"]
  id = "lan"
}
