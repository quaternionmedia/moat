/**
 * OpenwrtDevice ComponentResource: a factory that expands device config
 * (inventory + policy) into the full set of uapi resources.
 *
 * The resource is driven by:
 * - device.vlan_ports: which VLANs go on which physical ports
 * - device.ip_vlans: which VLANs get IPs (driver for network_interface)
 * - device.dhcp_vlans: which VLANs get DHCP (driver for dhcp_server)
 * - device.wireless: radios and SSIDs
 * - policy: firewall zones, forwardings, rules, defaults, dnsmasq
 *
 * All inputs are plain data — no branching on role anywhere.
 */

import * as pulumi from "@pulumi/pulumi";
import * as uapi from "@pulumi/uapi";
import { Device, effectiveDhcpVlans, effectiveIpVlans } from "./inventory";
import { DevicePolicy } from "./policy";
import { VLAN_NETWORKS, VlanName } from "./vlans";

export interface OpenwrtDeviceArgs {
  device: Device;
  vlans: typeof VLAN_NETWORKS;
  policy?: Partial<DevicePolicy>;
}

/**
 * Parse a port specifier like "eth0:u*" or "eth1:t" into device and tagging.
 */
function parsePort(portSpec: string): { port: string; tagged: boolean; native: boolean } {
  const [port, tag] = portSpec.split(":");
  if (!tag) {
    return { port, tagged: false, native: false };
  }
  return {
    port,
    tagged: tag === "t",
    native: tag.includes("u"),
  };
}

/**
 * Compute bridge VLAN port membership from device.vlan_ports.
 * Each VLAN specifies which ports carry its traffic and how (tagged/untagged).
 */
function computeBridgeVlans(
  device: Device,
  vlans: typeof VLAN_NETWORKS
): Record<string, { vlan: number; ports: string[] }> {
  const result: Record<string, { vlan: number; ports: string[] }> = {};

  for (const [vlanName, portSpecs] of Object.entries(device.vlan_ports)) {
    const vlanId = vlans[vlanName as keyof typeof vlans]?.id;
    if (!vlanId) {
      throw new Error(`VLAN '${vlanName}' not found in VLAN catalog`);
    }

    const ports: string[] = [];
    for (const spec of portSpecs) {
      const { port, tagged, native } = parsePort(spec);
      // Build port string: "eth0" (untagged), "eth0:t" (tagged), "eth0:u*" (native)
      if (native) {
        ports.push(`${port}:u*`);
      } else if (tagged) {
        ports.push(`${port}:t`);
      } else {
        ports.push(port);
      }
    }

    result[vlanName] = { vlan: vlanId, ports };
  }

  return result;
}

/**
 * Compute network interface config from device.vlan_ports and device.ip_vlans.
 * VLANs in ip_vlans get real interfaces (either with user config or catalog defaults).
 * VLANs only in vlan_ports get proto=none passthrough (for wireless bridging).
 */
function computeInterfaces(
  device: Device,
  vlans: typeof VLAN_NETWORKS
): Record<
  string,
  {
    proto: string;
    device?: string;
    ipaddrs?: string[];
    netmask?: string;
    gateway?: string;
    dns?: string[];
  }
