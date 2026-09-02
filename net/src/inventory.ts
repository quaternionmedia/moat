/**
 * THE device list. Add a device by adding an entry here — no new resource
 * blocks, no new provider block, no new module block required.
 *
 * `role` is advisory only (validated for obviously-wrong combinations,
 * and readable in monitoring) — it is never used to branch behavior.
 * Every actual difference between devices is data: which VLANs get an IP,
 * which get a DHCP pool, which stock sections need adopting.
 */

import { VlanName } from "./vlans";

export interface InterfaceConfig {
  ipaddrs?: string[];
  netmask?: string;
  gateway?: string;
  dns?: string[];
}

export interface RadioConfig {
  type?: string; // default: "mac80211"
  band?: string; // "2g" | "5g"
  htmode?: string;
}

export interface SSIDConfig {
  vlan: VlanName;
  radios: string[]; // keys into wireless.radios
  encryption?: string; // default: "sae-mixed"
  key?: string; // WiFi password
  hidden?: boolean; // default: false
  isolate?: boolean; // default: false
}

export interface WirelessConfig {
  radios?: Record<string, RadioConfig>;
  ssids?: Record<string, SSIDConfig>;
}

export interface AdoptConfig {
  interfaces?: string[];
  firewall_zones?: string[];
  dhcp_servers?: string[];
  wireless_radios?: string[];
}

export interface Device {
  endpoint: string;
  role: "router" | "ap" | string;
  platform?: string; // default: "openwrt"
  enabled?: boolean; // default: true
  insecure?: boolean; // default: true
  bridge?: string; // default: "br-lan"
  wan_port?: string; // null => no standalone WAN interface

  // Bridge-VLAN port membership, keyed by VLAN name.
  // "u*" = untagged/native, "t" = tagged.
  vlan_ports: Record<VlanName | string, string[]>;

  // Which of those VLANs get a real network_interface, and with what
  // overrides. null => every vlan_ports key gets one, address = the VLAN's
  // .1 gateway from the catalog (the mechanical default for a device that
  // IS that VLAN's router).
  ip_vlans?: Record<VlanName | string, InterfaceConfig>;

  // Which ip_vlans additionally get a uapi_dhcp_server. null => same set as
  // ip_vlans (mechanical default). Explicit [] => none (an AP serving no
  // DHCP of its own).
  dhcp_vlans?: string[];

  // Stock named sections to adopt instead of create — a create colliding
  // with an existing name returns 422.
  adopt?: AdoptConfig;

  // Present only on devices that broadcast WiFi.
  wireless?: WirelessConfig;
}

