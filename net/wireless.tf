# Wireless radios + SSIDs on Drawbridge.
#
# ponytail: if this hardware has already completed OpenWrt's first-boot radio
# detection, stock `radio0`/`radio1` device sections may already exist (like
# lan/wan) and creating them again will 422. If so, import them the same way
# as imports.tf: `tofu import uapi_wireless_device.radio_2g radio0`.

resource "uapi_wireless_device" "radio_2g" {
  provider = uapi.drawbridge
  id       = "radio0"
  type     = "mac80211"
  band     = "2g"
  htmode   = "HT20"
}

resource "uapi_wireless_device" "radio_5g" {
  provider = uapi.drawbridge
  id       = "radio1"
  type     = "mac80211"
  band     = "5g"
  htmode   = "VHT80"
}

locals {
  # Flatten {ssid => {bands = [...]}} into one entry per (ssid, band) pair,
  # since each band needs its own wifi-iface section.
  wifi_ifaces = merge([
    for ssid, cfg in var.wireless_ssids : {
      for band in cfg.bands : "${ssid}_${band}" => merge(cfg, {
        ssid_name = ssid
        band      = band
      })
    }
  ]...)
}

resource "uapi_wireless_interface" "ssid" {
  for_each = local.wifi_ifaces
  provider = uapi.drawbridge

  id      = "wifi_${replace(lower(each.key), "-", "_")}"
  device  = each.value.band == "2g" ? uapi_wireless_device.radio_2g.id : uapi_wireless_device.radio_5g.id
  mode    = "ap"
  ssid    = each.value.ssid_name
  network = uapi_network_interface.drawbridge_client[each.value.vlan].id

  encryption = each.value.encryption
  key        = var.wireless_keys[each.value.ssid_name]
  hidden     = each.value.hidden
  isolate    = each.value.isolate
}
