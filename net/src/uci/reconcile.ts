/**
 * Reconciling desired UCI config against what a device currently holds.
 *
 * This is the engine behind the per-config-file resource model: each Pulumi
 * resource owns one UCI config file (`network`, `firewall`, `dhcp`,
 * `wireless`), and its input is the complete set of sections it wants there.
 * `stageConfig` stages the delta; committing is deliberately separate, so a
 * whole multi-file change can go out under a single rollback-protected apply
 * (see ./apply.ts).
 *
 * ## The pruning problem
 *
 * A naive reconcile — "delete every section not in desired" — would destroy
 * config the device needs and we never intended to own. On the target router
 * `network` holds `globals` (ULA prefix), `loopback`, and an anonymous
 * `device` section for br-lan, none of which appear in our VLAN model. Wiping
 * `loopback` or the bridge device would be a self-inflicted outage.
 *
 * So ownership is explicit: `managed` decides which sections we may delete,
 * and `preserve` is a hard stop-list checked even for managed sections.
 * Anything unmanaged is left exactly as found. Pruning is opt-in.
 *
 * Note there is no "adopt" step anywhere here. `putSection` is an idempotent
 * upsert, so a stock `lan` section is simply updated in place — the 422
 * collision that forced adoption under the uapi REST provider does not exist
 * on UCI.
 */

import { Section, SectionValues, Sections, UciTransport, UciValue } from "./types";

export interface ReconcileOptions {
  /**
   * Predicate for "we own this section and may delete it". Defaults to
   * `false` for everything, i.e. nothing is ever pruned unless the caller
   * opts in — the safe default.
   */
  managed?: (name: string, section: Section) => boolean;
  /**
   * Sections that must never be deleted, even when `managed` returns true.
   * Use for anything whose loss costs you access to the device.
   */
  preserve?: string[];
  /** Delete managed sections absent from `desired`. Off by default. */
  prune?: boolean;
  /**
   * Remove options that exist on the device but not in the desired section.
   * Off by default, because UCI sections routinely carry options written by
   * the device itself that we have no opinion about.
   */
  pruneOptions?: boolean;
}

/** What a reconcile would do — the basis for a readable Pulumi diff. */
export interface ConfigPlan {
  config: string;
  create: string[];
  update: Array<{ section: string; options: string[] }>;
  deleteSections: string[];
  deleteOptions: Array<{ section: string; options: string[] }>;
  unchanged: string[];
  /** Sections present on the device that we do not own. Never touched. */
  unmanaged: string[];
}

/** True when the plan would change nothing. */
export function isNoop(plan: ConfigPlan): boolean {
  return (
    plan.create.length === 0 &&
    plan.update.length === 0 &&
    plan.deleteSections.length === 0 &&
    plan.deleteOptions.length === 0
  );
}

/** Compare two UCI values. Lists are order-significant (UCI preserves order). */
function valueEquals(a: UciValue | undefined, b: UciValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const aList = Array.isArray(a);
  const bList = Array.isArray(b);
  // A single-element list and a scalar are the same thing on disk, so treat
  // them as equal rather than reporting a phantom change every run.
  if (aList !== bList) {
    const aArr = aList ? (a as string[]) : [a as string];
    const bArr = bList ? (b as string[]) : [b as string];
    return aArr.length === bArr.length && aArr.every((v, i) => v === bArr[i]);
  }
  if (aList && bList) {
    const x = a as string[];
    const y = b as string[];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return a === b;
}

/** Options in `desired` that differ from `current`. */
function changedOptions(current: SectionValues, desired: SectionValues): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(desired)) {
    if (!valueEquals(current[k], v)) out.push(k);
  }
  return out.sort();
}

/**
 * Compute what would change, without touching the device.
 *
 * Pure, so it is also the natural unit to test and the natural thing to render
 * in a preview.
 */
export function planConfig(
  config: string,
  current: Sections,
  desired: Sections,
  opts: ReconcileOptions = {}
): ConfigPlan {
  const managed = opts.managed ?? (() => false);
  const preserve = new Set(opts.preserve ?? []);

  const plan: ConfigPlan = {
    config,
    create: [],
    update: [],
    deleteSections: [],
    deleteOptions: [],
    unchanged: [],
    unmanaged: [],
  };

  for (const [name, want] of Object.entries(desired)) {
    const have = current[name];
    if (!have) {
      plan.create.push(name);
      continue;
    }
    const changed = changedOptions(have.values, want.values);
    // A section type change cannot be expressed as an option update; UCI
    // needs the section rewritten, which putSection does anyway.
    const typeChanged = want.type !== "" && have.type !== want.type;
    if (typeChanged && !changed.includes(".type")) changed.unshift(".type");

    if (changed.length > 0) {
      plan.update.push({ section: name, options: changed });
    } else {
      plan.unchanged.push(name);
    }

    if (opts.pruneOptions) {
      const stale = Object.keys(have.values)
        .filter((k) => !(k in want.values))
        .sort();
      if (stale.length > 0) plan.deleteOptions.push({ section: name, options: stale });
    }
  }

  for (const [name, have] of Object.entries(current)) {
    if (name in desired) continue;
    if (!managed(name, have)) {
      // Not ours: record it for visibility, but never touch it.
      plan.unmanaged.push(name);
      continue;
    }
    if (preserve.has(name)) {
      plan.unmanaged.push(name);
      continue;
    }
    if (opts.prune) plan.deleteSections.push(name);
    else plan.unmanaged.push(name);
  }

  plan.create.sort();
  plan.deleteSections.sort();
  plan.unchanged.sort();
  plan.unmanaged.sort();
  return plan;
}

/**
 * Stage the delta for one config file. Does **not** commit — the caller
 * applies once across all config files so the change lands atomically under a
 * single rollback timer.
 */
export async function stageConfig(
  transport: UciTransport,
  config: string,
  desired: Sections,
  opts: ReconcileOptions = {}
): Promise<ConfigPlan> {
  const current = await transport.getAll(config);
  const plan = planConfig(config, current, desired, opts);

  // Deletions first: a rename-shaped change (delete old, create new) is less
  // likely to collide if the removal happens before the addition.
  for (const name of plan.deleteSections) {
    await transport.deleteSection(config, name);
  }
  for (const { section, options } of plan.deleteOptions) {
    await transport.deleteOptions(config, section, options);
  }
  // Creates and updates take different UCI calls: `add` names a new section,
  // while `set` only mutates one that already exists. The plan already tells
  // us which is which, so no existence probe is needed.
  for (const name of plan.create) {
    const want = desired[name]!;
    await transport.addSection(config, name, want.type, want.values);
  }
  for (const { section } of plan.update) {
    const want = desired[section]!;
    await transport.setOptions(config, section, want.values);
  }

  return plan;
}

/** One-line human summary, for Pulumi log output. */
export function summarize(plan: ConfigPlan): string {
  const parts = [
    `+${plan.create.length}`,
    `~${plan.update.length}`,
    `-${plan.deleteSections.length}`,
  ];
  if (plan.deleteOptions.length > 0) parts.push(`-${plan.deleteOptions.length} opt-sets`);
  return (
    `${plan.config}: ${parts.join(" ")} ` +
    `(${plan.unchanged.length} unchanged, ${plan.unmanaged.length} not ours)`
  );
}
