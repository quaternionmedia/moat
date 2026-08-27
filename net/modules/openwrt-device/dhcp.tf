resource "uapi_dhcp_server" "this" {
  for_each = var.dhcp_servers
  provider = uapi

  id        = each.key
  interface = uapi_network_interface.this[each.value.interface].id
  start     = each.value.start
  limit     = each.value.limit
  leasetime = each.value.leasetime
  ignore    = each.value.ignore
}

resource "uapi_dhcp_dnsmasq" "this" {
  count    = var.dnsmasq == null ? 0 : 1
  provider = uapi

  domain            = var.dnsmasq.domain
  domainneeded      = var.dnsmasq.domainneeded
  boguspriv         = var.dnsmasq.boguspriv
  rebind_protection = var.dnsmasq.rebind_protection
  expandhosts       = var.dnsmasq.expandhosts
  authoritative     = var.dnsmasq.authoritative
}
