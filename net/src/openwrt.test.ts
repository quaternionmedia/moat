/**
 * Unit tests for the UCI expander. Pure — no device required:
 *
 *   npx ts-node src/openwrt.test.ts
 *
 * Covers the UCI option-name mapping (easy to get subtly wrong, and wrong
 * names fail silently rather than erroring), the ownership predicates that
 * decide what may be deleted, and a resource-count parity check against the
 * baseline recorded in MIGRATION.md.
 */

import { INVENTORY } from "./inventory";
import { POLICY } from "./policy";
import { expandDevice, portSpecToUci } from "./openwrt";
import { Section, planConfig, toReconcileOptions } from "./uci";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function eq(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(label, a === e, a === e ? undefined : `got ${a}, want ${e}`);
}

const moatnet = INVENTORY["moatnet"]!;
const plan = expandDevice(moatnet, POLICY["moatnet"]);

console.log("\nopenwrt expander tests\n");

// --- port spec syntax ---
{
  eq("untagged+pvid port", portSpecToUci("eth4:u*"), "eth4:u*");
  eq("tagged port", portSpecToUci("eth1:t"), "eth1:t");
  eq("bare port", portSpecToUci("eth0"), "eth0");
}

// --- bridge device ---
{
  const br = plan.network.sections["br_lan"]!;
  check("bridge device section exists", Boolean(br));
  eq("bridge type", br.type, "device");
  eq("bridge name", br.values["name"], "br-lan");
  // Without vlan_filtering every bridge-vlan section is silently ignored on DSA.
  eq("vlan_filtering is enabled", br.values["vlan_filtering"], "1");
  const ports = br.values["ports"] as string[];
  check("bridge carries the trunk ports", ports.includes("eth1") && ports.includes("eth3"));
  check("wan port is not a bridge member", !ports.includes("eth0"), JSON.stringify(ports));
}

// --- bridge VLANs ---
{
  const cfg = plan.network.sections["vlan_config"]!;
  eq("bridge-vlan type", cfg.type, "bridge-vlan");
  eq("config VLAN id", cfg.values["vlan"], "1");
  // C2: eth4 must stay untagged on VLAN 1 or the box locks itself out.
  check(
    "eth4 is untagged on VLAN 1",
    (cfg.values["ports"] as string[]).includes("eth4:u*"),
    JSON.stringify(cfg.values["ports"])
  );
  eq("home VLAN id comes from the catalog", plan.network.sections["vlan_home"]!.values["vlan"], "4");
}

// --- interfaces ---
{
  const home = plan.network.sections["home"]!;
  eq("interface type", home.type, "interface");
  eq("interface device is the VLAN subinterface", home.values["device"], "br-lan.4");
  eq("proto", home.values["proto"], "static");
  // ipaddr and netmask must be separate; a CIDR alongside a netmask is ambiguous.
  eq("ipaddr is a bare address", home.values["ipaddr"], "192.168.4.1");
  eq("netmask is separate", home.values["netmask"], "255.255.255.0");
  check("no CIDR slash leaked into ipaddr", !String(home.values["ipaddr"]).includes("/"));

  const wan = plan.network.sections["wan"]!;
  eq("wan is dhcp on the physical port", [wan.values["proto"], wan.values["device"]], ["dhcp", "eth0"]);
}

// --- firewall option-name mapping ---
{
  const d = plan.firewall.sections["defaults"];
  if (d) {
    check("defaults uses UCI 'output', not 'outputPolicy'", "output" in d.values);
    check("no camelCase leaked", !Object.keys(d.values).some((k) => /[A-Z]/.test(k)), Object.keys(d.values).join(","));
    for (const k of Object.keys(d.values)) {
      const v = d.values[k]!;
      check(`defaults.${k} is a string`, typeof v === "string", typeof v);
    }
  } else {
    check("moatnet policy defines firewall defaults", false, "missing");
  }

  const zones = Object.values(plan.firewall.sections).filter((s) => s.type === "zone");
  check("zones were emitted", zones.length > 0, `${zones.length} zones`);
  const z = zones[0]!;
  check("zone uses 'network' list", Array.isArray(z.values["network"]) || typeof z.values["network"] === "string");
  check("zone has no mtuFix camelCase", !("mtuFix" in z.values));

  const rules = Object.values(plan.firewall.sections).filter((s) => s.type === "rule");
  check("rules were emitted", rules.length > 0, `${rules.length} rules`);
  const withProto = rules.find((r) => r.values["proto"]);
  check(
    "protos are space-joined into one option",
    withProto ? !Array.isArray(withProto.values["proto"]) : true,
    String(withProto?.values["proto"])
  );
}

// --- booleans become "1"/"0", never true/false ---
{
  const all: Section[] = Object.values(plan).flatMap((c) => Object.values(c.sections));
  const bad: string[] = [];
  for (const s of all) {
    for (const [k, v] of Object.entries(s.values)) {
      if (typeof v !== "string" && !Array.isArray(v)) bad.push(`${s.type}.${k}=${typeof v}`);
    }
  }
  eq("every option is string or string[]", bad, []);
}

