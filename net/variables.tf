# Device endpoints/tokens and wireless config live in inventory.tf (the
# mechanical, per-device facts) and policy.tf (vendor-neutral network intent).
# This file holds only the secrets no device inventory should carry inline.

variable "device_tokens" {
  type        = map(string)
  sensitive   = true
  description = "uapi token per device name (set via TF_VAR_device_tokens)"
}

variable "wireless_keys" {
  type        = map(string)
  sensitive   = true
  default     = {}
  description = "WiFi passphrase per SSID name, across all devices"
}
