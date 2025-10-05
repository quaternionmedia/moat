terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "0.84.1"
    }
    talos = {
      source  = "siderolabs/talos"
      version = "0.9.0"
    }
  }
}
provider "proxmox" {
  endpoint = "https://192.168.50.2:8006/"
  insecure = true
  ssh {
    agent = true
    # username = "terraform"
    username = "root"
  }
}

