# Device endpoints
variable "moatnet_endpoint" {
  type        = string
  description = "MoatNet router API endpoint"
  default     = "https://192.168.1.1/api/v3"
}

variable "drawbridge_endpoint" {
  type        = string
  description = "Drawbridge AP API endpoint"
  default     = "https://192.168.1.2/api/v3"
}

# API tokens (set via TF_VAR_moatnet_token, TF_VAR_drawbridge_token)
variable "moatnet_token" {
  type        = string
  sensitive   = true
  description = "MoatNet uapi token"
}

variable "drawbridge_token" {
  type        = string
  sensitive   = true
  description = "Drawbridge uapi token"
}

# ── Hardware - MoatNet (primary router) ───────────────────────────────────────
#
# eth0 = WAN uplink (standalone, not a bridge member — see interfaces.tf)
# eth1 = Drawbridge trunk   eth2 = Keep trunk   eth3 = Bailey trunk
# eth4 = Config access port (untagged VLAN 1 only — the guaranteed way back in)

variable "moatnet_bridge" {
  type        = string
  default     = "br-lan"
  description = "Bridge device name on MoatNet"
}

variable "moatnet_wan_port" {
  type        = string
  default     = "eth0"
  description = "MoatNet WAN uplink port (standalone, not bridged)"
}

