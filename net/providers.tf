terraform {
  required_providers {
    uapi = {
      source  = "openwrt-iac/uapi"
      version = "~> 3.0"
    }
  }
}

# MoatNet - primary router (the castle gate)
provider "uapi" {
  alias    = "moatnet"
  endpoint = var.moatnet_endpoint
  token    = var.moatnet_token
  insecure = true # ponytail: self-signed cert ok for now, swap for acme when exposed
}

# Drawbridge - primary access point (the bridge to the keep)
provider "uapi" {
  alias    = "drawbridge"
  endpoint = var.drawbridge_endpoint
  token    = var.drawbridge_token
  insecure = true
}
