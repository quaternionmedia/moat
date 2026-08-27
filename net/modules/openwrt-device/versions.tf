// No provider "uapi" block here on purpose: a module that declares its own
// provider configuration is incompatible with for_each/count/depends_on.
// The provider instance is always injected by the caller.
terraform {
  required_version = ">= 1.9"
  required_providers {
    uapi = {
      source  = "openwrt-iac/uapi"
      version = "~> 3.0"
    }
  }
}