> {
  const result: Record<string, any> = {};
  const effectiveIp = effectiveIpVlans(device);

  // Interfaces that get IPs (from ip_vlans)
  for (const [vlanName, config] of Object.entries(effectiveIp)) {
    const vlanCatalog = vlans[vlanName as keyof typeof vlans];
    if (!vlanCatalog) {
      throw new Error(`VLAN '${vlanName}' not found in VLAN catalog`);
    }

    result[vlanName] = {
      proto: "static",
      device: `${device.bridge}.${vlanCatalog.id}`,
      ipaddrs: config.ipaddrs ?? [`${vlanCatalog.gateway}/${vlanCatalog.prefix}`],
      netmask: config.netmask ?? vlanCatalog.netmask,
      gateway: config.gateway,
      dns: config.dns,
    };
  }

  // Passthrough interfaces (in vlan_ports but NOT in ip_vlans)
  const ipVlanKeys = new Set(Object.keys(effectiveIp));
  for (const vlanName of Object.keys(device.vlan_ports)) {
    if (!ipVlanKeys.has(vlanName)) {
      const vlanCatalog = vlans[vlanName as keyof typeof vlans];
      if (!vlanCatalog) continue;

      // proto=none allows VLAN to be bridged to WiFi without an IP
      result[vlanName] = {
        proto: "none",
        device: `${device.bridge}.${vlanCatalog.id}`,
      };
    }
  }

  // WAN interface (if wan_port is specified)
  if (device.wan_port) {
    result["wan"] = {
      proto: "dhcp",
      device: device.wan_port,
    };
  }

  return result;
}

/**
 * Compute DHCP server config from device.dhcp_vlans.
 */
function computeDhcpServers(
  device: Device,
  vlans: typeof VLAN_NETWORKS
): Record<string, { interface: string; start: number; limit: number; leasetime: string }> {
  const result: Record<string, any> = {};
  const effectiveIp = effectiveIpVlans(device);
  const effectiveDhcp = effectiveDhcpVlans(device);

  for (const vlanName of effectiveDhcp) {
    if (!effectiveIp[vlanName]) {
      // DHCP on a VLAN with no IP doesn't make sense
      continue;
    }

    const vlanCatalog = vlans[vlanName as keyof typeof vlans];
    if (!vlanCatalog) continue;

    // ponytail: simple DHCP pool defaults. Adjust if needed for large networks.
    // Pool is .100–.200 (.1 = gateway, .2–.99 reserved for statics).
    const start = 100;
    const limit = 101;

    result[vlanName] = {
      interface: vlanName,
      start,
      limit,
      leasetime: "12h",
    };
  }

  return result;
}

/**
 * Compute wireless interface config from device.wireless.ssids.
 * Each SSID specifies which radio(s) and VLAN it attaches to.
 */
function computeWirelessInterfaces(
  device: Device
): Record<
  string,
  {
    radio: string;
    network: string;
    mode: string;
    ssid: string;
    encryption: string;
    key?: string;
    hidden: boolean;
    isolate: boolean;
  }
> {
  const result: Record<string, any> = {};

  if (!device.wireless?.ssids) return result;

  for (const [ssidName, ssidConfig] of Object.entries(device.wireless.ssids)) {
    for (const radioKey of ssidConfig.radios) {
      // Create a unique key: SSID-band (e.g., "Lab-2g", "Lab-guest-5g")
      const interfaceKey = `${ssidName}_${radioKey}`;

      result[interfaceKey] = {
        radio: radioKey,
        network: ssidConfig.vlan,
        mode: "ap",
        ssid: ssidName,
        encryption: ssidConfig.encryption ?? "sae-mixed",
        key: undefined, // ponytail: keys would come from Pulumi secrets
        hidden: ssidConfig.hidden ?? false,
        isolate: ssidConfig.isolate ?? false,
      };
    }
  }

  return result;
}

export class OpenwrtDevice extends pulumi.ComponentResource {
  // Exported resource names for debugging
  public bridgeVlans: Record<string, uapi.NetworkBridgeVlan> = {};
  public interfaces: Record<string, uapi.NetworkInterface> = {};
  public firewallZones: Record<string, uapi.FirewallZone> = {};
  public firewallForwardings: Record<string, uapi.FirewallForwarding> = {};
  public firewallRules: Record<string, uapi.FirewallRule> = {};
  public dhcpServers: Record<string, uapi.DhcpServer> = {};
  public wirelessDevices: Record<string, uapi.WirelessDevice> = {};
  public wirelessInterfaces: Record<string, uapi.WirelessInterface> = {};