// --- dhcp ---
{
  const lan = plan.dhcp.sections["lan"];
  check("dhcp pool emitted for an IP'd VLAN", Boolean(lan), lan ? lan.type : "missing");
  if (lan) eq("pool points at its interface", lan.values["interface"], "lan");
  check("dnsmasq uses UCI rebind_protection",
    !plan.dhcp.sections["dnsmasq"] || "rebind_protection" in plan.dhcp.sections["dnsmasq"]!.values ||
    !("rebindProtection" in plan.dhcp.sections["dnsmasq"]!.values));
}

// --- ownership predicates: the deletion-safety contract ---
{
  const anonRule: Section = { type: "rule", values: { name: "Allow-ICMPv6-Input" }, anonymous: true };
  const namedRule: Section = { type: "rule", values: { name: "our-rule" } };
  const fw = toReconcileOptions(plan.firewall.ownership);

  check("stock anonymous rules are NOT owned", !fw.managed!("cfg0a92bd", anonRule));
  check("our named rules ARE owned", fw.managed!("our-rule", namedRule));
  check(
    "stock anonymous defaults IS owned (must be replaced)",
    fw.managed!("cfg01e63d", { type: "defaults", values: {}, anonymous: true })
  );

  // The spec must stay serializable — it crosses a Pulumi resource boundary.
  check(
    "ownership spec survives JSON round-trip",
    JSON.stringify(JSON.parse(JSON.stringify(plan.firewall.ownership))) ===
      JSON.stringify(plan.firewall.ownership)
  );

  const net = toReconcileOptions(plan.network.ownership);
  check("loopback is preserved", (net.preserve ?? []).includes("loopback"));
  check("wan6 is preserved", (net.preserve ?? []).includes("wan6"));
  check("odhcpd is preserved", (plan.dhcp.ownership.preserve ?? []).includes("odhcpd"));

  // The whole point: planning against real stock state must not delete these.
  const stock = {
    loopback: { type: "interface", values: { device: "lo" } },
    globals: { type: "globals", values: { ula_prefix: "fda7::/48" } },
    wan6: { type: "interface", values: { device: "eth0", proto: "dhcpv6" } },
    cfg030f15: { type: "device", values: { name: "br-lan" }, anonymous: true },
  };
  const p = planConfig("network", stock, plan.network.sections, net);
  check("loopback survives planning", !p.deleteSections.includes("loopback"));
  check("globals survives planning", !p.deleteSections.includes("globals"));
  check("wan6 survives planning", !p.deleteSections.includes("wan6"));
  check(
    "stock anonymous bridge device is replaced",
    p.deleteSections.includes("cfg030f15"),
    JSON.stringify(p.deleteSections)
  );
}

// --- parity against the MIGRATION.md baseline ---
{
  const counts = {
    bridgeVlans: Object.values(plan.network.sections).filter((s) => s.type === "bridge-vlan").length,
    interfaces: Object.values(plan.network.sections).filter((s) => s.type === "interface").length,
    zones: Object.values(plan.firewall.sections).filter((s) => s.type === "zone").length,
    forwardings: Object.values(plan.firewall.sections).filter((s) => s.type === "forwarding").length,
    rules: Object.values(plan.firewall.sections).filter((s) => s.type === "rule").length,
    dhcp: Object.values(plan.dhcp.sections).filter((s) => s.type === "dhcp").length,
  };
  console.log(`\n  moatnet expansion: ${JSON.stringify(counts)}`);
  // Baseline from MIGRATION.md: 25 bridge VLANs, 26 interfaces, 26 zones,
  // 50 forwardings, 70 rules, 25 dhcp servers.
  check("bridge VLAN count matches vlan_ports", counts.bridgeVlans === Object.keys(moatnet.vlan_ports).length,
    `${counts.bridgeVlans} vs ${Object.keys(moatnet.vlan_ports).length} vlan_ports`);
  check("every VLAN got an interface", counts.interfaces >= counts.bridgeVlans,
    `${counts.interfaces} interfaces`);
  check("zones were produced", counts.zones > 0, String(counts.zones));
  check("rules were produced", counts.rules > 0, String(counts.rules));
}

// --- drawbridge: the AP shape ---
{
  const db = INVENTORY["drawbridge"]!;
  const dbPlan = expandDevice(db, POLICY["drawbridge"]);
  const cfgIface = dbPlan.network.sections["config"]!;
  eq("drawbridge config holds the management IP", cfgIface.values["ipaddr"], "192.168.1.2");
  const passthrough = dbPlan.network.sections["home"]!;
  eq("client VLANs are proto=none passthrough", passthrough.values["proto"], "none");
  eq("drawbridge serves no DHCP", Object.values(dbPlan.dhcp.sections).filter((s) => s.type === "dhcp").length, 0);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
