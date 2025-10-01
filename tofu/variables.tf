
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

variable "proxmox_api_token_id" {
  type        = string
  description = "Proxmox API token ID"
}

variable "proxmox_api_token_secret" {
  type        = string
  description = "Proxmox API token secret"
}
