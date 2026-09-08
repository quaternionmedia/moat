/**
 * UCI transport types — the vendor-neutral seam between "what config do we
 * want" and "how do we talk to this particular router".
 *
 * Two transports exist because they are not interchangeable:
 *
 * - ubus (`/ubus`) supports `uci.apply{rollback,timeout}` + `uci.confirm`,
 *   which auto-reverts the device if we lock ourselves out. On a box whose
 *   own docs warn that a wrong VLAN on the config port self-locks it
 *   (see README "Critical OpenWrt facts" C2), that is the difference between
 *   a 90-second wait and a serial cable.
 * - LuCI RPC (`/cgi-bin/luci/rpc/uci`) has no apply/confirm at all. It is the
 *   only option on older images, so it stays supported — but a commit through
 *   it is unprotected and callers must know that.
 *
 * Capability is therefore explicit in the type system rather than discovered
 * at runtime: `supportsRollback()` narrows a transport to the safe path.
 */

/** A UCI option value. UCI natively supports both scalars and lists. */
export type UciValue = string | string[];

/** The options of a single UCI section, with `.`-prefixed meta keys stripped. */
export type SectionValues = Record<string, UciValue>;

/**
 * One UCI section as we model it. `type` is UCI's section type
 * (`interface`, `zone`, `rule`, ...), kept separate from the options because
 * both transports take it as its own argument.
 */
export interface Section {
  type: string;
  values: SectionValues;
  /** UCI anonymous sections (`cfg030f15`) have no stable name. */
  anonymous?: boolean;
}

/** A whole UCI config file, keyed by section name. */
export type Sections = Record<string, Section>;

/**
 * A staged-but-uncommitted UCI change, as reported by `changes`.
 * Shape differs slightly per transport, so this stays deliberately loose —
 * it is used for logging and for asserting "nothing is staged", not parsed.
 */
export type UciChange = unknown;

export interface UciCapabilities {
  /**
   * `uci.apply` and `uci.confirm` are *callable*. This says nothing about
   * whether the rollback actually happens — see `rollbackVerified`.
   */
  rollback: boolean;
  /**
   * A rollback was empirically observed to restore `/etc/config` after an
   * unconfirmed apply.
   *
   * Measured rather than inferred, because the ACL permitting apply+confirm
   * does not guarantee a timer gets armed. Two traps, both hit during
   * development on OpenWrt 24.10.1/ramips:
   *
   * 1. **A timeout under 90s is silently ignored.** `apply{rollback:true,
   *    timeout:15}` returns status 0 and arms nothing. LuCI clamps with
   *    `max(timeout, 90)` for this reason — see MIN_ROLLBACK_TIMEOUT_S.
   * 2. **`uci.get` cannot be used to observe a rollback.** It overlays the
   *    session's staged delta, so it keeps reporting the new value even after
   *    the committed file has been restored. Verifying a revert means reading
   *    the committed config, not the effective value.
   *
   * With a 90s timer, the revert was observed at t+92s.
   */
  rollbackVerified: boolean;
  /**
   * `revert` is callable. Not guaranteed: LuCI's standard rpcd ACL grants
   * uci [changes, get, add, apply, confirm, delete, order, rename, set] and
   * omits both `revert` and `commit` — the intended flow is apply+confirm.
   * Verified on the target device.
   */
  revert: boolean;
  /** `commit` is callable. Often absent for the same reason as `revert`. */
  commit: boolean;
}

/** UCI meta keys that `get_all` returns but that are not real options. */
const META_KEYS = new Set([".name", ".type", ".anonymous", ".index"]);

/**
 * Split a raw `get_all` section into our `Section` shape, dropping the
 * `.`-prefixed meta keys UCI mixes in with real options.
 */
