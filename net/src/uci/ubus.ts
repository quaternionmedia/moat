/**
 * ubus transport — the preferred backend.
 *
 * Endpoint: POST `/ubus`, JSON-RPC 2.0, envelope
 *   {jsonrpc:"2.0", id, method:"call", params:[session, "uci", <method>, <args>]}
 * Reply is `{result:[status, payload]}` where a nonzero ubus status is the
 * real error (JSON-RPC `error` only covers transport/session problems).
 *
 * Method signatures below were taken from live `ubus list uci` introspection
 * on the target device, not from documentation.
 *
 * The reason to prefer this backend: `uci.apply{rollback,timeout}` +
 * `uci.confirm`. See `applyWithRollback` in ./apply.ts for the dance.
 */

import {
  RollbackCapable,
  Sections,
  SectionValues,
  UciAuthError,
  UciCapabilities,
  UciChange,
  UciError,
  UciTransport,
  parseSections,
} from "./types";
import { SessionManager } from "./session";

/** ubus status codes — worth mapping, the numbers alone are opaque. */
const UBUS_STATUS: Record<number, string> = {
  0: "OK",
  1: "INVALID_COMMAND",
  2: "INVALID_ARGUMENT",
  3: "METHOD_NOT_FOUND",
  4: "NOT_FOUND",
  5: "NO_DATA",
  6: "PERMISSION_DENIED",
  7: "TIMEOUT",
  8: "NOT_SUPPORTED",
  9: "UNKNOWN_ERROR",
  10: "CONNECTION_FAILED",
};

/** JSON-RPC code ubus returns for an invalid/expired session. */
const JSONRPC_ACCESS_DENIED = -32002;

export class UbusTransport implements UciTransport, RollbackCapable {
  readonly name = "ubus";
  readonly capabilities: UciCapabilities = { rollback: true };

  private nextId = 1;

  constructor(
    private readonly baseUrl: string,
    private readonly session: SessionManager,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getAll(config: string): Promise<Sections> {
    // `uci.get` with no `section` returns every section under `values`
    // (verified live: yields the same names as LuCI RPC's `get_all`).
    const payload = await this.call<{ values?: unknown }>("get", { config }, {
      // Status 4/5 mean the config is in our ACL but has no file on disk yet
      // — "no sections", not an error. moatnet's absent `wireless` is exactly
      // this case. Status 6 (not in ACL) is deliberately NOT tolerated, since
      // silently returning {} there would mask a real authorization gap and
      // could look like "the device has no firewall rules".
      tolerate: [4, 5],
    });
    return parseSections(payload?.values);
  }

  async putSection(
    config: string,
    section: string,
    type: string,
    values: SectionValues
  ): Promise<void> {
    // One round trip creates-or-updates the named section *and* sets every
    // option, which is why no separate adopt step is needed.
    await this.call("set", { config, section, type, values });
  }

  async setOptions(config: string, section: string, values: SectionValues): Promise<void> {
    await this.call("set", { config, section, values });
  }

  async deleteSection(config: string, section: string): Promise<void> {
    await this.call("delete", { config, section }, { tolerate: [4, 5] });
  }

  async deleteOptions(config: string, section: string, options: string[]): Promise<void> {
    if (options.length === 0) return;
    await this.call("delete", { config, section, options }, { tolerate: [4, 5] });
  }

  async changes(config: string): Promise<UciChange[]> {
    const payload = await this.call<{ changes?: unknown }>("changes", { config }, {
      tolerate: [4, 5],
    });
    const c = payload?.changes;
    return Array.isArray(c) ? c : [];
  }

  async commit(config: string): Promise<void> {
    await this.call("commit", { config });
  }

  async revert(config: string): Promise<void> {
    await this.call("revert", { config });
  }

  // --- RollbackCapable ---

  /**
   * Commit every staged config and reload services with a rollback timer
   * armed. If `confirm()` is not called within `timeout` seconds, the device
   * restores the previous config by itself.
   *
   * Note `uci.apply` takes no `config` argument — it applies all staged
   * changes at once, which is exactly the atomicity we want.
   */
  async apply(opts: { timeout: number }): Promise<void> {
    await this.call("apply", { rollback: true, timeout: opts.timeout });
  }

  async confirm(): Promise<void> {
    await this.call("confirm", {});
  }

  async rollback(): Promise<void> {
    await this.call("rollback", {});
  }

  /**
   * Which UCI config files this session may read/write, as reported by
   * `session.access`. Useful for turning an opaque PERMISSION_DENIED into an
   * actionable message, since ubus scopes uci access per config file.
   */
  async getUciAcl(): Promise<Record<string, string[]>> {
    const payload = await this.call<{ uci?: Record<string, string[]> }>(
      "access",
      {},
      { object: "session" }
    );
    return payload?.uci ?? {};
  }

  /**
   * Issue one ubus call, transparently re-authenticating once if the session
   * has expired. Defaults to the `uci` object.
   */
  private async call<T = unknown>(
    method: string,
    args: Record<string, unknown>,
    opts: { tolerate?: number[]; object?: string } = {}
  ): Promise<T | undefined> {
    try {
      return await this.callOnce<T>(method, args, opts);
    } catch (err) {
      if (err instanceof UciAuthError && this.session.canRenew) {
        this.session.invalidate();
        return await this.callOnce<T>(method, args, opts);
      }
      throw err;
    }
  }

  private async callOnce<T>(
    method: string,
    args: Record<string, unknown>,
    opts: { tolerate?: number[]; object?: string }
  ): Promise<T | undefined> {
    const session = await this.session.get();
    const object = opts.object ?? "uci";
    const res = await this.fetchImpl(`${this.baseUrl}/ubus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "call",
        params: [session, object, method, args],
      }),
    });

    if (!res.ok) {
      throw new UciError(`ubus HTTP ${res.status}`, this.name, method);
    }

    const body = (await res.json()) as {
      result?: [number, T?];
      error?: { code: number; message: string };
    };

    if (body.error) {
      if (body.error.code === JSONRPC_ACCESS_DENIED) {
        throw new UciAuthError(
          `ubus rejected the session: ${body.error.message}`,
          this.name,
          method,
          body.error
        );
      }
      throw new UciError(
        `ubus error ${body.error.code}: ${body.error.message}`,
        this.name,
        method,
        body.error
      );
    }

    const [status, payload] = body.result ?? [];
    if (status === undefined) {
      throw new UciError("ubus returned no result", this.name, method, body);
    }
    if (status !== 0) {
      if (opts.tolerate?.includes(status)) return undefined;
      if (status === 6) {
        // Deliberately NOT a UciAuthError: re-logging in returns the same ACL,
        // so retrying is futile and would only hide the real problem. ubus
        // scopes uci access per config file, and an unlisted config is denied
        // rather than reported missing (verified: an in-ACL but absent config
        // like `wireless` returns status 4, not 6). Use `getUciAcl()` to see
        // what this session actually grants.
        throw new UciError(
          `uci.${method} denied for config "${String(args["config"] ?? "?")}" — ` +
            `it is not in this session's UCI ACL. Re-authenticating will not help; ` +
            `grant it via an rpcd ACL file in /usr/share/rpcd/acl.d/.`,
          this.name,
          method,
          body.result
        );
      }
      throw new UciError(
        `uci.${method} failed: ${UBUS_STATUS[status] ?? `status ${status}`}`,
        this.name,
        method,
        body.result
      );
    }
    return payload;
  }
}
