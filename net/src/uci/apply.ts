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
 *   1. `uci.apply{rollback:true, timeout:N}` — asks rpcd to commit, reload
 *      services, and arm a timer restoring the previous config after N seconds.
 *   2. Prove we can still talk to the device.
 *   3. Only then `uci.confirm()` to cancel the timer.
 *
 * If step 2 fails we deliberately do nothing: silence is what should let the
 * device rescue itself. Never call `confirm()` on a hope.
 *
 * ## The 90-second floor
 *
 * rpcd **silently ignores a rollback timeout below 90 seconds**: the call
 * returns status 0 and no timer is armed. Verified on OpenWrt 24.10.1/ramips —
 * a 15s request never reverted, while a 90s request reverted at t+92s. LuCI's
 * own controller clamps with `max(timeout, 90)` for the same reason, so this
 * module enforces MIN_ROLLBACK_TIMEOUT_S rather than passing a smaller value
 * through and quietly losing the safety net.
 *
 * Protection is still reported from measurement (`rollbackVerified`), not from
 * `capabilities.rollback`, which only means "the methods are callable".
 *
 * ## Observing a rollback
 *
 * Do not use `uci.get` to check whether a revert happened: it overlays the
 * session's staged delta and will keep returning the new value even after the
 * committed file has been restored. Note also that a rollback restores
 * `/etc/config` but leaves the session's delta in place, so a session that has
 * been rolled back should be abandoned rather than reused — otherwise the next
 * apply re-applies the very change that was just reverted.
 *
 * On LuCI RPC no apply/confirm exists at all, so `commit()` is the only option
 * and the caller is told the apply was unprotected.
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
/**
 * rpcd arms no timer at all below this, while still returning success, so a
 * smaller value is silently no protection. Matches LuCI's `max(timeout, 90)`.
 */
export const MIN_ROLLBACK_TIMEOUT_S = 90;
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
    if (!transport.capabilities.commit) {
      throw new UciError(
        `transport "${transport.name}" can neither apply-with-rollback nor commit, so ` +
          `staged changes cannot be persisted. Grant uci apply+confirm (preferred) or ` +
          `commit via an rpcd ACL file in /usr/share/rpcd/acl.d/.`,
        transport.name,
        "apply"
      );
    }
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

  const requested = opts.timeout ?? DEFAULT_TIMEOUT_S;
  // Clamp rather than honour a smaller value: passing it through would arm
  // nothing while looking like it worked.
  const timeout = Math.max(requested, MIN_ROLLBACK_TIMEOUT_S);
  if (timeout !== requested) {
    log(
      `rollback timeout raised from ${requested}s to ${timeout}s — rpcd silently ` +
        `arms no timer below ${MIN_ROLLBACK_TIMEOUT_S}s`
    );
  }
  if (!transport.capabilities.rollbackVerified) {
    // Do not let a caller believe there is a net when there may not be. On the
    // target device apply+confirm are permitted and return success while no
    // rollback occurs (measured), so this warning is the accurate default.
    log(
      `WARNING: uci.apply/confirm are available but rollback has NOT been verified ` +
        `on this device. Treat this apply as UNPROTECTED: if it cuts off access, ` +
        `nothing will restore the previous config automatically.`
    );
  }
  log(`applying (requested rollback timer: ${timeout}s)`);
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
      // Report what is true, not what was requested.
      return {
        rollbackProtected: transport.capabilities.rollbackVerified,
        confirmed: true,
        committed: [],
      };
    }
    log(`verify attempt ${attempt}/${attempts} failed`);
  }

  // Intentionally do NOT confirm: if a timer really is armed, silence is what
  // triggers recovery.
  log(
    transport.capabilities.rollbackVerified
      ? `could not reach the device after ${attempts} attempts — leaving the rollback ` +
          `timer to expire. It should restore the previous config within ${timeout}s.`
      : `could not reach the device after ${attempts} attempts and did not confirm. ` +
          `Rollback is UNVERIFIED on this device, so do not assume recovery: the ` +
          `change may well still be live. Manual intervention is likely needed.`
  );
  return {
    rollbackProtected: transport.capabilities.rollbackVerified,
    confirmed: false,
    committed: [],
  };
}
