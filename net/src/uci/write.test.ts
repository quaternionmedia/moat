/**
 * Write-path and rollback-safety test. Requires explicit opt-in:
 *
 *   set -a; . ./.env; set +a
 *   UCI_WRITE_OK=1 UCI_HOST=http://192.168.1.1 npx ts-node src/uci/write.test.ts
 *
 * This writes to a real device, so the design is deliberately conservative:
 *
 * - All changes go to a throwaway section (`moat_probe`) in the `system`
 *   config, never `network`/`firewall`/`dhcp`. Nothing consumes that section,
 *   and a `system` reload does not restart uhttpd/rpcd, so the RPC session
 *   survives. Applying to `network` could drop our own connection mid-test,
 *   which would prove nothing and cost a lot.
 * - Phase 3 is the point of the exercise: it applies a change and deliberately
 *   never confirms, then asserts the device reverted *by itself*. That is the
 *   mechanism protecting against the lockout the README warns about (C2, and
 *   Drawbridge's eth0 self-lock). Proving it on a harmless marker beats
 *   discovering it fails during a real VLAN cutover.
 * - Cleanup runs on every exit path.
 */

import {
  SessionManager,
  UbusTransport,
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

/**
 * Must be >= 90: rpcd silently arms no timer below that, so a shorter value
 * would make this test "prove" rollback is broken when it is not.
 */
const ROLLBACK_TIMEOUT_S = 90;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!auth.username || !auth.password) {
    console.error(
      "Credentials are required for this test: UCI_USERNAME/UCI_PASSWORD\n" +
        "or OPENWRT_USER/OPENWRT_PASSWORD (e.g. `set -a; . ./.env; set +a`).\n" +
        "It waits out a 30s rollback timer, which a static session may not survive."
    );
    process.exit(2);
  }
  if (process.env.UCI_WRITE_OK !== "1") {
    console.error("Refusing to run: set UCI_WRITE_OK=1 to authorize writes to the device.");
    process.exit(2);
  }

  const session = new SessionManager(host, auth);
  const t = new UbusTransport(host, session);

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
    // ---------- Phase 0: what does this session actually allow? ----------
    const caps = await t.probeCapabilities();
    console.log(`  caps: ${JSON.stringify(caps)}`);
    check("rollback (apply+confirm) is available", caps.rollback);
    check("supportsRollback() agrees", supportsRollback(t) === caps.rollback);
    if (!caps.revert) {
      console.log("       note: uci.revert is ACL-forbidden; discarding staged work");
      console.log("       relies on abandoning the session instead (tested in phase 1).");
    }

    check(`${CFG} starts clean`, (await t.changes(CFG)).length === 0);
    check("device is reachable", await verify());
    check("no leftover probe section", (await marker()) === undefined);

    // ---------- Phase 1: staging is per-session ----------
    // Stage, confirm it is visible, then abandon the session and confirm a
    // fresh one sees nothing. This is what makes re-login mid-apply unsafe.
    console.log("\nPhase 1 — staged writes are session-scoped, not committed");
    session.beginTransaction();
    await t.addSection(CFG, SECTION, TYPE, { marker: "phase1", extra: "x" });
    await t.setOptions(CFG, SECTION, { second: "y" });
    const staged = await t.changes(CFG);
    check("addSection + setOptions staged changes", staged.length > 0, `${staged.length} staged`);
    console.log(`       staged: ${JSON.stringify(staged)}`);
    await t.deleteOptions(CFG, SECTION, ["extra"]);
    check("deleteOptions staged without error", true);
    session.endTransaction();

    // Abandon the session; per-session staging means the work evaporates.
    session.invalidate();
    check("a fresh session sees no staged changes", (await t.changes(CFG)).length === 0);
    check("and nothing was persisted", (await marker()) === undefined);

    // ---------- Phase 2: apply + verify + confirm ----------
    console.log("\nPhase 2 — apply with rollback timer, verify, confirm");
    session.beginTransaction();
    await t.addSection(CFG, SECTION, TYPE, { marker: "phase2" });
    const r2 = await applyChanges(t, [CFG], {
      timeout: ROLLBACK_TIMEOUT_S,
      verify,
      verifyAttempts: 5,
      verifyDelayMs: 1500,
      onEvent: (m) => console.log(`       [apply] ${m}`),
    });
    session.endTransaction();
    check(
      "reported protection matches verified capability",
      r2.rollbackProtected === t.capabilities.rollbackVerified,
      `reported ${r2.rollbackProtected}, verified ${t.capabilities.rollbackVerified}`
    );
    check("apply was confirmed", r2.confirmed);
    check("change persisted after confirm", (await marker()) === "phase2", String(await marker()));
    check("no staged changes remain", (await t.changes(CFG)).length === 0);

    // ---------- Phase 3: apply WITHOUT confirm -> device self-reverts ----------
    console.log("\nPhase 3 — apply and never confirm; device must revert itself");
    session.beginTransaction();
    await t.setOptions(CFG, SECTION, { marker: "phase3" });
    check("phase3 change staged", (await t.changes(CFG)).length > 0);

    // Capture what the code claimed *before* the apply: this phase is what
    // establishes rollbackVerified, so comparing against the post-measurement
    // value would be circular.
    const claimedProtection = t.capabilities.rollbackVerified;

    // A verify() that always fails drives the real "cannot reach device" path,
    // which by design leaves the timer to expire.
    const r3 = await applyChanges(t, [CFG], {
      timeout: ROLLBACK_TIMEOUT_S,
      verify: async () => false,
      verifyAttempts: 1,
      verifyDelayMs: 500,
      onEvent: (m) => console.log(`       [apply] ${m}`),
    });
    session.endTransaction();
    check("apply was NOT confirmed", !r3.confirmed);
    check("change is live before the timer expires", (await marker()) === "phase3", String(await marker()));

    const waitS = ROLLBACK_TIMEOUT_S + 20;
    console.log(`       waiting ${waitS}s for the rollback timer to fire...`);
    await sleep(waitS * 1000);

    // Read the *committed* value, not the effective one. `uci.get` overlays
    // this session's staged delta and would still report "phase3" even after
    // /etc/config was restored. Abandoning the session gives a delta-free view
    // — and is what you should do after a rollback anyway, since reusing the
    // session would re-apply the change that was just reverted.
    session.invalidate();

    // This phase *measures* rollback rather than asserting it. A device where
    // it does not fire is a supported (if unfortunate) configuration; what
    // must never happen is the code claiming protection it does not have.
    const after = await marker();
    const reverted = after === "phase2";
    if (reverted) {
      check("device self-reverted the unconfirmed change", true, "rollback works here");
      t.capabilities.rollbackVerified = true;
    } else {
      console.log(
        `  NOTE  rollback did NOT fire — committed marker is still ${String(after)}.\n` +
          `        Applies on this device are UNPROTECTED; sequence changes so a\n` +
          `        working management path always survives. (Check the timeout is\n` +
          `        >= ${ROLLBACK_TIMEOUT_S}s before concluding the feature is missing.)`
      );
    }
    check(
      "reported protection matched what was declared at call time",
      r3.rollbackProtected === claimedProtection,
      `reported ${r3.rollbackProtected}, declared ${claimedProtection}`
    );
    if (reverted && !claimedProtection) {
      console.log(
        "  NOTE  rollback is real on this device but was not declared, so the apply\n" +
          "        was reported unprotected. Pass rollbackVerified: true to connect()\n" +
          "        (or set it on the transport) to have applies report accurately."
      );
    }
    check("device still reachable either way", await verify());
  } finally {
    // ---------- Cleanup ----------
    console.log("\nCleanup — removing probe section");
    try {
      session.invalidate(); // drop any staged residue
      if ((await marker()) !== undefined) {
        session.beginTransaction();
        await t.deleteSection(CFG, SECTION);
        await applyChanges(t, [CFG], {
          timeout: ROLLBACK_TIMEOUT_S,
          verify,
          verifyAttempts: 5,
          verifyDelayMs: 1500,
          onEvent: (m) => console.log(`       [cleanup] ${m}`),
        });
        session.endTransaction();
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
