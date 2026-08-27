output "interface_ids" {
  value       = { for k, v in uapi_network_interface.this : k => v.id }
  description = "Interface id by key"
}

output "zone_ids" {
  value       = { for k, v in uapi_firewall_zone.this : k => v.id }
  description = "Firewall zone id by key"
}
