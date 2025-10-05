variable "cluster_name" {
  type    = string
  default = "moat"
}

variable "default_gateway" {
  type    = string
  default = "192.168.50.1"
}

variable "moat_net" {
  description = "The network where the Moat service will be deployed."
  type        = string
  default     = "192.168.50.64/26"
}

variable "falcon_ip" {
  description = "The IP address of the Falcon server"
  type        = string
  default     = "192.168.50.2:8006"
}

variable "proxmox_api_endpoint" {
  type        = string
  description = "Proxmox cluster API endpoint"
  default     = "/api2/json"
}

variable "talos_cp_01_ip_addr" {
  type    = string
  default = "192.168.50.64"
}

variable "talos_worker_01_ip_addr" {
  type    = string
  default = "192.168.50.65"
}