export function parseSection(raw: Record<string, unknown>): Section {
  const values: SectionValues = {};
  for (const [k, v] of Object.entries(raw)) {
    if (META_KEYS.has(k)) continue;
    if (typeof v === "string") values[k] = v;
    else if (Array.isArray(v)) values[k] = v.map(String);
    // Anything else (number/bool) is coerced — UCI is string-typed on disk.
    else if (v !== null && v !== undefined) values[k] = String(v);
  }
  const section: Section = {
    type: typeof raw[".type"] === "string" ? (raw[".type"] as string) : "",
    values,
  };
  if (raw[".anonymous"] === true) section.anonymous = true;
  return section;
}

/** Normalize a raw `get_all` payload into `Sections`. */
export function parseSections(raw: unknown): Sections {
  // A missing config file reads back as `null` (LuCI RPC) or `[]` (ubus).
  if (raw === null || raw === undefined || Array.isArray(raw)) return {};
  if (typeof raw !== "object") return {};
  const out: Sections = {};
  for (const [name, sec] of Object.entries(raw as Record<string, unknown>)) {
    if (sec && typeof sec === "object" && !Array.isArray(sec)) {
      out[name] = parseSection(sec as Record<string, unknown>);
    }
  }
  return out;
}

/** Raised for any transport-level failure, with enough context to debug. */
export class UciError extends Error {
  constructor(
    message: string,
    readonly transport: string,
    readonly method?: string,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = "UciError";
  }
}

/** Raised specifically when the session is rejected, so callers can re-auth. */
export class UciAuthError extends UciError {
  constructor(message: string, transport: string, method?: string, detail?: unknown) {
    super(message, transport, method, detail);
    this.name = "UciAuthError";
  }
}

/**
 * The operations both transports provide. Deliberately section-oriented
 * rather than option-oriented: ubus can create a named section and set all
 * its options in a single round trip, and doing the same on LuCI RPC keeps
 * the 247-resource config from becoming thousands of HTTP calls.
 */
export interface UciTransport {
  readonly name: string;
  readonly capabilities: UciCapabilities;

  /** Read a whole config file. A nonexistent config yields `{}`. */
  getAll(config: string): Promise<Sections>;

  /**
   * Create a new named section with its options.
   *
   * Must be distinct from `setOptions`: ubus `uci.set` only mutates an
   * existing section and returns NOT_FOUND for a new one, so creation has to
   * go through `uci.add`. Callers know which case they are in from the plan,
   * so no existence probe is needed.
   */
  addSection(config: string, section: string, type: string, values: SectionValues): Promise<void>;

  /** Set options on an existing section without touching its other options. */
  setOptions(config: string, section: string, values: SectionValues): Promise<void>;

  deleteSection(config: string, section: string): Promise<void>;
  deleteOptions(config: string, section: string, options: string[]): Promise<void>;

  /** Staged, uncommitted changes. Empty means the config is clean. */
  changes(config: string): Promise<UciChange[]>;

  /** Persist staged changes for one config file. No rollback protection. */
  commit(config: string): Promise<void>;

  /** Discard staged changes for one config file. */
  revert(config: string): Promise<void>;

  /**
   * Pin the session across a stage-then-apply cycle.
   *
   * Staging is per-session, so renewing the session midway would discard every
   * staged change and then apply nothing. Between these calls the transport
   * refuses to re-authenticate and fails loudly instead.
   */
  beginTransaction(): void;
  endTransaction(): void;
}

/**
 * The safe-apply extension, present only on ubus.
 *
 * Usage is a three-step dance: `apply({timeout})` arms the timer and reloads
 * services, the caller then proves it can still reach the device, and only
 * then `confirm()` makes it permanent. Skipping `confirm()` is what saves you.
 */
export interface RollbackCapable {
  /** Commit + reload with a rollback timer armed (seconds). */
  apply(opts: { timeout: number }): Promise<void>;
  /** Cancel the rollback timer — the applied config becomes permanent. */
  confirm(): Promise<void>;
  /** Trigger the revert immediately instead of waiting for the timeout. */
  rollback(): Promise<void>;
}

/** Narrow a transport to the rollback-protected apply path. */
export function supportsRollback(
  t: UciTransport
): t is UciTransport & RollbackCapable {
  return t.capabilities.rollback;
}
