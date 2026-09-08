/**
 * Pulumi dynamic resource for one UCI config file on one device.
 *
 * ## Why one resource per config file, and why it self-applies
 *
 * UCI staging is **per ubus session**: a different session sees an empty change
 * set. Pulumi dynamic providers cannot share an in-memory session between
 * resources — each create/update runs as an independently serialized closure.
 * So a design that staged in one resource and applied in another would stage
 * into a session that the applying resource never sees, and would cheerfully
 * apply nothing.
 *
 * Each resource therefore owns a complete stage → apply → verify → confirm
 * cycle for its config file, inside one session. That also keeps the whole
 * cycle within the session lifetime (300s by default).
 *
 * The trade-off is that a multi-file change is not atomic across files.
 * `device.ts` mitigates it by ordering: firewall before network, so interfaces
 * come up already covered by zones rather than briefly uncovered.
 *
 * ## Credentials
 *
 * Read from the environment at apply time (OPENWRT_USER / OPENWRT_PASSWORD, or
 * UCI_USERNAME / UCI_PASSWORD) rather than taken as resource inputs, so no
 * password is written into Pulumi state at all. `set -a; . ./.env; set +a`
 * before `pulumi up`.
 *
 * ## Destroy
 *
 * `delete` deliberately does **not** strip config from the device unless
 * `deleteOnDestroy` is set. Tearing the `network` config out of a live router
 * because a stack was destroyed is a way to lose the router, not a feature.
 * The default drops the resource from state and leaves the device running.
 */

import * as pulumi from "@pulumi/pulumi";
import {
  OwnershipSpec,
  Sections,
  applyChanges,
  authFromEnv,
  connect,
  isNoop,
  planConfig,
  stageConfig,
  summarize,
  toReconcileOptions,
} from "./uci";

export interface UciConfigArgs {
  /** Device key from INVENTORY, for messages only. */
  deviceName: pulumi.Input<string>;
  /** Base URL, e.g. "http://192.168.1.1" — no /api path, no trailing slash. */
  host: pulumi.Input<string>;
  /** UCI config file name: network / firewall / dhcp / wireless. */
  config: pulumi.Input<string>;
  /** Complete desired section set for this config file. */
  sections: pulumi.Input<Sections>;
  /** Serializable ownership policy — what may be pruned. */
  ownership: pulumi.Input<OwnershipSpec>;
  /**
   * Rollback window in seconds. Values under 90 are raised: rpcd silently
   * arms no timer below that.
   */
  applyTimeout?: pulumi.Input<number>;
  /**
   * Set once you have measured rollback working on this device (see
   * src/uci/write.test.ts). Only affects reporting, never behaviour.
   */
  rollbackVerified?: pulumi.Input<boolean>;
  /** Remove our managed sections from the device on destroy. Default false. */
  deleteOnDestroy?: pulumi.Input<boolean>;
  /**
   * Skip TLS verification. Required for any https OpenWrt endpoint, which
   * serves a self-signed certificate. Defaults to true.
   */
  insecure?: pulumi.Input<boolean>;
}

interface Inputs {
  deviceName: string;
  host: string;
  config: string;
  sections: Sections;
  ownership: OwnershipSpec;
  applyTimeout?: number;
  rollbackVerified?: boolean;
  deleteOnDestroy?: boolean;
  insecure?: boolean;
}

/** Stable fingerprint of the inputs that matter for diffing. */
function fingerprint(i: Inputs): string {
  return JSON.stringify({ sections: i.sections, ownership: i.ownership });
}