  constructor(
    name: string,
    args: OpenwrtDeviceArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("moat:device:OpenwrtDevice", name, {}, opts);

    const parentOpts = { parent: this };
    const device = args.device;
    const policy: Partial<DevicePolicy> = args.policy ?? {};

    // Compute input maps
    const bridgeVlans = computeBridgeVlans(device, args.vlans);
    const interfaces = computeInterfaces(device, args.vlans);
    const dhcpServers = computeDhcpServers(device, args.vlans);
    const wirelessInterfaces = computeWirelessInterfaces(device);

    // Create bridge VLANs
    for (const [vlanName, vlanConfig] of Object.entries(bridgeVlans)) {
      this.bridgeVlans[vlanName] = new uapi.NetworkBridgeVlan(
        vlanName,
        {
          networkBridgeVlanId: vlanName,
          device: device.bridge ?? "br-lan",
          vlan: vlanConfig.vlan,
          ports: vlanConfig.ports,
        },
        parentOpts
      );
    }

    // Create network interfaces
    for (const [ifaceName, ifaceConfig] of Object.entries(interfaces)) {
      this.interfaces[ifaceName] = new uapi.NetworkInterface(
        ifaceName,
        {
          networkInterfaceId: ifaceName,
          proto: ifaceConfig.proto,
          device: ifaceConfig.device,
          ipaddrs: ifaceConfig.ipaddrs,
          netmask: ifaceConfig.netmask,
          gateway: ifaceConfig.gateway,
          dns: ifaceConfig.dns,
        },
        { ...parentOpts, import: device.adopt?.interfaces?.includes(ifaceName) ? ifaceName : undefined }
      );
    }

    // Create firewall defaults (if policy specifies any)
    if (policy.defaults) {
      new uapi.FirewallDefaults(
        "defaults",
        {
          input: policy.defaults.input,
          outputPolicy: policy.defaults.outputPolicy,
          forward: policy.defaults.forward,
          dropInvalid: policy.defaults.dropInvalid,
          synFlood: policy.defaults.synFlood,
          synfloodRate: policy.defaults.synfloodRate,
          synfloodBurst: policy.defaults.synfloodBurst,
          tcpSyncookies: policy.defaults.tcpSyncookies,
          flowOffloading: policy.defaults.flowOffloading,
          flowOffloadingHw: policy.defaults.flowOffloadingHw,
        },
        parentOpts
      );
    }

    // Create firewall zones
    for (const [zoneName, zoneConfig] of Object.entries(policy.zones ?? {})) {
      this.firewallZones[zoneName] = new uapi.FirewallZone(
        zoneName,
        {
          firewallZoneId: zoneName,
          name: zoneName,
          networks: zoneConfig.networks.map((net) => this.interfaces[net]?.networkInterfaceId ?? net),
          input: zoneConfig.input as any,
          forward: zoneConfig.forward as any,
          outputPolicy: zoneConfig.outputPolicy as any,
          masq: zoneConfig.masq,
          mtuFix: zoneConfig.mtuFix,
          family: zoneConfig.family,
        },
        { ...parentOpts, import: device.adopt?.firewall_zones?.includes(zoneName) ? zoneName : undefined }
      );
    }

    // Create firewall forwardings
    for (const [fwdName, fwdConfig] of Object.entries(policy.forwardings ?? {})) {
      this.firewallForwardings[fwdName] = new uapi.FirewallForwarding(
        fwdName,
        {
          firewallForwardingId: fwdName,
          src: this.firewallZones[fwdConfig.src]?.firewallZoneId ?? fwdConfig.src,
          dest: this.firewallZones[fwdConfig.dest]?.firewallZoneId ?? fwdConfig.dest,
          enabled: fwdConfig.enabled,
          family: fwdConfig.family,
        },
        parentOpts
      );
    }

    // Create firewall rules
    for (const [ruleName, ruleConfig] of Object.entries(policy.rules ?? {})) {
      this.firewallRules[ruleName] = new uapi.FirewallRule(
        ruleName,
        {
          firewallRuleId: ruleName,
          target: ruleConfig.target as any,
          match: {
            srcZone: ruleConfig.match.srcZone
              ? this.firewallZones[ruleConfig.match.srcZone]?.firewallZoneId
              : undefined,
            destZone: ruleConfig.match.destZone
              ? this.firewallZones[ruleConfig.match.destZone]?.firewallZoneId
              : undefined,
            protos: ruleConfig.match.protos,
            srcIps: ruleConfig.match.srcIps,
            destIps: ruleConfig.match.destIps,
            srcPorts: ruleConfig.match.srcPorts,
            destPorts: ruleConfig.match.destPorts,
            dscp: ruleConfig.match.dscp,
            mark: ruleConfig.match.mark,
            family: ruleConfig.match.family,
          },
        },
        parentOpts
      );
    }

    // Create DHCP servers
    for (const [dhcpName, dhcpConfig] of Object.entries(dhcpServers)) {
      this.dhcpServers[dhcpName] = new uapi.DhcpServer(
        dhcpName,
        {
          dhcpServerId: dhcpName,
          interface: this.interfaces[dhcpConfig.interface]?.networkInterfaceId ?? dhcpConfig.interface,
          start: dhcpConfig.start,
          limit: dhcpConfig.limit,
          leasetime: dhcpConfig.leasetime,
        },
        { ...parentOpts, import: device.adopt?.dhcp_servers?.includes(dhcpName) ? dhcpName : undefined }
      );
    }

    // Create dnsmasq (if policy specifies it)
    if (policy.dnsmasq) {
      new uapi.DhcpDnsmasq(
        "dnsmasq",
        {
          domain: policy.dnsmasq.domain,
          domainneeded: policy.dnsmasq.domainneeded,
          boguspriv: policy.dnsmasq.boguspriv,
          rebindProtection: policy.dnsmasq.rebindProtection,
          expandhosts: policy.dnsmasq.expandhosts,
          authoritative: policy.dnsmasq.authoritative,
        },
        parentOpts
      );
    }

    // Create wireless devices
    if (device.wireless?.radios) {
      for (const [radioKey, radioConfig] of Object.entries(device.wireless.radios)) {
        this.wirelessDevices[radioKey] = new uapi.WirelessDevice(
          radioKey,
          {
            wirelessDeviceId: radioKey,
            type: radioConfig.type ?? "mac80211",
            band: radioConfig.band,
            htmode: radioConfig.htmode,
          },
          { ...parentOpts, import: device.adopt?.wireless_radios?.includes(radioKey) ? radioKey : undefined }
        );
      }
    }

    // Create wireless interfaces (SSIDs)
    for (const [wifiName, wifiConfig] of Object.entries(wirelessInterfaces)) {
      this.wirelessInterfaces[wifiName] = new uapi.WirelessInterface(
        wifiName,
        {
          wirelessInterfaceId: wifiName,
          device: this.wirelessDevices[wifiConfig.radio]?.wirelessDeviceId ?? wifiConfig.radio,
          network: this.interfaces[wifiConfig.network]?.networkInterfaceId ?? wifiConfig.network,
          mode: wifiConfig.mode,
          ssid: wifiConfig.ssid,
          encryption: wifiConfig.encryption,
          key: wifiConfig.key,
          hidden: wifiConfig.hidden,
          isolate: wifiConfig.isolate,
        },
        parentOpts
      );
    }

    this.registerOutputs({
      bridgeVlans: this.bridgeVlans,
      interfaces: this.interfaces,
      firewallZones: this.firewallZones,
      firewallForwardings: this.firewallForwardings,
      firewallRules: this.firewallRules,
      dhcpServers: this.dhcpServers,
      wirelessDevices: this.wirelessDevices,
      wirelessInterfaces: this.wirelessInterfaces,
    });
  }
}
