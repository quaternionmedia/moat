/**
 * Expand a device + policy into OpenWrt UCI sections.
 *
 * This is the vendor-specific layer: `vlans.ts`, `policy.ts` and `inventory.ts`
 * stay vendor-neutral, and this file is the only place that knows UCI option
 * names. A future `mikrotik.ts` would sit beside it consuming the same inputs.
 *
 * Output is plain data — no Pulumi, no I/O — so the whole expansion is unit
 * testable without a router.
 *
 * ## Section naming and ownership
 *
 * Reconciliation needs a stable identity per section across runs, and UCI's
 * answer to that is *named* sections. Stock OpenWrt is inconsistent about it,
 * verified on the target device:
 *
 *   network   named: lan, wan, globals, loopback, wan6   anonymous: br-lan `device`
 *   firewall  named: (none)                              anonymous: all 13 sections
 *   dhcp      named: lan, wan, odhcpd                    anonymous: dnsmasq
 *
 * So ownership is decided per section *type*:
 *
 * - Types we fully own (`bridge-vlan`, `zone`, `forwarding`, `interface`,
 *   `dhcp`, `wifi-device`, `wifi-iface`): ours to create, update and prune.
 * - Singleton types where stock ships an anonymous section we must replace
 *   (`defaults`, `dnsmasq`, `device`): the anonymous one is pruned and a named
 *   one written, because two `defaults` sections is not a valid firewall and
 *   because the bridge needs `vlan_filtering` set.
 * - `rule`: owned only when *named*. Stock's rules are anonymous, and they are
 *   deliberately preserved — see below.
 *
 * ## Why stock firewall rules are preserved
 *
 * `policy.ts` covers icmp/tcp/udp only. It has no ICMPv6, DHCPv6, MLD, IGMP or
 * IPSec rules, while the device has a live `wan6` and a ULA prefix. Deleting
 * stock's anonymous rules would therefore break IPv6 neighbour discovery and
 * DHCPv6 outright, and drop IGMP — which matters on this network, whose
 * `audio_studio` VLAN carries Dante/AES67 multicast.
 *
 * Preserving them is the safe default, not the correct end state: the right
 * fix is to port those protocol allows into `policy.ts` so it is genuinely
 * complete, then flip `ownAnonymousRules` on. Until then we coexist.
 */

import { Device, effectiveDhcpVlans, effectiveIpVlans } from "./inventory";
import { DevicePolicy } from "./policy";
import { VLAN_NETWORKS } from "./vlans";
import { ReconcileOptions, Section, Sections } from "./uci";

/** UCI is string-typed on disk; booleans are "1"/"0". */
const bool = (v: boolean | undefined): string | undefined =>
  v === undefined ? undefined : v ? "1" : "0";
const num = (v: number | undefined): string | undefined =>
  v === undefined ? undefined : String(v);