async function openTransport(i: Inputs) {
  const auth = authFromEnv();
  pulumi.log.debug(`[${i.deviceName}] env auth: username=${auth.username ? "***" : "(none)"} password=${auth.password ? "***" : "(none)"}`);

  // Fallback to Pulumi config if environment isn't available (e.g., in subprocess).
  // Config is encrypted, so this is safe. Keys are set as auth:username, auth:password.
  if (!auth.username) {
    const cfg = new pulumi.Config();
    const secret = cfg.getSecret("auth:username");
    if (typeof secret === "string") {
      auth.username = secret;
      pulumi.log.debug(`[${i.deviceName}] loaded username from config:secret`);
    } else {
      auth.username = cfg.get("auth:username");
      if (auth.username) pulumi.log.debug(`[${i.deviceName}] loaded username from config`);
    }
  }
  if (!auth.password) {
    const cfg = new pulumi.Config();
    const secret = cfg.getSecret("auth:password");
    if (typeof secret === "string") {
      auth.password = secret;
      pulumi.log.debug(`[${i.deviceName}] loaded password from config:secret`);
    } else {
      auth.password = cfg.get("auth:password");
      if (auth.password) pulumi.log.debug(`[${i.deviceName}] loaded password from config`);
    }
  }
  pulumi.log.debug(`[${i.deviceName}] final auth: username=${auth.username ? "***" : "(none)"} password=${auth.password ? "***" : "(none)"}`);

  if (!auth.username || !auth.password) {
    // List what we found to help debug missing credentials
    const found = Object.keys(process.env)
      .filter((k) => /openwrt|uci|pulumi/i.test(k))
      .map((k) => `${k}=${process.env[k] ? "***" : "(empty)"}`)
      .join(", ");
    pulumi.log.error(`DEBUG: found env vars: ${found}`);
    throw new Error(
      `No device credentials in the environment for "${i.deviceName}". ` +
        `Set OPENWRT_USER/OPENWRT_PASSWORD (or UCI_USERNAME/UCI_PASSWORD) before running pulumi ` +
        `— e.g. \`set -a; . ./.env; set +a\`. Credentials are read from the environment on purpose, ` +
        `to keep them out of Pulumi state. Currently found: ${found || "(none)"}`
    );
  }
  const connectOpts: Parameters<typeof connect>[0] = {
    baseUrl: i.host,
    auth,
    preference: "ubus",
    // Stock OpenWrt certs are self-signed, so https needs this or Node's fetch
    // fails with an opaque error before any UCI call is made.
    insecure: i.insecure ?? true,
    onEvent: (m) => pulumi.log.debug(`[${i.deviceName}/${i.config}] ${m}`),
  };
  if (i.rollbackVerified !== undefined) connectOpts.rollbackVerified = i.rollbackVerified;
  return connect(connectOpts);
}

/** Stage the delta and apply it, all inside one session. */
async function reconcileAndApply(i: Inputs): Promise<{ summary: string; applied: boolean }> {
  try {
    const transport = await openTransport(i);
  const label = `${i.deviceName}/${i.config}`;
  const reconcileOpts = toReconcileOptions(i.ownership);

  // Refuse to build on top of someone else's uncommitted work: applying would
  // silently include it.
  const preexisting = await transport.changes(i.config);
  if (preexisting.length > 0) {
    throw new Error(
      `${label}: the device already has ${preexisting.length} uncommitted UCI change(s) ` +
        `staged for "${i.config}". Applying now would commit them too. Resolve them ` +
        `first (LuCI "Revert" or a fresh session) and retry.`
    );
  }

  transport.beginTransaction();
  try {
    const plan = await stageConfig(transport, i.config, i.sections, reconcileOpts);
    const summary = summarize(plan);
    if (isNoop(plan)) {
      pulumi.log.info(`${label}: no changes (${summary})`);
      return { summary, applied: false };
    }
    pulumi.log.info(`${label}: ${summary}`);

    const applyOpts: Parameters<typeof applyChanges>[2] = {
      // A real round trip: if this fails we must not confirm.
      verify: async () => {
        const cur = await transport.getAll(i.config);
        return Object.keys(cur).length > 0;
      },
      onEvent: (m) => pulumi.log.info(`${label}: ${m}`),
    };
    if (i.applyTimeout !== undefined) applyOpts.timeout = i.applyTimeout;

    const result = await applyChanges(transport, [i.config], applyOpts);
    if (!result.confirmed) {
      throw new Error(
        `${label}: applied but could not confirm — the device did not answer afterwards. ` +
          (result.rollbackProtected
            ? `A rollback timer is armed and should restore the previous config shortly.`
            : `Rollback is not verified on this device, so the change may still be live.`)
      );
    }
    return { summary, applied: true };
  } finally {
    transport.endTransaction();
  }
  } catch (err) {
    const uciErr = err as any;
    let msg: string;
    if (err instanceof Error) {
      msg = `${err.message}`;
    } else if (typeof err === "object") {
      msg = JSON.stringify(err);
    } else {
      msg = String(err);
    }
    if (uciErr.transport) msg += ` [${uciErr.transport}/${uciErr.method || "?"}]`;
    if (uciErr.detail) msg += ` detail=${JSON.stringify(uciErr.detail)}`;

    pulumi.log.error(`${i.deviceName}/${i.config}: ${msg}`);
    const wrapped = new Error(`${i.deviceName}/${i.config}: reconciliation failed: ${msg}`);
    (wrapped as Error & { cause?: unknown }).cause = err;
    throw wrapped;
  }
}

