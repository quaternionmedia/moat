/**
 * Shared session handling for both UCI transports.
 *
 * Verified against the live device: the token accepted by LuCI RPC as
 * `?auth=<tok>` is the *same* ubus session id accepted as `params[0]` of a
 * `/ubus` call. So there is exactly one credential concept here, not two, and
 * both transports share this manager.
 *
 * The important operational fact: these sessions **expire**. A static token
 * pasted into config works until it silently starts returning HTTP 403
 * (LuCI RPC) or `-32002 Access denied` (ubus). To survive that, the manager
 * needs credentials it can re-login with; a bare session id is supported for
 * convenience but cannot be renewed.
 */

import { UciAuthError } from "./types";

/** ubus `session.login` signature, per device introspection. */
interface LoginResult {
  ubus_rpc_session: string;
  timeout?: number;
  expires?: number;
}

export interface UciAuth {
  /**
   * An existing session id (e.g. the contents of `.token`). Used as-is until
   * it is rejected. Cannot be renewed — supply credentials for that.
   */
  session?: string;
  /** Username for `session.login`. Required to recover from expiry. */
  username?: string;
  /** Password for `session.login`. */
  password?: string;
  /** Requested session lifetime in seconds. Device may cap this. */
  timeout?: number;
}

/**
 * Build auth from the environment.
 *
 * `UCI_SESSION` alone is fine for read-only use, but it cannot be renewed —
 * supply `UCI_USERNAME`/`UCI_PASSWORD` for anything long-running, since rpcd
 * sessions expire (default 300s) and a large apply outlives them.
 */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): UciAuth {
  const auth: UciAuth = {};
  if (env.UCI_SESSION) auth.session = env.UCI_SESSION;
  // OPENWRT_USER/OPENWRT_PASSWORD are the names used in this project's .env,
  // so accept both spellings rather than making callers remap them.
  const username = env.UCI_USERNAME ?? env.OPENWRT_USER;
  const password = env.UCI_PASSWORD ?? env.OPENWRT_PASSWORD;
  if (username) auth.username = username;
  if (password) auth.password = password;
  if (env.UCI_TIMEOUT) {
    const t = Number(env.UCI_TIMEOUT);
    if (Number.isFinite(t)) auth.timeout = t;
  }
  return auth;
}

/** True if this auth can be used at all (either a session or credentials). */
export function hasUsableAuth(auth: UciAuth): boolean {
  return Boolean(auth.session || (auth.username && auth.password));
}

/**
 * Holds the current session and knows how to obtain a new one.
 *
 * Transports call `get()` before a request and `invalidate()` when the device
 * rejects the session; the next `get()` transparently re-logs-in. That keeps
 * expiry handling out of every call site.
 */
export class SessionManager {
  private current?: string;
  private inFlight?: Promise<string>;
  private txDepth = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly auth: UciAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly insecure = true
  ) {
    this.current = auth.session;
  }

  /** True if we hold credentials and can therefore recover from expiry. */
  get canRenew(): boolean {
    return Boolean(this.auth.username && this.auth.password);
  }

  /** Current session id, logging in if we do not have one. */
  async get(): Promise<string> {
    if (this.current) return this.current;
    // Collapse concurrent logins — 247 resources would otherwise stampede.
    if (!this.inFlight) {
      this.inFlight = this.login().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** Drop the cached session so the next `get()` re-authenticates. */
  invalidate(): void {
    this.current = undefined;
  }

  /**
   * Mark the start of a stage-then-apply cycle.
   *
   * Critical: ubus stages UCI changes **per session** — a new session sees an
   * empty change set (verified on the device). So re-authenticating between
   * staging and applying would silently discard every staged change and then
   * apply nothing, while reporting success. Inside a transaction the
   * transports must therefore refuse to renew, and fail loudly instead.
   *
   * The practical consequence: a whole stage+apply cycle has to finish inside
   * one session lifetime (300s by default on this device).
   */
  beginTransaction(): void {
    this.txDepth++;
  }

  endTransaction(): void {
    if (this.txDepth > 0) this.txDepth--;
  }

  /** True while a stage-then-apply cycle is in progress. */
  get inTransaction(): boolean {
    return this.txDepth > 0;
  }

  private async login(): Promise<string> {
    if (!this.canRenew) {
      throw new UciAuthError(
        "Session was rejected and no username/password is configured to renew it. " +
          "Supply credentials so the transport can re-login on expiry.",
        "session"
      );
    }

    const res = await this.fetchImpl(`${this.baseUrl}/ubus`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "call",
        // The null session is the only one permitted to call session.login.
        params: [
          "00000000000000000000000000000000",
          "session",
          "login",
          {
            username: this.auth.username,
            password: this.auth.password,
            ...(this.auth.timeout !== undefined ? { timeout: this.auth.timeout } : {}),
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new UciAuthError(`session.login failed: HTTP ${res.status}`, "session", "login");
    }

    const body = (await res.json()) as {
      result?: [number, LoginResult?];
      error?: { code: number; message: string };
    };

    if (body.error) {
      throw new UciAuthError(
        `session.login rejected: ${body.error.message} (${body.error.code})`,
        "session",
        "login",
        body.error
      );
    }

    const [status, payload] = body.result ?? [];
    if (status !== 0 || !payload?.ubus_rpc_session) {
      throw new UciAuthError(
        `session.login returned status ${status ?? "?"} with no session id — bad credentials?`,
        "session",
        "login",
        body.result
      );
    }

    this.current = payload.ubus_rpc_session;
    return this.current;
  }
}
