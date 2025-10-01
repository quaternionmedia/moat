resource "proxmox_vm_qemu" "ub-test" {
  name        = "ub-test"
  target_node = "falcon"
  clone       = "test2"
  full_clone  = false
  disk {
    disk_file = "local-lvm:base-100-disk-0"
    size      = "64G"
    storage   = "local-lvm"
    slot      = "scsi0"
  }
  cpu {
    cores   = 4
    sockets = 1
  }
  memory = 4096
}