/** Drop undefined options so they are absent rather than empty in UCI. */
function opts(o: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

const sec = (type: string, values: Record<string, string | string[] | undefined>): Section => ({
  type,
  values: opts(values),
});

export interface ManagedConfig {
  sections: Sections;
  /** Ownership policy for this config file, consumed by planConfig(). */
  reconcile: ReconcileOptions;
}

export type UciConfigName = "network" | "firewall" | "dhcp" | "wireless";
export type UciPlan = Record<UciConfigName, ManagedConfig>;

export interface ExpandOptions {
  /**
   * Take ownership of stock's anonymous firewall rules and prune them. Leave
   * false until policy.ts covers IPv6/IGMP/IPSec — see the file header.
   */
  ownAnonymousRules?: boolean;
}

/** Parse a port spec like "eth0:u*" / "eth1:t" into its UCI port string. */
export function portSpecToUci(spec: string): string {
  const [port, tag] = spec.split(":");
  if (!tag) return port;
  // UCI bridge-vlan syntax: "eth0:t" tagged, "eth0:u*" untagged+PVID.
  if (tag.includes("u")) return `${port}:u*`;
  if (tag === "t") return `${port}:t`;
  return port;
}

/** Physical ports the bridge must carry, derived from every VLAN's members. */
function bridgePorts(device: Device): string[] {
  const ports = new Set<string>();
  for (const specs of Object.values(device.vlan_ports)) {
    for (const spec of specs) ports.add(spec.split(":")[0]);
  }
  // The WAN uplink is standalone, never a bridge member.
  if (device.wan_port) ports.delete(device.wan_port);
  return [...ports].sort();
}

function vlanId(name: string): number {
  const v = VLAN_NETWORKS[name as keyof typeof VLAN_NETWORKS];
  if (!v) throw new Error(`VLAN '${name}' not found in VLAN catalog`);
  return v.id;
}

/** network: bridge device, bridge-vlans, interfaces, wan. */
function expandNetwork(device: Device): ManagedConfig {
  const sections: Sections = {};
  const bridge = device.bridge ?? "br-lan";

  // Own the bridge device definition. vlan_filtering is mandatory on DSA —
  // without it every bridge-vlan section below is silently ignored.
  sections["br_lan"] = sec("device", {
    name: bridge,
    type: "bridge",
    ports: bridgePorts(device),
    vlan_filtering: "1",
  });

  for (const [vlanName, specs] of Object.entries(device.vlan_ports)) {
    sections[`vlan_${vlanName}`] = sec("bridge-vlan", {
      device: bridge,
      vlan: String(vlanId(vlanName)),
      ports: specs.map(portSpecToUci),
    });
  }

  const ipVlans = effectiveIpVlans(device);
  for (const [vlanName, cfg] of Object.entries(ipVlans)) {
    const v = VLAN_NETWORKS[vlanName as keyof typeof VLAN_NETWORKS];
    if (!v) throw new Error(`VLAN '${vlanName}' not found in VLAN catalog`);
    // UCI wants ipaddr and netmask as separate options; a CIDR in ipaddr
    // alongside a netmask is ambiguous, so never emit both forms.
    const addrs = cfg.ipaddrs ?? [v.gateway];
    sections[vlanName] = sec("interface", {
      device: `${bridge}.${v.id}`,
      proto: "static",
      ...(addrs.length > 1 ? { ipaddr: addrs } : { ipaddr: addrs[0] }),
      netmask: cfg.netmask ?? v.netmask,
      gateway: cfg.gateway,
      dns: cfg.dns,
    });
  }

  // VLANs carried on ports but given no IP: proto=none passthrough, so they
  // can be bridged to an SSID without the device holding an address.
  const ipKeys = new Set(Object.keys(ipVlans));
  for (const vlanName of Object.keys(device.vlan_ports)) {
    if (ipKeys.has(vlanName)) continue;
    sections[vlanName] = sec("interface", {
      device: `${bridge}.${vlanId(vlanName)}`,
      proto: "none",
    });
  }

  if (device.wan_port) {
    sections["wan"] = sec("interface", { device: device.wan_port, proto: "dhcp" });
  }

  return {
    sections,
    reconcile: {
      prune: true,
      // loopback and the IPv6 wan are not ours and losing them hurts.
      preserve: ["loopback", "globals", "wan6"],
      managed: (_name, s) =>
        s.type === "bridge-vlan" || s.type === "interface" || s.type === "device",
    },
  };
}

/** firewall: defaults, zones, forwardings, rules. */
function expandFirewall(policy: Partial<DevicePolicy>, o: ExpandOptions): ManagedConfig {
  const sections: Sections = {};

  if (policy.defaults) {
    const d = policy.defaults;
    sections["defaults"] = sec("defaults", {
      input: d.input,
      output: d.outputPolicy,
      forward: d.forward,
      drop_invalid: bool(d.dropInvalid),
      syn_flood: bool(d.synFlood),
      synflood_rate: num(d.synfloodRate),
      synflood_burst: num(d.synfloodBurst),
      tcp_syncookies: bool(d.tcpSyncookies),
      flow_offloading: bool(d.flowOffloading),
      flow_offloading_hw: bool(d.flowOffloadingHw),
    });
  }

  for (const [zoneName, z] of Object.entries(policy.zones ?? {})) {
    sections[zoneName] = sec("zone", {
      name: zoneName,
      network: z.networks,
      input: z.input,
      output: z.outputPolicy ?? "ACCEPT",
      forward: z.forward,
      masq: bool(z.masq),
      mtu_fix: bool(z.mtuFix),
      family: z.family,
    });
  }

  for (const [fwdName, f] of Object.entries(policy.forwardings ?? {})) {
    sections[fwdName] = sec("forwarding", {
      src: f.src,
      dest: f.dest,
      enabled: bool(f.enabled),
      family: f.family,
    });
  }

  for (const [ruleName, r] of Object.entries(policy.rules ?? {})) {
    const m = r.match;
    sections[ruleName] = sec("rule", {
      name: r.name ?? ruleName,
      src: m.srcZone,
      dest: m.destZone,
      // firewall4 takes a space-separated proto list in one option.
      proto: m.protos?.join(" "),
      src_ip: m.srcIps,
      dest_ip: m.destIps,
      src_port: m.srcPorts,
      dest_port: m.destPorts,
      dscp: m.dscp,
      mark: m.mark,
      family: m.family,
      target: r.target,
    });
  }

  return {
    sections,
    reconcile: {
      prune: true,
      managed: (_name, s) => {
        // Stock ships one anonymous `defaults`; two is invalid, so replace it.
        if (s.type === "defaults") return true;
        if (s.type === "zone" || s.type === "forwarding") return true;
        // Ours are named, stock's are anonymous. Owning only named rules lets
        // us prune retired policy rules while leaving stock's IPv6/IGMP/IPSec
        // allows in place. See the file header.
        if (s.type === "rule") return o.ownAnonymousRules ? true : s.anonymous !== true;
        return false;
      },
    },
  };
}

/** dhcp: per-interface pools plus dnsmasq. */
function expandDhcp(device: Device, policy: Partial<DevicePolicy>): ManagedConfig {
  const sections: Sections = {};
  const ipVlans = effectiveIpVlans(device);

  for (const vlanName of effectiveDhcpVlans(device)) {
    // A pool on a VLAN with no address is meaningless.
    if (!ipVlans[vlanName]) continue;
    if (!VLAN_NETWORKS[vlanName as keyof typeof VLAN_NETWORKS]) continue;

    // ponytail: simple DHCP pool defaults. Adjust if needed for large networks.
    // Pool is .100–.200 (.1 = gateway, .2–.99 reserved for statics).
    sections[vlanName] = sec("dhcp", {
      interface: vlanName,
      start: "100",
      limit: "101",
      leasetime: "12h",
    });
  }

  if (policy.dnsmasq) {
    const d = policy.dnsmasq;
    sections["dnsmasq"] = sec("dnsmasq", {
      domain: d.domain,
      domainneeded: bool(d.domainneeded),
      boguspriv: bool(d.boguspriv),
      rebind_protection: bool(d.rebindProtection),
      expandhosts: bool(d.expandhosts),
      authoritative: bool(d.authoritative),
    });
  }

  return {
    sections,
    reconcile: {
      prune: true,
      // odhcpd serves IPv6; it is not ours and removing it breaks SLAAC/DHCPv6.
      // `wan` is stock's `option ignore 1` section telling dnsmasq not to serve
      // DHCP on the uplink. We never manage WAN DHCP, so deleting it would be
      // an unintended change to the gateway's uplink — preserve it.
      preserve: ["odhcpd", "wan"],
      managed: (_name, s) => s.type === "dhcp" || s.type === "dnsmasq",
    },
  };
}

/** wireless: radios and SSIDs. */
function expandWireless(device: Device): ManagedConfig {
  const sections: Sections = {};

  for (const [radioKey, r] of Object.entries(device.wireless?.radios ?? {})) {
    sections[radioKey] = sec("wifi-device", {
      type: r.type ?? "mac80211",
      band: r.band,
      htmode: r.htmode,
    });
  }

  for (const [ssidName, s] of Object.entries(device.wireless?.ssids ?? {})) {
    for (const radioKey of s.radios) {
      sections[`${ssidName}_${radioKey}`] = sec("wifi-iface", {
        device: radioKey,
        network: s.vlan,
        mode: "ap",
        ssid: ssidName,
        encryption: s.encryption ?? "sae-mixed",
        key: s.key,
        hidden: bool(s.hidden ?? false),
        isolate: bool(s.isolate ?? false),
      });
    }
  }

  return {
    sections,
    reconcile: {
      prune: true,
      managed: (_name, s) => s.type === "wifi-device" || s.type === "wifi-iface",
    },
  };
}

/**
 * Expand a device into the four UCI config files it owns, each with the
 * ownership policy the reconciler needs.
 */
export function expandDevice(
  device: Device,
  policy: Partial<DevicePolicy> = {},
  options: ExpandOptions = {}
): UciPlan {
  return {
    network: expandNetwork(device),
    firewall: expandFirewall(policy, options),
    dhcp: expandDhcp(device, policy),
    wireless: expandWireless(device),
  };
}
