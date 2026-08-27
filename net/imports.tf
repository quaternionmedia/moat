# Adopts stock named sections in place instead of creating duplicates.
#
# Import blocks are root-module only (OpenTofu rejects them inside a called
# module), so adoption is assembled here from every device's `adopt` list in
# inventory.tf and pointed at the resource instance the module created for
# that same key.
#
#   tofu plan   # an adopted resource should show "no changes", never a
#               # destroy/create, once its import block is in place.

locals {
  adopt_interfaces = merge([
    for dk, d in var.devices : { for k in d.adopt.interfaces : "${dk}.${k}" => { device = dk, key = k } }
  ]...)
  adopt_firewall_zones = merge([
    for dk, d in var.devices : { for k in d.adopt.firewall_zones : "${dk}.${k}" => { device = dk, key = k } }
  ]...)
  adopt_dhcp_servers = merge([
    for dk, d in var.devices : { for k in d.adopt.dhcp_servers : "${dk}.${k}" => { device = dk, key = k } }
  ]...)
  adopt_wireless_radios = merge([
    for dk, d in var.devices : { for k in d.adopt.wireless_radios : "${dk}.${k}" => { device = dk, key = k } }
  ]...)
}

import {
  for_each = local.adopt_interfaces
  to       = module.openwrt[each.value.device].uapi_network_interface.this[each.value.key]
  id       = each.value.key
}

import {
  for_each = local.adopt_firewall_zones
  to       = module.openwrt[each.value.device].uapi_firewall_zone.this[each.value.key]
  id       = each.value.key
}

import {
  for_each = local.adopt_dhcp_servers
  to       = module.openwrt[each.value.device].uapi_dhcp_server.this[each.value.key]
  id       = each.value.key
}

import {
  for_each = local.adopt_wireless_radios
  to       = module.openwrt[each.value.device].uapi_wireless_device.this[each.value.key]
  id       = each.value.key
}
