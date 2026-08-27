# THE device list. Add a device by adding an entry here — no new resource
# blocks, no new provider block, no new module block required (see
# plans/modular-refactor.md, "The expansion seam").
#
# `role` is advisory only (validated below for obviously-wrong combinations,
# and readable in `tofu state list`) — it is never used to branch behavior.
# Every actual difference between devices is data: which VLANs get an IP,
# which get a DHCP pool, which stock sections need adopting.

variable "devices" {
  type = map(object({
    endpoint = string
    role     = string                      # advisory: "router" | "ap" | ...
    platform = optional(string, "openwrt") # filter only — the expansion seam
    enabled  = optional(bool, true)        # false stops the module targeting it (F3)
    insecure = optional(bool, true)

    bridge   = optional(string, "br-lan")
    wan_port = optional(string) # null => no standalone WAN interface

    # Bridge-vlan port membership, keyed by VLAN name (from local.vlans).
    # "u*" = untagged/native, "t" = tagged.
    vlan_ports = optional(map(list(string)), {})

    # Which of those VLANs get a real network_interface, and with what
    # overrides. null => every vlan_ports key gets one, address = the VLAN's
    # .1 gateway from the catalog (the mechanical default for a device that
    # IS that VLAN's router). An AP overrides this to just its management
    # VLAN, with its own address/gateway/dns.
    ip_vlans = optional(map(object({
      ipaddrs = optional(list(string)) # null => catalog .1 gateway
      netmask = optional(string)       # null => catalog netmask
      gateway = optional(string)       # null => none
      dns     = optional(list(string))
    })))

    # Which ip_vlans additionally get a uapi_dhcp_server. null => same set as
    # ip_vlans (mechanical default). Explicit [] => none (an AP serving no
    # DHCP of its own).
    dhcp_vlans = optional(list(string))

    # Stock named sections to adopt instead of create (F5) — see the
    # provider's adoption guide; a create colliding with an existing name
    # returns 422.
    adopt = optional(object({
      interfaces      = optional(list(string), [])
      firewall_zones  = optional(list(string), [])
      dhcp_servers    = optional(list(string), [])
      wireless_radios = optional(list(string), [])
    }), {})

    # Present only on devices that broadcast WiFi.
    wireless = optional(object({
      radios = optional(map(object({
        type   = optional(string, "mac80211")
        band   = optional(string)
        htmode = optional(string)
      })), {})
      ssids = optional(map(object({
        vlan       = string       # key into vlan_ports / local.vlans
        radios     = list(string) # keys into wireless.radios, one per band broadcast
        encryption = optional(string, "sae-mixed")
        hidden     = optional(bool, false)
        isolate    = optional(bool, false)
      })), {})
    }))
  }))

  default = {
    moatnet = {
      endpoint = "https://192.168.1.1/api/v3"
      role     = "router"
      bridge   = "br-lan"
      wan_port = "eth0"

      # eth0 = WAN uplink (standalone, not bridged — handled via wan_port)
      # eth1 = Drawbridge trunk   eth2 = Keep trunk   eth3 = Bailey trunk
      # eth4 = Config access port (untagged VLAN 1 — the guaranteed way back in)
      vlan_ports = {
        config = ["eth1:u*", "eth2:t", "eth3:t", "eth4:u*"]
        lan    = ["eth1:t", "eth2:u*"]
        home   = ["eth1:t", "eth2:t"]
        work   = ["eth1:t", "eth2:t"]
        guest  = ["eth1:t"]
        lab    = ["eth3:u*"]
        k8s    = ["eth3:t"]
        qm     = ["eth2:t"]

        lights           = ["eth3:t"]
        lights_moat      = ["eth3:t"]
        lights_studio    = ["eth3:t"]
        lights_halloween = ["eth3:t"]
        lights_home      = ["eth3:t"]

        audio           = ["eth3:t"]
        audio_moat      = ["eth3:t"]
        audio_studio    = ["eth3:t"]
        audio_halloween = ["eth3:t"]
        audio_home      = ["eth3:t"]

        video           = ["eth3:t"]
        video_moat      = ["eth3:t"]
        video_studio    = ["eth3:t"]
        video_halloween = ["eth3:t"]
        video_home      = ["eth3:t"]

        kubernetes = ["eth3:t"]
        iot        = ["eth1:t", "eth3:t"]
      }

      # ip_vlans / dhcp_vlans left null: MoatNet is the gateway and DHCP
      # server for every VLAN it bridges — the mechanical default.

      adopt = {
        interfaces     = ["lan", "wan"]
        firewall_zones = ["lan", "wan"]
        dhcp_servers   = ["lan"]
      }
    }

    drawbridge = {
      endpoint = "https://192.168.1.2/api/v3"
      role     = "ap"
      bridge   = "br-lan"
      # No wan_port — Drawbridge's only port is the uplink to MoatNet eth1.

      vlan_ports = {
        config = ["eth0:u*"] # management — untagged, or the AP self-locks (C2)
        lan    = ["eth0:t"]
        home   = ["eth0:t"]
        work   = ["eth0:t"]
        guest  = ["eth0:t"]
        iot    = ["eth0:t"]
      }

      # Only "config" gets a real IP — the single management address.
      # Client VLANs are bridged straight to WiFi with no IP (fixes H4/H5).
      ip_vlans = {
        config = {
          ipaddrs = ["192.168.1.2"]
          gateway = "192.168.1.1"
          dns     = ["192.168.1.1"]
        }
      }
      dhcp_vlans = [] # Drawbridge serves no DHCP of its own.

      adopt = {
        interfaces = ["lan"] # stock `lan` collides with our client-VLAN `lan`
        # wireless_radios left empty: run `uci show wireless` on the AP first —
        # if radio0/radio1 already exist from first-boot detection, list them
        # here (ponytail: see modules/openwrt-device/wireless.tf).
      }

      wireless = {
        radios = {
          radio0 = { band = "2g", htmode = "HT20" }
          radio1 = { band = "5g", htmode = "VHT80" }
        }
        # "Lab" -> the `lan` VLAN (3), the trusted primary. Not to be
        # confused with the separate `lab` VLAN (7), wired-only on Bailey.
        ssids = {
          "Lab" = {
            vlan   = "lan"
            radios = ["radio0", "radio1"]
          }
          "Lab-home" = {
            vlan   = "home"
            radios = ["radio0", "radio1"]
          }
          "Lab-work" = {
            vlan   = "work"
            radios = ["radio0", "radio1"]
          }
          "Lab-guest" = {
            vlan    = "guest"
            radios  = ["radio0", "radio1"]
            isolate = true
          }
          "Lab-iot" = {
            # WPA2-only + hidden: WPA3/mixed mode breaks a lot of cheap IoT
            # gear. 2.4 GHz only.
            vlan       = "iot"
            radios     = ["radio0"]
            encryption = "psk2"
            hidden     = true
            isolate    = true
          }
        }
      }
    }
  }

  description = "OpenWrt device inventory"
}

