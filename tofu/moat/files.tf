
locals {
  talos = {
    version      = "v1.12.4"
    platform     = "nocloud"
    architecture = "amd64"
    schematic_id = "4d2f14467f85468b6b5ff0ba1747f7f0bcb97d351d516db0197885247093d6fd"
  }
}

resource "proxmox_virtual_environment_download_file" "talos_nocloud_image" {
  content_type = "iso"
  datastore_id = "local"
  node_name    = "falcon"

  file_name = "talos-${local.talos.version}-${local.talos.platform}-${local.talos.architecture}.iso"
  url       = "https://factory.talos.dev/image/${local.talos.schematic_id}/${local.talos.version}/${local.talos.platform}-${local.talos.architecture}.iso"

  lifecycle {
    # prevent_destroy = true
  }
}
