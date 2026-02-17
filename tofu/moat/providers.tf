terraform {
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "0.95.1-rc1"
    }
    talos = {
      source  = "siderolabs/talos"
      version = "0.10.1"
    }
  }
}
provider "proxmox" {
  endpoint = "https://${var.falcon_ip}/"
  insecure = true
  ssh {
    agent = true
    # username = "terraform"
    username = "root"
  }
}

provider "talos" {}
