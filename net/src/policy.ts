/**
 * Vendor-neutral network policy: which VLANs trust each other, and the
 * router's global settings. Expressed as plain data (VLAN names, zone names)
 * — never a uapi resource shape — so a second platform module could consume
 * this unchanged. Keyed by device NAME, not role: role stays advisory only.
 */

import { VlanName } from "./vlans";

// ── Trust tiers ──────────────────────────────────────────────────────────────

export const TRUSTED_VLANS = new Set<VlanName>([
  "config",
  "lan",
  "home",
  "work",
  "qm",
]);

export const BAILEY_VLANS = new Set<VlanName>(["k8s", "kubernetes", "lab"]);

export const ISOLATED_VLANS = new Set<VlanName>([
  "guest",
  "iot",
  "lights",
  "lights_moat",
  "lights_studio",
  "lights_halloween",
  "lights_home",
  "audio",
  "audio_moat",
  "audio_studio",
  "audio_halloween",
  "audio_home",
  "video",
  "video_moat",
  "video_studio",
  "video_halloween",
  "video_home",
]);

export const NO_INPUT_ACCEPT_VLANS = new Set([
  ...BAILEY_VLANS,
  ...ISOLATED_VLANS,
]);

// Home Assistant reaches its devices; devices cannot reach back (a forwarding
// is directional — conntrack handles the replies).
export const HA_DEVICE_VLANS = new Set<VlanName>([
  "iot",
  "lights",
  "lights_moat",
  "lights_studio",
  "lights_halloween",
  "lights_home",
  "audio",
  "audio_moat",
  "audio_studio",
  "audio_halloween",
  "audio_home",
  "video",
  "video_moat",
  "video_studio",
  "video_halloween",
  "video_home",
]);

// "Unrestricted" primaries: reachable from lan + home (Q4 default).
export const AV_PRIMARIES = new Set<VlanName>(["lights", "audio", "video"]);

// ── Zone definition ──────────────────────────────────────────────────────────

export interface Zone {
  networks: string[];
  input: "ACCEPT" | "DROP" | "REJECT";
  forward: "ACCEPT" | "DROP" | "REJECT";
  outputPolicy?: "ACCEPT" | "DROP";
  masq?: boolean;
  mtuFix?: boolean;
  family?: string;
}

// ── Forwarding definition ────────────────────────────────────────────────────

export interface Forwarding {
  src: string;
  dest: string;
  enabled?: boolean;
  family?: string;
}

// ── Rule definition ─────────────────────────────────────────────────────────

export interface RuleMatch {
  srcZone?: string;
  destZone?: string;
  protos?: string[];
  srcIps?: string[];
  destIps?: string[];
  srcPorts?: string[];
  destPorts?: string[];
  dscp?: string;
  mark?: string;
  family?: string;
}

export interface Rule {
  target: "ACCEPT" | "DROP" | "REJECT";
  match: RuleMatch;
  priority?: number;
  name?: string;
}

// ── Defaults definition ──────────────────────────────────────────────────────

export interface Defaults {
  input: "ACCEPT" | "DROP";
  outputPolicy: "ACCEPT" | "DROP";
  forward: "ACCEPT" | "DROP";
  dropInvalid?: boolean;
  synFlood?: boolean;
  synfloodRate?: number;
  synfloodBurst?: number;
  tcpSyncookies?: boolean;
  flowOffloading?: boolean;
  flowOffloadingHw?: boolean;
}

// ── Dnsmasq definition ───────────────────────────────────────────────────────

export interface Dnsmasq {
  domain?: string;
  domainneeded?: boolean;
  boguspriv?: boolean;
  rebindProtection?: boolean;
  expandhosts?: boolean;
  authoritative?: boolean;
}

// ── Policy bundle ────────────────────────────────────────────────────────────

export interface DevicePolicy {
  zones: Record<string, Zone>;
  forwardings: Record<string, Forwarding>;
  rules: Record<string, Rule>;
  defaults: Defaults;
  dnsmasq: Dnsmasq;
}

// ── MoatNet: the router's policy ─────────────────────────────────────────────

