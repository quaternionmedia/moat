resource "uapi_wireless_device" "this" {
  for_each = var.wireless_radios
  provider = uapi

  id      = each.key
  type    = each.value.type
  band    = each.value.band
  htmode  = each.value.htmode
  channel = each.value.channel
  country = each.value.country
}

resource "uapi_wireless_interface" "this" {
  for_each = var.wireless_interfaces
  provider = uapi

  id      = "wifi_${replace(lower(each.key), "-", "_")}"
  device  = uapi_wireless_device.this[each.value.radio].id
  network = uapi_network_interface.this[each.value.network].id
  mode    = each.value.mode
  ssid    = each.value.ssid

  encryption = each.value.encryption
  key        = each.value.key
  hidden     = each.value.hidden
  isolate    = each.value.isolate
}

# ponytail: if the box has already run OpenWrt's first-boot radio detection,
# stock radio0/radio1 sections may already exist. Adopt via a root-level
# import block (see imports.tf — import blocks are root-module only) rather
# than hitting the same 422 lan/wan collision hits.
