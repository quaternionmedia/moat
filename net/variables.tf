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

# Hardware configuration - MoatNet (primary router)
variable "moatnet_bridge" {
  type        = string
  default     = "br-lan"
  description = "Bridge device name on MoatNet"
}

variable "moatnet_trunk_ports" {
  type        = list(string)
  default     = ["eth0:t", "eth1:t"]
  description = "Trunk ports on MoatNet bridge (tagged)"
}

# Hardware configuration - Drawbridge (primary AP)
variable "drawbridge_bridge" {
  type        = string
  default     = "br-lan"
  description = "Bridge device name on Drawbridge"
}

variable "drawbridge_trunk_ports" {
  type        = list(string)
  default     = ["eth0:t"]
  description = "Trunk ports on Drawbridge bridge (tagged)"
}

variable "drawbridge_vlans" {
  type        = list(string)
  description = "VLAN names to provision on the Drawbridge AP"
  default     = ["lan", "home", "work", "guest", "iot"]
}

# VLAN definitions from MoatNet.csv
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

  # Helper: extract network and prefix from CIDR
  vlan_networks = { for k, v in local.vlans : k => {
    id      = v.id
    network = cidrhost(v.cidr, 0)
    netmask = cidrnetmask(v.cidr)
    gateway = cidrhost(v.cidr, 1)
    cidr    = v.cidr
    desc    = v.desc
  } }
}
