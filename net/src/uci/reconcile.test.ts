/**
 * Unit tests for the reconcile planner. Pure — no device required:
 *
 *   npx ts-node src/uci/reconcile.test.ts
 *
 * The cases that matter most are the pruning-safety ones. Getting those wrong
 * means deleting `loopback` or the br-lan `device` section on a live router,
 * so they are tested against the actual section layout read off moatnet.
 */

import { Section, Sections } from "./types";
import { isNoop, planConfig, summarize } from "./reconcile";

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

const sec = (type: string, values: Record<string, string | string[]>): Section => ({
  type,
  values,
});

/** The real stock layout of moatnet's `network`, as read from the device. */
const STOCK_NETWORK: Sections = {
  globals: sec("globals", { ula_prefix: "fda7:1b32:2665::/48", packet_steering: "1" }),
  loopback: sec("interface", { device: "lo", proto: "static", ipaddr: "127.0.0.1" }),
  cfg030f15: sec("device", { name: "br-lan", type: "bridge", ports: ["eth1", "eth2"] }),
  lan: sec("interface", { device: "br-lan", proto: "static", ipaddr: "192.168.1.1" }),
  wan: sec("interface", { device: "eth0", proto: "dhcp" }),
};

console.log("\nreconcile planner tests\n");

// --- basic create / update / unchanged ---
{
  const desired: Sections = {
    lan: sec("interface", { device: "br-lan", proto: "static", ipaddr: "192.168.1.1" }),
    vlan_home: sec("interface", { device: "br-lan.4", proto: "static", ipaddr: "192.168.4.1" }),
    wan: sec("interface", { device: "eth0", proto: "pppoe" }),
  };
  const p = planConfig("network", STOCK_NETWORK, desired);
  eq("creates only the new section", p.create, ["vlan_home"]);
  eq("updates only the changed section", p.update, [{ section: "wan", options: ["proto"] }]);
  eq("identical section is unchanged", p.unchanged, ["lan"]);
  check("plan is not a noop", !isNoop(p));
}

// --- the pruning-safety case ---
{
  // Desired holds only interfaces we model; globals/loopback/bridge are absent.
  const desired: Sections = { lan: STOCK_NETWORK["lan"]! };
  const p = planConfig("network", STOCK_NETWORK, desired);
  eq("nothing is deleted by default", p.deleteSections, []);
  eq(
    "unowned sections are reported, not touched",
    p.unmanaged,
    ["cfg030f15", "globals", "loopback", "wan"]
  );

  // Even opting into prune must not touch sections we do not claim.
  const pruned = planConfig("network", STOCK_NETWORK, desired, {
    prune: true,
    managed: (name) => name.startsWith("vlan_"),
  });
  eq("prune respects the managed predicate", pruned.deleteSections, []);
  check(
    "loopback and bridge survive an opt-in prune",
    pruned.unmanaged.includes("loopback") && pruned.unmanaged.includes("cfg030f15")
  );
}

// --- prune actually prunes what we do own ---
{
  const current: Sections = {
    ...STOCK_NETWORK,
    vlan_old: sec("interface", { device: "br-lan.99", proto: "none" }),
    vlan_keep: sec("interface", { device: "br-lan.4", proto: "none" }),
  };
  const desired: Sections = { vlan_keep: current["vlan_keep"]! };
  const p = planConfig("network", current, desired, {
    prune: true,
    managed: (name) => name.startsWith("vlan_"),
  });
  eq("retired managed section is deleted", p.deleteSections, ["vlan_old"]);
  check("stock sections still untouched", !p.deleteSections.includes("loopback"));
}

// --- preserve overrides managed ---
{
  const current: Sections = { ...STOCK_NETWORK, vlan_config: sec("interface", { device: "br-lan.1" }) };
  const p = planConfig("network", current, {}, {
    prune: true,
    managed: () => true,
    // C2: the config-VLAN interface is the guaranteed way back in.
    preserve: ["vlan_config", "lan"],
  });
  check("preserved sections are not deleted", !p.deleteSections.includes("vlan_config"));
  check("preserved lan is not deleted", !p.deleteSections.includes("lan"));
  check("non-preserved sections still prune", p.deleteSections.includes("wan"));
}

// --- value comparison semantics ---
{
  const current: Sections = { s: sec("t", { one: "a", list: ["x", "y"] }) };

  const same = planConfig("c", current, { s: sec("t", { one: "a", list: ["x", "y"] }) });
  check("identical values produce a noop", isNoop(same));

  const reordered = planConfig("c", current, { s: sec("t", { one: "a", list: ["y", "x"] }) });
  eq("list order is significant", reordered.update, [{ section: "s", options: ["list"] }]);

  // UCI stores a one-element list and a scalar identically, so treating them
  // as different would report a change on every single run.
  const scalarVsList = planConfig(
    "c",
    { s: sec("t", { one: "a" }) },
    { s: sec("t", { one: ["a"] }) }
  );
  check("scalar and single-element list compare equal", isNoop(scalarVsList));
}

// --- option pruning is opt-in ---
{
  const current: Sections = { s: sec("t", { keep: "1", stale: "2" }) };
  const desired: Sections = { s: sec("t", { keep: "1" }) };

  const off = planConfig("c", current, desired);
  eq("device-written options survive by default", off.deleteOptions, []);
  check("and the plan is a noop", isNoop(off));

  const on = planConfig("c", current, desired, { pruneOptions: true });
  eq("pruneOptions removes stale options", on.deleteOptions, [
    { section: "s", options: ["stale"] },
  ]);
}

// --- section type change ---
{
  const p = planConfig(
    "c",
    { s: sec("interface", { a: "1" }) },
    { s: sec("device", { a: "1" }) }
  );
  check("type change is detected", p.update.length === 1, JSON.stringify(p.update));
}

// --- summary line ---
{
  const p = planConfig("network", STOCK_NETWORK, {
    vlan_new: sec("interface", { device: "br-lan.5" }),
    wan: sec("interface", { device: "eth0", proto: "pppoe" }),
  });
  const s = summarize(p);
  check("summary mentions the config and counts", s.startsWith("network: +1 ~1 -0"), s);
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
