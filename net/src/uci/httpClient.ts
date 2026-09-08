/**
 * A minimal fetch implementation over node:http / node:https.
 *
 * Node's global `fetch` cannot be told to skip TLS verification per-request
 * without pulling in undici as a dependency, and OpenWrt devices ship a
 * self-signed certificate — on the target device it is self-signed *and*
 * expired (notAfter May 2026), so verification fails twice over. The global
 * `fetch` reports all of that as a bare `TypeError: fetch failed`, which is
 * about as unhelpful as an error can be.
 *
 * Rather than set NODE_TLS_REJECT_UNAUTHORIZED=0 — which silently disables
 * verification for the whole process, including any unrelated HTTPS call — this
 * shim scopes the exemption to the device connection that asked for it, and
 * turns transport failures into messages that name the cause.
 *
 * Only the subset the transports use is implemented: POST with a JSON body,
 * and a response exposing `ok` / `status` / `json()` / `text()`.
 */

import * as http from "node:http";
import * as https from "node:https";

export interface HttpClientOptions {
  /** Skip TLS certificate verification. Required for stock OpenWrt certs. */
  insecure?: boolean;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** The slice of the Response interface our transports rely on. */
interface MinimalResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Build a fetch-compatible function. Returned as `typeof fetch` so it drops
 * into the transports in place of the global.
 */
export function createFetch(opts: HttpClientOptions = {}): typeof fetch {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const isTls = url.protocol === "https:";
    const mod = isTls ? https : http;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    const body = typeof init?.body === "string" ? init.body : undefined;
    if (body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(body));

    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (isTls ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers,
          // Scoped to this client only, unlike the global env-var approach.
          ...(isTls && opts.insecure ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            const response: MinimalResponse = {
              ok: status >= 200 && status < 300,
              status,
              text: async () => text,
              json: async () => JSON.parse(text),
            };
            resolve(response as unknown as Response);
          });
        }
      );

      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request to ${url.host} timed out after ${timeoutMs}ms`));
      });

      req.on("error", (err: NodeJS.ErrnoException) => {
        // Name the actual cause; "fetch failed" tells the operator nothing.
        const hint =
          err.code === "ECONNREFUSED"
            ? ` — nothing is listening on ${url.host}`
            : err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH"
              ? ` — ${url.hostname} is unreachable from here`
              : err.code === "CERT_HAS_EXPIRED" ||
                  err.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
                  err.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
                  err.code === "ERR_TLS_CERT_ALTNAME_INVALID"
                ? ` — TLS certificate rejected (${err.code}). OpenWrt ships a ` +
                  `self-signed cert; set insecure: true on the device, or use http://`
                : err.code
                  ? ` — ${err.code}`
                  : "";
        const wrapped = new Error(`${init?.method ?? "GET"} ${url.href} failed${hint}`);
        // `cause` via the Error constructor needs ES2022; assign instead so
        // this compiles at the project's es2020 target.
        (wrapped as Error & { cause?: unknown }).cause = err;
        reject(wrapped);
      });

      if (body !== undefined) req.write(body);
      req.end();
    });
  };

  return impl as typeof fetch;
}
