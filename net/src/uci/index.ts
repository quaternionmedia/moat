/**
 * Transport selection.
 *
 * Both backends are supported so the project works against older RPC-only
 * images as well as ones with ubus-over-HTTP. Preference is not cosmetic:
 * ubus is chosen whenever available because only it can arm a rollback timer
 * around an apply (see ./apply.ts).
 *
 * Detection is two-step, because ubus reachability and ubus *authorization*
 * are different questions. On the target device, an anonymous `list` succeeds
 * while an anonymous `uci.get` returns `Access denied` — so probing the
 * endpoint alone would wrongly select a backend we cannot actually write
 * through. We therefore require a real `uci.get` to succeed with our session.
 */

import { SessionManager, UciAuth } from "./session";
import { LuciRpcTransport } from "./luci-rpc";
import { UbusTransport } from "./ubus";
import { UciTransport } from "./types";

export * from "./types";
export * from "./apply";
export * from "./reconcile";
export { SessionManager, UciAuth, authFromEnv, hasUsableAuth } from "./session";
export { UbusTransport } from "./ubus";
export { LuciRpcTransport } from "./luci-rpc";

/** Which backend to use. "auto" prefers ubus, falls back to LuCI RPC. */
export type TransportPreference = "auto" | "ubus" | "luci-rpc";

export interface ConnectOptions {
  /** Device base URL, no trailing slash, e.g. "http://192.168.1.1". */
  baseUrl: string;
  auth: UciAuth;
  preference?: TransportPreference;
  fetchImpl?: typeof fetch;
  onEvent?: (message: string) => void;
}

/**
 * Build a transport for a device, probing capabilities when preference is
 * "auto". The returned transport's `capabilities.rollback` tells callers
 * whether applies are protected.
 */
export async function connect(opts: ConnectOptions): Promise<UciTransport> {
  const log = opts.onEvent ?? (() => {});
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const preference = opts.preference ?? "auto";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const session = new SessionManager(baseUrl, opts.auth, fetchImpl);

  const ubus = new UbusTransport(baseUrl, session, fetchImpl);
  const luci = new LuciRpcTransport(baseUrl, session, fetchImpl);

  if (preference === "ubus") return ubus;
  if (preference === "luci-rpc") {
    log("transport pinned to luci-rpc — applies will be unprotected");
    return luci;
  }

  // Require an authorized uci read, not merely a reachable endpoint.
  try {
    await ubus.getAll("network");
    log("selected ubus transport (rollback-protected applies available)");
    return ubus;
  } catch (err) {
    log(`ubus unavailable (${String(err)}); falling back to luci-rpc`);
  }

  await luci.getAll("network");
  log("selected luci-rpc transport — NO rollback protection on apply");
  return luci;
}