export const INVENTORY: Record<string, Device> = {
  moatnet: {
    endpoint: "https://192.168.1.1/api/v3",
    role: "router",
    bridge: "br-lan",
    wan_port: "eth0",

    // eth0 = WAN uplink (standalone, not bridged — handled via wan_port)
    // eth1 = Drawbridge trunk   eth2 = Keep trunk   eth3 = Bailey trunk
    // eth4 = Config access port (untagged VLAN 1 — the guaranteed way back in)
    vlan_ports: {
      config: ["eth1:u*", "eth2:t", "eth3:t", "eth4:u*"],
      lan: ["eth1:t", "eth2:u*"],
      home: ["eth1:t", "eth2:t"],
      work: ["eth1:t", "eth2:t"],
      guest: ["eth1:t"],
      lab: ["eth3:u*"],
      k8s: ["eth3:t"],
      qm: ["eth2:t"],

      lights: ["eth3:t"],
      lights_moat: ["eth3:t"],
      lights_studio: ["eth3:t"],
      lights_halloween: ["eth3:t"],
      lights_home: ["eth3:t"],

      audio: ["eth3:t"],
      audio_moat: ["eth3:t"],
      audio_studio: ["eth3:t"],
      audio_halloween: ["eth3:t"],
      audio_home: ["eth3:t"],

      video: ["eth3:t"],
      video_moat: ["eth3:t"],
      video_studio: ["eth3:t"],
      video_halloween: ["eth3:t"],
      video_home: ["eth3:t"],

      kubernetes: ["eth3:t"],
      iot: ["eth1:t", "eth3:t"],
    },

    // ip_vlans / dhcp_vlans left null: MoatNet is the gateway and DHCP
    // server for every VLAN it bridges — the mechanical default.

    adopt: {
      interfaces: [],
      firewall_zones: [],
      dhcp_servers: [],
    },
  },

  drawbridge: {
    endpoint: "https://192.168.1.2/api/v3",
    role: "ap",
    bridge: "br-lan",
    enabled: false,
    // No wan_port — Drawbridge's only port is the uplink to MoatNet eth1.

    vlan_ports: {
      config: ["eth0:u*"], // management — untagged, or the AP self-locks
      lan: ["eth0:t"],
      home: ["eth0:t"],
      work: ["eth0:t"],
      guest: ["eth0:t"],
      iot: ["eth0:t"],
    },

    // Only "config" gets a real IP — the single management address.
    // Client VLANs are bridged straight to WiFi with no IP.
    ip_vlans: {
      config: {
        ipaddrs: ["192.168.1.2"],
        gateway: "192.168.1.1",
        dns: ["192.168.1.1"],
      },
    },
    dhcp_vlans: [], // Drawbridge serves no DHCP of its own.

    adopt: {
      interfaces: ["lan"], // stock `lan` collides with our client-VLAN `lan`
      // wireless_radios left empty: run `uci show wireless` on the AP first —
      // if radio0/radio1 already exist from first-boot detection, list them here.
    },

    wireless: {
      radios: {
        radio0: { band: "2g", htmode: "HT20" },
        radio1: { band: "5g", htmode: "VHT80" },
      },
      // "Lab" -> the `lan` VLAN (3), the trusted primary.
      ssids: {
        Lab: { vlan: "lan", radios: ["radio0", "radio1"] },
        "Lab-home": {
          vlan: "home",
          radios: ["radio0", "radio1"],
        },
        "Lab-work": {
          vlan: "work",
          radios: ["radio0", "radio1"],
        },
        "Lab-guest": {
          vlan: "guest",
          radios: ["radio0", "radio1"],
          isolate: true,
        },
        "Lab-iot": {
          vlan: "iot",
          radios: ["radio0"],
          encryption: "psk2",
          hidden: true,
          isolate: true,
        },
      },
    },
  },
};

/**
 * Platform filter — the seam a future non-OpenWrt module block would reuse.
 */
export function filterByPlatform(
  devices: Record<string, Device>,
  platform: string
): Record<string, Device> {
  return Object.fromEntries(
    Object.entries(devices).filter(([, dev]) => (dev.platform ?? "openwrt") === platform)
  );
}

/**
 * Filter to enabled devices only (F3's mitigation for retirement deadlock).
 */
export function filterEnabled(
  devices: Record<string, Device>
): Record<string, Device> {
  return Object.fromEntries(
    Object.entries(devices).filter(([, dev]) => dev.enabled !== false)
  );
}

/**
 * Resolve ip_vlans with null-defaults: unspecified VLAN gets no IP config
 * (placeholder object). This lets the module decide whether to create a real
 * interface or a passthrough.
 */
export function effectiveIpVlans(device: Device): Record<string, InterfaceConfig> {
  if (device.ip_vlans) {
    return device.ip_vlans;
  }
  // Default: every vlan_ports key gets an entry with null overrides
  return Object.fromEntries(
    Object.keys(device.vlan_ports).map((vk) => [
      vk,
      { ipaddrs: undefined, netmask: undefined, gateway: undefined, dns: undefined },
    ])
  );
}

/**
 * Resolve dhcp_vlans with null-defaults: unspecified list defaults to all
 * of ip_vlans.
 */
export function effectiveDhcpVlans(device: Device): Set<string> {
  if (device.dhcp_vlans) {
    return new Set(device.dhcp_vlans);
  }
  // Default: all ip_vlans
  return new Set(Object.keys(effectiveIpVlans(device)));
}
