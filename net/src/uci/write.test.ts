/**
 * Write-path and rollback-safety test. Requires explicit opt-in:
 *
 *   UCI_WRITE_OK=1 UCI_HOST=http://192.168.1.1 UCI_SESSION=$(cat .token) \
 *     npx ts-node src/uci/write.test.ts
 *
 * This writes to a real device, so the design is deliberately conservative:
 *
 * - All changes go to a throwaway section (`moat_probe`) in the `system`
 *   config, never `network`/`firewall`/`dhcp`. Nothing consumes that section,
 *   and a `system` reload does not restart uhttpd/rpcd — so the RPC session
 *   survives the test. Applying to `network` could drop our own connection
 *   mid-test, which would prove nothing and cost a lot.
 * - Phase 3 is the point of the whole exercise: it applies a change and
 *   deliberately never confirms, then asserts the device *reverted by itself*.
 *   That is the mechanism protecting against the lockout the README warns
 *   about (C2, and Drawbridge's eth0 self-lock). Better to prove it works on a
 *   harmless marker option now than to discover it doesn't during a real
 *   VLAN cutover.
 * - Cleanup runs on every exit path.
 */

import {
  UbusTransport,
  SessionManager,
  applyChanges,
  authFromEnv,
  supportsRollback,
} from "./index";

const host = process.env.UCI_HOST ?? "http://192.168.1.1";
const auth = authFromEnv();

/** Throwaway config/section. Nothing reads these. */
const CFG = "system";
const SECTION = "moat_probe";
const TYPE = "moat_probe";

/** Short so the test is quick; real applies would use a longer window. */
const ROLLBACK_TIMEOUT_S = 30;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // This test spans a 30s rollback window plus verification, so it will
  // outlive a stale session. Credentials are required, not just a token.
  if (!auth.username || !auth.password) {
    console.error(
      "UCI_USERNAME and UCI_PASSWORD are required for this test.\n" +
        "It waits out a 30s rollback timer, which exceeds what a static\n" +
        "UCI_SESSION reliably survives (rpcd default timeout is 300s and the\n" +
        "session may already be part-used)."
    );
    process.exit(2);
  }
  if (process.env.UCI_WRITE_OK !== "1") {
    console.error("Refusing to run: set UCI_WRITE_OK=1 to authorize writes to the device.");
    process.exit(2);
  }

  const t = new UbusTransport(host, new SessionManager(host, auth));
  if (!supportsRollback(t)) {
    console.error("ubus transport did not report rollback capability");
    process.exit(1);
  }

  // A real round trip proving the device answers us.
  const verify = async () => {
    const s = await t.getAll("network");
    return typeof s["lan"]?.values["ipaddr"] === "string";
  };
  const marker = async (): Promise<string | undefined> => {
    const s = await t.getAll(CFG);
    const v = s[SECTION]?.values["marker"];
    return typeof v === "string" ? v : undefined;
  };

  console.log(`\nUCI write + rollback test against ${host}\n`);

  try {
    // Preconditions: never start from a dirty device.
    const preChanges = await t.changes(CFG);
    check(`${CFG} starts clean`, preChanges.length === 0, `${preChanges.length} staged`);
    check("device is reachable", await verify());

    // ---------- Phase 1: write path, staged only, then revert ----------
    console.log("\nPhase 1 — staged writes, then revert (no commit)");
    await t.putSection(CFG, SECTION, TYPE, { marker: "phase1", extra: "x" });
    await t.setOptions(CFG, SECTION, { second: "y" });
    const staged = await t.changes(CFG);
    check("putSection + setOptions staged changes", staged.length > 0, `${staged.length} staged`);
    console.log(`       staged: ${JSON.stringify(staged)}`);

    await t.deleteOptions(CFG, SECTION, ["extra"]);
    check("deleteOptions staged without error", true);

    await t.revert(CFG);
    check("revert cleared staging", (await t.changes(CFG)).length === 0);
    check("nothing persisted from phase 1", (await marker()) === undefined);

    // ---------- Phase 2: apply + verify + confirm (happy path) ----------
    console.log("\nPhase 2 — apply with rollback timer, verify, confirm");
    await t.putSection(CFG, SECTION, TYPE, { marker: "phase2" });
    const r2 = await applyChanges(t, [CFG], {
      timeout: ROLLBACK_TIMEOUT_S,
      verify,
      verifyAttempts: 5,
      verifyDelayMs: 1500,
      onEvent: (m) => console.log(`       [apply] ${m}`),
    });
    check("apply reported rollback protection", r2.rollbackProtected);
    check("apply was confirmed", r2.confirmed);
    check("change persisted after confirm", (await marker()) === "phase2", String(await marker()));
    check("no staged changes remain", (await t.changes(CFG)).length === 0);

    // ---------- Phase 3: apply WITHOUT confirm -> device self-reverts ----------
    console.log("\nPhase 3 — apply and never confirm; device must revert itself");
    await t.setOptions(CFG, SECTION, { marker: "phase3" });
    check("phase3 change staged", (await t.changes(CFG)).length > 0);

    // A verify() that always fails drives the real "cannot reach device" path
    // in applyChanges, which by design leaves the timer to expire.
    const r3 = await applyChanges(t, [CFG], {
      timeout: ROLLBACK_TIMEOUT_S,
      verify: async () => false,
      verifyAttempts: 1,
      verifyDelayMs: 500,
      onEvent: (m) => console.log(`       [apply] ${m}`),
    });
    check("apply armed the timer", r3.rollbackProtected);
    check("apply was NOT confirmed", !r3.confirmed);
    check("change is live before the timer expires", (await marker()) === "phase3", String(await marker()));

    const waitS = ROLLBACK_TIMEOUT_S + 15;
    console.log(`       waiting ${waitS}s for the rollback timer to fire...`);
    await sleep(waitS * 1000);

    const after = await marker();
    check(
      "device self-reverted the unconfirmed change",
      after === "phase2",
      `marker is now ${String(after)} (expected phase2, the last confirmed value)`
    );
    check("device still reachable after rollback", await verify());
  } finally {
    // ---------- Cleanup: remove the probe section for real ----------
    console.log("\nCleanup — removing probe section");
    try {
      await t.revert(CFG);
      await t.deleteSection(CFG, SECTION);
      if ((await t.changes(CFG)).length > 0) {
        await applyChanges(t, [CFG], {
          timeout: ROLLBACK_TIMEOUT_S,
          verify,
          verifyAttempts: 5,
          verifyDelayMs: 1500,
          onEvent: (m) => console.log(`       [cleanup] ${m}`),
        });
      }
      const gone = (await marker()) === undefined;
      const clean = (await t.changes(CFG)).length === 0;
      console.log(`  ${gone ? "ok  " : "FAIL"} probe section removed`);
      console.log(`  ${clean ? "ok  " : "FAIL"} ${CFG} left clean`);
      if (!gone || !clean) failures++;
    } catch (err) {
      console.error("  FAIL cleanup threw:", err);
      failures++;
    }
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nwrite test threw:", err);
  process.exit(1);
});