locals {
  # Platform filter — the seam a future non-OpenWrt module block would reuse.
  openwrt_devices = { for k, v in var.devices : k => v if v.platform == "openwrt" }

  # Devices actually materialized this run (F3's enabled-subset mitigation).
  enabled_openwrt_devices = { for k, v in local.openwrt_devices : k => v if v.enabled }

  # "Which VLANs get a real IP, with what override" — null defaults to every
  # bridged VLAN at its catalog gateway address.
  #
  # ponytail: the fallback object literal spells out all four keys (instead
  # of `{}`) on purpose. `keys(d.vlan_ports)` is statically known, so HCL
  # infers `{ for vk in keys(...) : vk => {} }` as an *object/record* type
  # keyed by VLAN name, not a generic map — and its `{}` values then fail to
  # structurally unify with the shape of `d.ip_vlans`'s objects in the other
  # ternary branch ("Inconsistent conditional result types"). Matching the
  # shape exactly, then forcing a map with `tomap()`, sidesteps both problems.
  effective_ip_vlans = {
    for dk, d in local.enabled_openwrt_devices : dk => (
      d.ip_vlans != null ? d.ip_vlans : tomap({
        for vk in keys(d.vlan_ports) : vk => {
          ipaddrs = null
          netmask = null
          gateway = null
          dns     = null
        }
      })
    )
  }

  # "Which of those additionally get a DHCP pool" — null defaults to all of them.
  effective_dhcp_vlans = {
    for dk, d in local.enabled_openwrt_devices : dk => toset(
      d.dhcp_vlans != null ? d.dhcp_vlans : keys(local.effective_ip_vlans[dk])
    )
  }
}
