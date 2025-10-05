
locals {
  talos = {
    version      = "v1.11.2"
    architecture = "amd64"
  }
}

resource "proxmox_virtual_environment_download_file" "talos_nocloud_image" {
  content_type = "iso"
  datastore_id = "local"
  node_name    = "falcon"

  file_name = "talos-${local.talos.version}-nocloud-amd64.iso"
  url       = "https://factory.talos.dev/image/aeec243e3a4c2a14f9ba74b1a8c7662f03eea658a7ea5f1c26fdd491280c88f8/v1.11.2/nocloud-amd64.iso"
  # overwrite = false
  # lifecycle {
  #   prevent_destroy = true
  # }
}