# Per-VLAN port membership on the MoatNet bridge. "u*" = untagged + native
# (PVID), "t" = tagged. A VLAN absent from this map gets no bridge-vlan
# section at all (vwan: it isn't a bridge member, it lives on eth0).
variable "moatnet_vlan_ports" {
  type        = map(list(string))
  description = "uci bridge-vlan ports per VLAN name on MoatNet"
  default = {
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
}

# ── Hardware - Drawbridge (primary AP, single uplink port) ───────────────────

variable "drawbridge_bridge" {
  type        = string
  default     = "br-lan"
  description = "Bridge device name on Drawbridge"
}

variable "drawbridge_uplink_port" {
  type        = string
  default     = "eth0"
  description = "Drawbridge's sole physical port, trunked to MoatNet eth1"
}

# config (VLAN 1) is untagged/native — the only IP Drawbridge holds.
# Everything else is tagged and carried to WiFi with no IP of its own.
variable "drawbridge_vlan_ports" {
  type        = map(list(string))
  description = "uci bridge-vlan ports per VLAN name on Drawbridge"
  default = {
    config = ["eth0:u*"]
    lan    = ["eth0:t"]
    home   = ["eth0:t"]
    work   = ["eth0:t"]
    guest  = ["eth0:t"]
    iot    = ["eth0:t"]
  }
}

# Client VLANs bridged to WiFi on Drawbridge (excludes "config", which is the
# management interface, not a wireless network).
variable "drawbridge_client_vlans" {
  type        = list(string)
  description = "VLANs bridged onto Drawbridge WiFi (no IP of their own)"
  default     = ["lan", "home", "work", "guest", "iot"]
}

# ── Wireless SSIDs on Drawbridge ───────────────────────────────────────────────
#
# "Lab" -> the `lan` VLAN (3), the trusted primary. Not to be confused with
# the separate `lab` VLAN (7), which is a wired-only network on Bailey.

variable "wireless_ssids" {
  type = map(object({
    vlan       = string
    encryption = string
    hidden     = bool
    isolate    = bool
    bands      = list(string) # subset of ["2g", "5g"]
  }))
  description = "SSID definitions: name => settings"
  default = {
    "Lab" = {
      vlan       = "lan"
      encryption = "sae-mixed"
      hidden     = false
      isolate    = false
      bands      = ["2g", "5g"]
    }
    "Lab-home" = {
      vlan       = "home"
      encryption = "sae-mixed"
      hidden     = false
      isolate    = false
      bands      = ["2g", "5g"]
    }
    "Lab-work" = {
      vlan       = "work"
      encryption = "sae-mixed"
      hidden     = false
      isolate    = false
      bands      = ["2g", "5g"]
    }
    "Lab-guest" = {
      vlan       = "guest"
      encryption = "sae-mixed"
      hidden     = false
      isolate    = true
      bands      = ["2g", "5g"]
    }
    "Lab-iot" = {
      # WPA2-only + hidden: WPA3/mixed mode breaks a lot of cheap IoT gear.
      vlan       = "iot"
      encryption = "psk2"
      hidden     = true
      isolate    = true
      bands      = ["2g"]
    }
  }
}

variable "wireless_keys" {
  type        = map(string)
  sensitive   = true
  description = "WiFi passphrase per SSID name (set via TF_VAR_wireless_keys)"
}

# ── VLAN definitions from MoatNet.csv ──────────────────────────────────────────

locals {
  vlans = {
    # Management & core (192.168.x.0/24)
    config = { id = 1, cidr = "192.168.1.0/24", desc = "Device configuration" }
    vwan   = { id = 2, cidr = "192.168.2.0/24", desc = "Virtual WAN" }
    lan    = { id = 3, cidr = "192.168.3.0/24", desc = "Trusted WiFi" }
    home   = { id = 4, cidr = "192.168.4.0/24", desc = "Home Assistant + trusted IoT" }
    work   = { id = 5, cidr = "192.168.5.0/24", desc = "Work devices" }
    guest  = { id = 6, cidr = "192.168.6.0/24", desc = "Guest WiFi" }
    lab    = { id = 7, cidr = "192.168.7.0/24", desc = "Laboratory" }
    k8s    = { id = 8, cidr = "192.168.8.0/24", desc = "Public Kubernetes" }
    qm     = { id = 9, cidr = "192.168.9.0/24", desc = "QM network" }

    # Lighting (10.1x.0.0/16)
    lights           = { id = 10, cidr = "10.10.0.0/16", desc = "Lighting primary" }
    lights_moat      = { id = 11, cidr = "10.11.0.0/16", desc = "Perimeter lighting" }
    lights_studio    = { id = 12, cidr = "10.12.0.0/16", desc = "Studio DMX" }
    lights_halloween = { id = 13, cidr = "10.13.0.0/16", desc = "Exterior theatrical" }
    lights_home      = { id = 14, cidr = "10.14.0.0/16", desc = "Interior home lighting" }

    # Audio (10.2x.0.0/16)
    audio           = { id = 20, cidr = "10.20.0.0/16", desc = "Audio primary" }
    audio_moat      = { id = 21, cidr = "10.21.0.0/16", desc = "Perimeter audio" }
    audio_studio    = { id = 22, cidr = "10.22.0.0/16", desc = "Studio Dante/AES67" }
    audio_halloween = { id = 23, cidr = "10.23.0.0/16", desc = "xLights audio" }
    audio_home      = { id = 24, cidr = "10.24.0.0/16", desc = "Home music" }

    # Video (10.3x.0.0/16)
    video           = { id = 30, cidr = "10.30.0.0/16", desc = "Video primary" }
    video_moat      = { id = 31, cidr = "10.31.0.0/16", desc = "Perimeter cameras" }
    video_studio    = { id = 32, cidr = "10.32.0.0/16", desc = "Broadcast video" }
    video_halloween = { id = 33, cidr = "10.33.0.0/16", desc = "Theatrical video" }
    video_home      = { id = 34, cidr = "10.34.0.0/16", desc = "Home video" }

    # Infrastructure (10.8x.0.0/16)
    kubernetes = { id = 80, cidr = "10.80.0.0/16", desc = "Private Kubernetes" }
    iot        = { id = 86, cidr = "10.86.0.0/16", desc = "Untrusted IoT" }
  }

  # Derived per-VLAN network facts. vwan is excluded — it's a DHCP client on
  # eth0, not a bridge-member interface with a static gateway.
  vlan_networks = { for k, v in local.vlans : k => {
    id      = v.id
    netmask = cidrnetmask(v.cidr)
    gateway = cidrhost(v.cidr, 1)
    prefix  = tonumber(split("/", v.cidr)[1])
    cidr    = v.cidr
    desc    = v.desc
  } if k != "vwan" }
}
