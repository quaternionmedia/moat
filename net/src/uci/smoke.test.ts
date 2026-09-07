/**
 * Read-only smoke test for the UCI transport layer, run against a real device.
 *
 *   UCI_HOST=http://192.168.1.1 UCI_SESSION=$(cat .token) \
 *     npx ts-node src/uci/smoke.test.ts
 *
 * Deliberately performs no writes: it proves auto-detection, session reuse,
 * section parsing, and that both backends agree on what the device holds.
 * Write-path behaviour is exercised separately, because staging changes on a
 * live gateway is not something a test should do without being asked.
 */

import {
  LuciRpcTransport,
  SessionManager,
  UbusTransport,
  UciAuthError,
  UciError,
  authFromEnv,
  connect,
  hasUsableAuth,
  supportsRollback,
} from "./index";

const host = process.env.UCI_HOST ?? "http://192.168.1.1";
const auth = authFromEnv();

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  if (!hasUsableAuth(auth)) {
    console.error(
      "Set UCI_SESSION (a LuCI/ubus session id, e.g. from .token) or\n" +
        "UCI_USERNAME + UCI_PASSWORD. Credentials are preferred: sessions\n" +
        "expire and cannot be renewed from a bare token."
    );
    process.exit(2);
  }

  console.log(`\nUCI transport smoke test against ${host}\n`);

  // --- auto-detection ---
  const auto = await connect({
    baseUrl: host,
    auth,
    onEvent: (m) => console.log(`  [detect] ${m}`),
  });
  check("auto-detect picked a transport", Boolean(auto.name), auto.name);
  check(
    "rollback capability is reported",
    typeof auto.capabilities.rollback === "boolean",
    `rollback=${auto.capabilities.rollback}`
  );
  check(
    "supportsRollback() agrees with capabilities",
    supportsRollback(auto) === auto.capabilities.rollback
  );

  // --- both backends directly, sharing one session ---
  const shared = new SessionManager(host, auth);
  const ubus = new UbusTransport(host, shared);
  const luci = new LuciRpcTransport(host, shared);

  const viaUbus = await ubus.getAll("network");
  const viaLuci = await luci.getAll("network");

  const ubusNames = Object.keys(viaUbus).sort();
  const luciNames = Object.keys(viaLuci).sort();
  check("ubus read network sections", ubusNames.length > 0, ubusNames.join(", "));
  check("luci-rpc read network sections", luciNames.length > 0, luciNames.join(", "));
  check(
    "both backends agree on section names",
    JSON.stringify(ubusNames) === JSON.stringify(luciNames),
    `ubus=${ubusNames.length} luci=${luciNames.length}`
  );

  // --- section parsing ---
  const lan = viaUbus["lan"];
  check("lan section was parsed", Boolean(lan), lan ? `type=${lan.type}` : "missing");
  check("lan.type is 'interface'", lan?.type === "interface", lan?.type);
  check("meta keys stripped from values", lan ? !(".name" in lan.values) : false);
  check("lan.ipaddr survived parsing", typeof lan?.values["ipaddr"] === "string", String(lan?.values["ipaddr"]));

  // UCI list options must stay arrays — br-lan's `ports` is the case that
  // matters, since the whole VLAN topology is expressed as port lists.
  const bridge = Object.values(viaUbus).find((s) => s.type === "device" && "ports" in s.values);
  check(
    "list-valued option parsed as array",
    Array.isArray(bridge?.values["ports"]),
    JSON.stringify(bridge?.values["ports"])
  );

  // --- absent file vs. denied config are different failures ---
  // ubus distinguishes them by status: an in-ACL config with no file on disk
  // returns 4 (-> {}), while a config outside the ACL returns 6. moatnet has
  // no /etc/config/wireless, so it is the real-world case for the former.
  const noFile = await ubus.getAll("wireless");
  check("in-ACL config with no file reads as {} on ubus", Object.keys(noFile).length === 0);

  let denied: unknown;
  try {
    await ubus.getAll("moatprobe_not_in_acl");
    denied = "no error";
  } catch (err) {
    denied = err;
  }
  check(
    "out-of-ACL config raises rather than silently returning {}",
    denied instanceof UciError,
    denied instanceof Error ? denied.constructor.name : String(denied)
  );
  check(
    "ACL denial is not an auth error (re-login would be futile)",
    denied instanceof UciError && !(denied instanceof UciAuthError)
  );

  const acl = await ubus.getUciAcl();
  check("session ACL is introspectable", Object.keys(acl).length > 0, Object.keys(acl).sort().join(", "));
  for (const needed of ["network", "firewall", "dhcp", "wireless"]) {
    check(`ACL grants write on ${needed}`, (acl[needed] ?? []).includes("write"));
  }

  // LuCI RPC cannot distinguish these cases — it returns null either way,
  // which parseSections maps to {}. Worth pinning so the asymmetry is known.
  const absentLuci = await luci.getAll("moatprobe_not_in_acl");
  check("luci-rpc cannot distinguish, yields {}", Object.keys(absentLuci).length === 0);

  // --- nothing staged (also guards against earlier probes leaving residue) ---
  for (const cfg of ["network", "firewall", "dhcp"]) {
    const ch = await ubus.changes(cfg);
    check(`${cfg} has no staged changes`, ch.length === 0, `${ch.length} staged`);
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nsmoke test threw:", err);
  process.exit(1);
});
