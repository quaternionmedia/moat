terraform {
  required_version = ">= 1.9" # provider for_each (F1) — OpenTofu-only, not in Terraform
  required_providers {
    uapi = {
      source  = "openwrt-iac/uapi"
      version = "~> 3.0"
    }
  }
}

# One provider instance per OpenWrt device. Iterates the FULL inventory
# (including disabled devices) — this must stay a superset of the module's
# for_each in devices.tf, or removing a device deadlocks: OpenTofu needs the
# provider instance alive to destroy the resources it's removing.
provider "uapi" {
  alias    = "device"
  for_each = local.openwrt_devices

  endpoint = each.value.endpoint
  token    = var.device_tokens[each.key]
  insecure = each.value.insecure
}

# A non-OpenWrt platform (see inventory.tf) gets its own filtered provider
# block here, following the same pattern, when one is actually added.