const uciConfigProvider: pulumi.dynamic.ResourceProvider = {
  async check(_olds: any, news: any) {
    const failures: pulumi.dynamic.CheckFailure[] = [];
    if (!news.host || typeof news.host !== "string") {
      failures.push({ property: "host", reason: "host must be a non-empty string" });
    } else if (/\/api\/v\d/.test(news.host)) {
      failures.push({
        property: "host",
        reason: `host looks like a uapi REST endpoint ("${news.host}"). Use the device base URL, e.g. http://192.168.1.1`,
      });
    }
    if (!news.config) failures.push({ property: "config", reason: "config is required" });
    return { inputs: news, failures };
  },

  async diff(_id: string, olds: any, news: any) {
    // Input-only comparison: diff runs during preview and must not touch the
    // device. Real drift is surfaced by `pulumi refresh` via read().
    const replaces: string[] = [];
    if (olds.host !== news.host) replaces.push("host");
    if (olds.config !== news.config) replaces.push("config");
    const changed = olds.fingerprint !== fingerprint(news as Inputs);
    return {
      changes: changed || replaces.length > 0,
      replaces,
      deleteBeforeReplace: false,
    };
  },

  async create(inputs: any) {
    const i = inputs as Inputs;
    const { summary, applied } = await reconcileAndApply(i);
    return {
      id: `${i.deviceName}:${i.config}`,
      outs: { ...i, fingerprint: fingerprint(i), summary, applied },
    };
  },

  async update(_id: string, _olds: any, news: any) {
    const i = news as Inputs;
    const { summary, applied } = await reconcileAndApply(i);
    return { outs: { ...i, fingerprint: fingerprint(i), summary, applied } };
  },

  async read(id: string, props: any) {
    // Refresh: report whether the device still matches, without changing it.
    const i = props as Inputs;
    try {
      const transport = await openTransport(i);
      const current = await transport.getAll(i.config);
      const plan = planConfig(i.config, current, i.sections, toReconcileOptions(i.ownership));
      return {
        id,
        props: { ...props, drift: !isNoop(plan), summary: summarize(plan) },
      };
    } catch (err) {
      pulumi.log.warn(`refresh of ${id} failed: ${String(err)}`);
      return { id, props };
    }
  },

  async delete(id: string, props: any) {
    const i = props as Inputs;
    if (!i.deleteOnDestroy) {
      pulumi.log.warn(
        `${id}: leaving device configuration in place. Removing the "${i.config}" config ` +
          `from a live router on destroy is more likely to strand it than to help; set ` +
          `deleteOnDestroy: true if you really want the sections removed.`
      );
      return;
    }
    const transport = await openTransport(i);
    transport.beginTransaction();
    try {
      // Empty desired set + the same ownership policy = remove exactly what we
      // own, leaving stock and preserved sections untouched.
      await stageConfig(transport, i.config, {}, toReconcileOptions(i.ownership));
      const applyOpts: Parameters<typeof applyChanges>[2] = {
        verify: async () => Object.keys(await transport.getAll(i.config)).length >= 0,
      };
      if (i.applyTimeout !== undefined) applyOpts.timeout = i.applyTimeout;
      await applyChanges(transport, [i.config], applyOpts);
    } finally {
      transport.endTransaction();
    }
  },
};

/** One UCI config file on one device, reconciled and applied as a unit. */
export class UciConfig extends pulumi.dynamic.Resource {
  public readonly summary!: pulumi.Output<string>;
  public readonly applied!: pulumi.Output<boolean>;

  constructor(name: string, args: UciConfigArgs, opts?: pulumi.CustomResourceOptions) {
    super(
      uciConfigProvider,
      name,
      { summary: undefined, applied: undefined, fingerprint: undefined, drift: undefined, ...args },
      opts
    );
  }
}
