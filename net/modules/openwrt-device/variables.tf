# Thin resource factory for one OpenWrt device.
#
# Every input is a map or an optional object. An empty map means "create no
# resources of that kind" — there are deliberately no boolean feature flags.
# All policy (what a "trusted" zone is, which VLAN is guest) lives in the
# caller; this module only materialises what it is handed.

variable "bridge" {
  type        = string
  default     = "br-lan"
  description = "Bridge device name"
}

# ── Network ───────────────────────────────────────────────────────────────────

variable "bridge_vlans" {
  type = map(object({
    vlan  = number
    ports = list(string) # uci bridge-vlan port syntax, e.g. ["eth1:t","eth4:u*"]
  }))
  default     = {}
  description = "Bridge VLANs, keyed by a stable name"
}

variable "interfaces" {
  type = map(object({
    proto   = string
    device  = optional(string)
    ipaddrs = optional(list(string))
    netmask = optional(string)
    gateway = optional(string)
    dns     = optional(list(string))
  }))
  default     = {}
  description = "Network interfaces, keyed by uci section name"
}

# ── Firewall ──────────────────────────────────────────────────────────────────

variable "firewall_defaults" {
  type = object({
    input              = optional(string)
    output_policy      = optional(string)
    forward            = optional(string)
    drop_invalid       = optional(bool)
    syn_flood          = optional(bool)
    synflood_rate      = optional(number)
    synflood_burst     = optional(number)
    tcp_syncookies     = optional(bool)
    flow_offloading    = optional(bool)
    flow_offloading_hw = optional(bool)
  })
  default     = null
  description = "Global firewall policy; null to leave the box's defaults alone"
}

variable "firewall_zones" {
  type = map(object({
    # Interface keys (from var.interfaces), resolved to ids by this module.
    networks      = optional(list(string), [])
    input         = optional(string)
    forward       = optional(string)
    output_policy = optional(string)
    masq          = optional(bool)
    mtu_fix       = optional(bool)
    family        = optional(string)
  }))
  default     = {}
  description = "Firewall zones, keyed by zone name"
}

variable "firewall_forwardings" {
  type = map(object({
    src  = string
    dest = string
  }))
  default     = {}
  description = "Zone forwardings, keyed by a stable name"
}

variable "firewall_rules" {
  type = map(object({
    name   = optional(string)
    target = string
    match = object({
      src_zone  = optional(string)
      dest_zone = optional(string)
      proto     = optional(list(string))
      src_ip    = optional(list(string))
      dest_ip   = optional(list(string))
      src_port  = optional(list(string))
      dest_port = optional(list(string))
      family    = optional(string)
    })
  }))
  default     = {}
  description = "Firewall rules, keyed by a stable name"
}

# ── DHCP ──────────────────────────────────────────────────────────────────────

variable "dhcp_servers" {
  type = map(object({
    interface = string # interface key, resolved to an id by this module
    start     = optional(number)
    limit     = optional(number)
    leasetime = optional(string)
    ignore    = optional(bool)
  }))
  default     = {}
  description = "DHCP pools, keyed by uci section name"
}

variable "dnsmasq" {
  type = object({
    domain            = optional(string)
    domainneeded      = optional(bool)
    boguspriv         = optional(bool)
    rebind_protection = optional(bool)
    expandhosts       = optional(bool)
    authoritative     = optional(bool)
  })
  default     = null
  description = "Global dnsmasq settings; null to leave alone"
}

# ── Wireless ──────────────────────────────────────────────────────────────────

variable "wireless_radios" {
  type = map(object({
    type    = optional(string, "mac80211")
    band    = optional(string)
    htmode  = optional(string)
    channel = optional(number)
    country = optional(string)
  }))
  default     = {}
  description = "Radios, keyed by uci section name (radio0, radio1, ...)"
}

variable "wireless_interfaces" {
  type = map(object({
    radio      = string # key into var.wireless_radios
    network    = string # key into var.interfaces
    ssid       = string
    encryption = optional(string)
    key        = optional(string)
    hidden     = optional(bool)
    isolate    = optional(bool)
    mode       = optional(string, "ap")
  }))
  default     = {}
  description = "SSIDs, keyed by a stable name (key: passphrase, marked sensitive by the provider schema itself)"
}

# Adoption of stock named sections (lan, wan, radio0, ...) happens via
# root-level `import` blocks in imports.tf — OpenTofu only allows `import`
# in the root module, so this module has no adopt_* inputs. It just creates
# uapi_network_interface.this["lan"] etc. normally; the root's import block
# binds that same resource instance to the pre-existing section instead of
# creating a duplicate.
