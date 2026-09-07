/**
 * Applying staged UCI changes, with lockout protection where available.
 *
 * This is the whole reason the transport layer distinguishes capabilities.
 * The repo's own critical facts (README: C2 "MoatNet's eth4 must stay
 * untagged VLAN 1, or the box locks itself out", and the Drawbridge eth0
 * self-lock note) describe a failure mode where a *successful* config write
 * makes the device unreachable. A plain commit cannot recover from that.
 *
 * On ubus we therefore never plain-commit. We:
 *   1. `uci.apply{rollback:true, timeout:N}` — commits, reloads services, and
 *      arms a timer that restores the previous config after N seconds.
 *   2. Prove we can still talk to the device.
 *   3. Only then `uci.confirm()` to cancel the timer.
 *
 * If step 2 fails we deliberately do nothing: staying silent is what lets the
 * device rescue itself. Never call `confirm()` on a hope.
 *
 * On LuCI RPC no such mechanism exists, so `commit()` is the only option and
 * the caller is told the apply was unprotected.
 */

import { UciError, UciTransport, supportsRollback } from "./types";

export interface ApplyOptions {
  /**
   * Rollback window in seconds (ubus only). Long enough for services to
   * reload and for verification to run, short enough that a lockout is a
   * brief outage rather than an afternoon.
   */
  timeout?: number;
  /**
   * Proves the device is still reachable after the apply. Should perform a
   * real round trip (a UCI read is ideal). Returning false — or throwing —
   * means "do not confirm".
   */
  verify?: () => Promise<boolean>;
  /** Verification attempts while services are still reloading. */
  verifyAttempts?: number;
  /** Delay between verification attempts, in milliseconds. */
  verifyDelayMs?: number;
  /** Progress hook, for surfacing the dance in Pulumi logs. */
  onEvent?: (message: string) => void;
}

export interface ApplyResult {
  /** True when a rollback timer was armed, i.e. a lockout is self-healing. */
  rollbackProtected: boolean;
  /** True when the config was confirmed permanent. */
  confirmed: boolean;
  /** Configs that were plain-committed (unprotected path only). */
  committed: string[];
}

const DEFAULT_TIMEOUT_S = 90;
const DEFAULT_ATTEMPTS = 8;
const DEFAULT_DELAY_MS = 3000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Apply staged changes for `configs`.
 *
 * `configs` is only used on the unprotected path — ubus's `uci.apply` takes no
 * config argument and applies everything staged at once, which is the
 * atomicity we want when a VLAN topology spans network + firewall + dhcp.
 */
export async function applyChanges(
  transport: UciTransport,
  configs: string[],
  opts: ApplyOptions = {}
): Promise<ApplyResult> {
  const log = opts.onEvent ?? (() => {});

  if (!supportsRollback(transport)) {
    // Unprotected path. Commit per config file; there is no way to make this
    // atomic across files on this transport.
    log(
      `transport "${transport.name}" has no uci.apply/confirm — committing without ` +
        `rollback protection. A change that cuts off access will NOT self-revert.`
    );
    const committed: string[] = [];
    for (const config of configs) {
      await transport.commit(config);
      committed.push(config);
      log(`committed ${config}`);
    }
    return { rollbackProtected: false, confirmed: true, committed };
  }

  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_S;
  log(`applying with a ${timeout}s rollback timer armed`);
  await transport.apply({ timeout });

  // No verifier supplied means we cannot honestly claim the device is still
  // reachable. Confirm anyway would defeat the point, so refuse instead.
  if (!opts.verify) {
    throw new UciError(
      "applyChanges was given no verify() callback, so reachability cannot be proven. " +
        `The rollback timer is armed and the device will revert in ~${timeout}s ` +
        "unless confirm() is called. Supply verify() to complete the apply.",
      transport.name,
      "apply"
    );
  }

  const attempts = opts.verifyAttempts ?? DEFAULT_ATTEMPTS;
  const delay = opts.verifyDelayMs ?? DEFAULT_DELAY_MS;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Services are reloading immediately after apply; a first failure is
    // expected rather than alarming.
    await sleep(delay);
    let ok = false;
    try {
      ok = await opts.verify();
    } catch (err) {
      log(`verify attempt ${attempt}/${attempts} threw: ${String(err)}`);
    }
    if (ok) {
      await transport.confirm();
      log(`device still reachable — confirmed after ${attempt} attempt(s)`);
      return { rollbackProtected: true, confirmed: true, committed: [] };
    }
    log(`verify attempt ${attempt}/${attempts} failed`);
  }

  // Intentionally do NOT confirm. The armed timer is the recovery mechanism.
  log(
    `could not reach the device after ${attempts} attempts — leaving the rollback ` +
      `timer to expire. It should restore the previous config within ${timeout}s.`
  );
  return { rollbackProtected: true, confirmed: false, committed: [] };
}
