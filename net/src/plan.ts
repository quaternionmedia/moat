/**
 * Read-only dry run: show what would change on a device, without touching it.
 *
 *   UCI_HOST=http://192.168.1.1 UCI_SESSION=$(cat .token) \
 *     npx ts-node src/plan.ts moatnet
 *
 * Reads current UCI state, expands the inventory + policy into desired
 * sections, and prints the delta. Performs no writes and no staging, so it is
 * safe to run against a production router at any time.
 */

import { INVENTORY } from "./inventory";
import { POLICY } from "./policy";
import { UciConfigName, expandDevice } from "./openwrt";
import { endpointToHost } from "./device";
import {
  authFromEnv,
  connect,
  hasUsableAuth,
  isNoop,
  planConfig,
  summarize,
  toReconcileOptions,
} from "./uci";

const CONFIGS: UciConfigName[] = ["network", "firewall", "dhcp", "wireless"];

async function main(): Promise<void> {
  const deviceName = process.argv[2] ?? "moatnet";
  const device = INVENTORY[deviceName];
  if (!device) {
    console.error(`Unknown device "${deviceName}". Known: ${Object.keys(INVENTORY).join(", ")}`);
    process.exit(2);
  }

  const auth = authFromEnv();
  if (!hasUsableAuth(auth)) {
    console.error("Set UCI_SESSION, or UCI_USERNAME + UCI_PASSWORD.");
    process.exit(2);
  }

  // Endpoint in inventory carries the old uapi REST path; strip it and any
  // scheme mismatch by allowing UCI_HOST to win.
  const host = process.env.UCI_HOST ?? endpointToHost(device.endpoint);

  const transport = await connect({
    baseUrl: host,
    auth,
    insecure: device.insecure ?? true,
    onEvent: (m) => console.log(`[detect] ${m}`),
  });

  const plan = expandDevice(device, POLICY[deviceName]);
  console.log(`\nDry run for "${deviceName}" at ${host} via ${transport.name}\n`);

  let totalChanges = 0;
  for (const config of CONFIGS) {
    const managed = plan[config];
    const desired = managed.sections;
    // Skip config files this device has no opinion about (e.g. moatnet has no
    // wireless), rather than proposing to empty them.
    if (Object.keys(desired).length === 0) {
      console.log(`${config}: not managed for this device — skipped`);
      continue;
    }

    const current = await transport.getAll(config);
    const p = planConfig(config, current, desired, toReconcileOptions(managed.ownership));
    console.log(summarize(p));

    if (!isNoop(p)) {
      totalChanges++;
      if (p.create.length > 0) {
        console.log(`    + create (${p.create.length}): ${p.create.slice(0, 8).join(", ")}${p.create.length > 8 ? ", …" : ""}`);
      }
      if (p.update.length > 0) {
        console.log(`    ~ update (${p.update.length}):`);
        for (const u of p.update.slice(0, 6)) {
          console.log(`        ${u.section}: ${u.options.join(", ")}`);
        }
        if (p.update.length > 6) console.log(`        … ${p.update.length - 6} more`);
      }
      if (p.deleteSections.length > 0) {
        console.log(`    - delete (${p.deleteSections.length}): ${p.deleteSections.join(", ")}`);
      }
    }
    if (p.unmanaged.length > 0) {
      console.log(`    · left alone (${p.unmanaged.length}): ${p.unmanaged.join(", ")}`);
    }
  }

  // Staged changes would be applied by a subsequent up; warn if any exist.
  for (const config of CONFIGS) {
    const staged = await transport.changes(config);
    if (staged.length > 0) {
      console.log(`\n!! ${config} has ${staged.length} uncommitted change(s) already staged on the device`);
    }
  }

  console.log(
    `\n${totalChanges === 0 ? "No changes." : `${totalChanges} config file(s) would change.`} ` +
      `Nothing was written.\n`
  );
}

main().catch((err) => {
  console.error("\nplan failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
