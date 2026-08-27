output "interface_ids" {
  value       = { for dk, m in module.openwrt : dk => m.interface_ids }
  description = "Interface id by [device][interface key]"
}

output "zone_ids" {
  value       = { for dk, m in module.openwrt : dk => m.zone_ids }
  description = "Firewall zone id by [device][zone key]"
}