function buildMoatnetPolicy(): DevicePolicy {
  const zones: Record<string, Zone> = {
    wan: {
      networks: ["wan"],
      input: "DROP",
      forward: "DROP",
      masq: true,
      mtuFix: true,
    },
  };

  // Trusted zones
  for (const v of TRUSTED_VLANS) {
    zones[v] = { networks: [v], input: "ACCEPT", forward: "ACCEPT" };
  }

  // Bailey zones
  for (const v of BAILEY_VLANS) {
    zones[v] = { networks: [v], input: "DROP", forward: "DROP" };
  }

  // Isolated zones
  for (const v of ISOLATED_VLANS) {
    zones[v] = { networks: [v], input: "DROP", forward: "DROP" };
  }

  const forwardings: Record<string, Forwarding> = {};

  // All VLANs can reach WAN (egress)
  for (const v of [
    ...Array.from(TRUSTED_VLANS),
    ...Array.from(BAILEY_VLANS),
    ...Array.from(ISOLATED_VLANS),
  ]) {
    forwardings[`fwd_${v}_wan`] = { src: v, dest: "wan" };
  }

  // Home Assistant reaches its devices
  for (const v of HA_DEVICE_VLANS) {
    forwardings[`fwd_home_${v}`] = { src: "home", dest: v };
  }

  // LAN specifics
  forwardings["fwd_lan_video_moat"] = { src: "lan", dest: "video_moat" };
  for (const p of AV_PRIMARIES) {
    forwardings[`fwd_lan_${p}`] = { src: "lan", dest: p };
  }

  // Home AV access
  for (const p of AV_PRIMARIES) {
    forwardings[`fwd_home_${p}_av`] = { src: "home", dest: p };
  }

  // LAN to Kubernetes
  for (const v of ["k8s", "kubernetes"] as VlanName[]) {
    forwardings[`fwd_lan_${v}`] = { src: "lan", dest: v };
  }

  const rules: Record<string, Rule> = {};

  // ICMP (ping) from trusted zones
  for (const v of TRUSTED_VLANS) {
    rules[`ping_${v}`] = {
      target: "ACCEPT",
      match: { srcZone: v, protos: ["icmp"] },
    };
  }

  // DHCP from all zones
  for (const v of [
    ...Array.from(TRUSTED_VLANS),
    ...Array.from(NO_INPUT_ACCEPT_VLANS),
  ]) {
    rules[`dhcp_${v}`] = {
      target: "ACCEPT",
      match: {
        srcZone: v,
        protos: ["udp"],
        srcPorts: ["68"],
        destPorts: ["67"],
      },
    };
  }

  // DNS from non-trusted zones
  for (const v of NO_INPUT_ACCEPT_VLANS) {
    rules[`dns_${v}`] = {
      target: "ACCEPT",
      match: { srcZone: v, protos: ["tcp", "udp"], destPorts: ["53"] },
    };
  }

  // NTP from non-trusted zones
  for (const v of NO_INPUT_ACCEPT_VLANS) {
    rules[`ntp_${v}`] = {
      target: "ACCEPT",
      match: { srcZone: v, protos: ["udp"], destPorts: ["123"] },
    };
  }

  const defaults: Defaults = {
    input: "DROP",
    outputPolicy: "ACCEPT",
    forward: "DROP",
    dropInvalid: true,
    synFlood: true,
    synfloodRate: 25,
    synfloodBurst: 50,
    tcpSyncookies: true,
    flowOffloading: true,
    flowOffloadingHw: false, // ponytail: enable if hardware NAT-offload is confirmed present
  };

  const dnsmasq: Dnsmasq = {
    domain: "moat.local",
    domainneeded: true,
    boguspriv: true,
    rebindProtection: true,
    expandhosts: true,
    authoritative: true,
  };

  return { zones, forwardings, rules, defaults, dnsmasq };
}

// Keyed by device name, not role — lookups use a plain {} default, so an AP
// (or any future device absent here) gets no firewall resources without ever
// branching on `role`.
export const POLICY: Record<string, DevicePolicy> = {
  moatnet: buildMoatnetPolicy(),
};
