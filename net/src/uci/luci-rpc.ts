/**
 * LuCI RPC transport — the compatibility backend.
 *
 * Endpoint: POST `/cgi-bin/luci/rpc/uci?auth=<session>`, body
 *   {"method": <name>, "params": [...]}
 * Reply is `{id, result, error}`. Note the failure convention: a rejected
 * operation comes back as `result: null` with `error: null` rather than as an
 * error — e.g. writing to a config file that does not exist in /etc/config.
 * So `null` is treated as failure here.
 *
 * Signatures below were confirmed empirically against the live device (staged
 * to a throwaway section, inspected via `changes`, then reverted).
 *
 * This backend exists for images without ubus-over-HTTP. It has **no**
 * apply/confirm/rollback, so `commit()` here is unprotected: if a bad VLAN
 * change cuts us off mid-apply, nothing restores the device automatically.
 * Callers must surface that difference rather than paper over it.
 */

import {
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

export class LuciRpcTransport implements UciTransport {
  readonly name = "luci-rpc";
  /** No apply/confirm/rollback on this endpoint — commits are unprotected. */
  readonly capabilities: UciCapabilities = { rollback: false };

  constructor(
    private readonly baseUrl: string,
    private readonly session: SessionManager,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getAll(config: string): Promise<Sections> {
    // A nonexistent config returns null, which parseSections maps to {}.
    const result = await this.call("get_all", [config], { nullOk: true });
    return parseSections(result);
  }

  async putSection(
    config: string,
    section: string,
    type: string,
    values: SectionValues
  ): Promise<void> {
    // `section(config, type, name, values)` is a create-or-update upsert and
    // sets all options in the same call.
    await this.call("section", [config, type, section, values]);
  }

  async setOptions(config: string, section: string, values: SectionValues): Promise<void> {
    // `tset` takes an option map, avoiding one HTTP call per option.
    await this.call("tset", [config, section, values]);
  }

  async deleteSection(config: string, section: string): Promise<void> {
    await this.call("delete", [config, section], { nullOk: true });
  }

  async deleteOptions(config: string, section: string, options: string[]): Promise<void> {
    // No bulk option delete here, unlike ubus's `options` array.
    for (const option of options) {
      await this.call("delete", [config, section, option], { nullOk: true });
    }
  }

  async changes(config: string): Promise<UciChange[]> {
    const result = await this.call("changes", [config], { nullOk: true });
    return Array.isArray(result) ? result : [];
  }

  async commit(config: string): Promise<void> {
    await this.call("commit", [config]);
  }

  async revert(config: string): Promise<void> {
    await this.call("revert", [config]);
  }

  private async call(
    method: string,
    params: unknown[],
    opts: { nullOk?: boolean } = {}
  ): Promise<unknown> {
    try {
      return await this.callOnce(method, params, opts);
    } catch (err) {
      if (err instanceof UciAuthError && this.session.canRenew) {
        this.session.invalidate();
        return await this.callOnce(method, params, opts);
      }
      throw err;
    }
  }

  private async callOnce(
    method: string,
    params: unknown[],
    opts: { nullOk?: boolean }
  ): Promise<unknown> {
    const session = await this.session.get();
    const url = `${this.baseUrl}/cgi-bin/luci/rpc/uci?auth=${encodeURIComponent(session)}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
    });

    // An expired or wrong session is a bare 403 with an empty body.
    if (res.status === 403) {
      throw new UciAuthError("LuCI RPC returned 403 — session expired?", this.name, method);
    }
    if (!res.ok) {
      throw new UciError(`LuCI RPC HTTP ${res.status}`, this.name, method);
    }

    const text = await res.text();
    if (text.trim() === "") {
      // Empty body also indicates a rejected session on this endpoint.
      throw new UciAuthError("LuCI RPC returned an empty body — session expired?", this.name, method);
    }

    let body: { result?: unknown; error?: unknown };
    try {
      body = JSON.parse(text) as { result?: unknown; error?: unknown };
    } catch {
      throw new UciError(`LuCI RPC returned non-JSON: ${text.slice(0, 120)}`, this.name, method);
    }

    if (body.error !== null && body.error !== undefined) {
      throw new UciError(`LuCI RPC error: ${JSON.stringify(body.error)}`, this.name, method, body.error);
    }

    // The `result: null` failure convention described in the file header.
    if (body.result === null && !opts.nullOk) {
      throw new UciError(
        `uci.${method} returned null — does config "${String(params[0])}" exist in /etc/config?`,
        this.name,
        method,
        body
      );
    }

    return body.result;
  }
}
