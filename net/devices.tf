# Mechanical composition: turns inventory.tf's device facts + vlans.tf's
# catalog + policy.tf's network intent into the module's plain-map inputs.
# No vendor (uapi) knowledge lives here — that's entirely inside the module.

locals {
  device_interfaces = {
    for dk, d in local.enabled_openwrt_devices : dk => merge(
      d.wan_port != null ? { wan = { proto = "dhcp", device = d.wan_port } } : {},
      {
        for vk, over in local.effective_ip_vlans[dk] : vk => {
          proto   = "static"
          device  = "${d.bridge}.${local.vlans[vk].id}"
          ipaddrs = coalesce(over.ipaddrs, [local.vlan_networks[vk].gateway])
          netmask = coalesce(over.netmask, local.vlan_networks[vk].netmask)
          gateway = over.gateway
          dns     = over.dns
        }
      },
      # Every bridged VLAN not given an IP still needs a `config interface`
      # section — a wireless SSID's `network` option (and anything else that
      # references the VLAN by name) requires one to exist, even bodiless.
      # Fully mechanical: whatever's in vlan_ports but not in ip_vlans.
      {
        for vk in setsubtract(keys(d.vlan_ports), keys(local.effective_ip_vlans[dk])) : vk => {
          proto  = "none"
          device = "${d.bridge}.${local.vlans[vk].id}"
        }
      }
    )
  }

  device_bridge_vlans = {
    for dk, d in local.enabled_openwrt_devices : dk => {
      for vk, ports in d.vlan_ports : vk => { vlan = local.vlans[vk].id, ports = ports }
    }
  }

  device_dhcp_servers = {
    for dk, d in local.enabled_openwrt_devices : dk => {
      for vk in local.effective_dhcp_vlans[dk] : vk => {
        interface = vk
        start     = 100
        # config (management, /24): a narrow, mostly-static pool.
        # /24 client VLANs: 150 addresses. /16 device-fleet VLANs: room to grow.
        limit     = vk == "config" ? 10 : (local.vlan_networks[vk].prefix <= 24 ? 150 : 5000)
        leasetime = vk == "guest" ? "2h" : "12h"
        ignore    = false
      }
    }
  }

  device_wireless_radios = {
    for dk, d in local.enabled_openwrt_devices : dk => try(d.wireless.radios, {})
  }

  # Flatten {ssid => {radios = [...]}} into one wireless_interface per
  # (ssid, radio) pair — each band needs its own wifi-iface section.
  device_wireless_interfaces = {
    for dk, d in local.enabled_openwrt_devices : dk => merge([
      for sk, s in try(d.wireless.ssids, {}) : {
        for rk in s.radios : "${sk}_${rk}" => {
          radio      = rk
          network    = s.vlan
          ssid       = sk
          encryption = s.encryption
          key        = lookup(var.wireless_keys, sk, null)
          hidden     = s.hidden
          isolate    = s.isolate
        }
      }
    ]...)
  }
}

module "openwrt" {
  for_each  = local.enabled_openwrt_devices
  source    = "./modules/openwrt-device"
  providers = { uapi = uapi.device[each.key] }

  bridge       = each.value.bridge
  bridge_vlans = local.device_bridge_vlans[each.key]
  interfaces   = local.device_interfaces[each.key]

  # Plain lookup by device NAME, default {}/null when absent. Drawbridge
  # simply isn't a key in local.policy — role is never inspected here.
  firewall_defaults    = try(local.policy[each.key].defaults, null)
  firewall_zones       = try(local.policy[each.key].zones, {})
  firewall_forwardings = try(local.policy[each.key].forwardings, {})
  firewall_rules       = try(local.policy[each.key].rules, {})
  dnsmasq              = try(local.policy[each.key].dnsmasq, null)

  dhcp_servers = local.device_dhcp_servers[each.key]

  wireless_radios     = local.device_wireless_radios[each.key]
  wireless_interfaces = local.device_wireless_interfaces[each.key]
}

# Advisory only (a `check` failure is a warning, never a blocking error) —
# `role` is documentation, not logic, but this combination is a strong smell:
# an "ap" picking up router firewall policy almost always means policy.tf
# was keyed wrong.
check "ap_role_has_no_firewall_policy" {
  assert {
    condition = alltrue([
      for dk, d in var.devices : !(
        d.role == "ap" &&
        contains(keys(local.policy), dk) &&
        length(try(local.policy[dk].zones, {})) > 0
      )
    ])
    error_message = "A device with role \"ap\" has firewall zones defined in policy.tf. role is advisory and this isn't blocked, but it's almost certainly a mistake — check policy.tf's keys."
  }
}
