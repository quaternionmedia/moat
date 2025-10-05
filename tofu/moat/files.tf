
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
  url       = "https://factory.talos.dev/image/74b14c6bce8dbecd928887731c64ceef5c0ecf9205059d44dbe92f66277edcff/v1.11.2/nocloud-amd64.iso"
  # decompression_algorithm = "gz"
  overwrite = false
}
