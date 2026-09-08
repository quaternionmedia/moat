/**
 * Main entry point: instantiate OpenWrt devices.
 *
 * No provider objects here any more. The old uapi provider needed one
 * `uapi.Provider` per device carrying an endpoint and bearer token; UCI needs
 * neither. Device credentials are read from the environment inside the
 * resource (see uciResource.ts) so that no password is written into Pulumi
 * state, which leaves this file as a plain loop over the inventory.
 *
 * Before `pulumi up` / `pulumi preview`:
 *
 *   set -a; . ./.env; set +a     # OPENWRT_USER / OPENWRT_PASSWORD
 *
 * WiFi passwords stay in Pulumi config, encrypted — they are per-SSID data
 * rather than a device login, so config is the right home for them:
 *
 *   pulumi config set --secret --path 'wifiPasswords:drawbridge:MySSID' '...'
 */

import * as pulumi from "@pulumi/pulumi";
import { OpenwrtDevice } from "./device";
import { INVENTORY, filterByPlatform, filterEnabled } from "./inventory";
import { POLICY } from "./policy";

const cfg = new pulumi.Config();
const wifiPasswords = cfg.getObject<Record<string, Record<string, string>>>("wifiPasswords") ?? {};

/**
 * Declare that rollback has been measured working (src/uci/write.test.ts).
 * Affects reporting only — an apply behaves the same either way, but claiming
 * protection that was never observed would be worse than saying nothing.
 */
const rollbackVerified = cfg.getBoolean("rollbackVerified") ?? false;

/** Rollback window. Anything under 90s is silently no timer at all, so 90 up. */
const applyTimeout = cfg.getNumber("applyTimeout") ?? 90;

const openwrtDevices = filterEnabled(filterByPlatform(INVENTORY, "openwrt"));

const devices: Record<string, OpenwrtDevice> = {};

for (const [deviceName, device] of Object.entries(openwrtDevices)) {
  // Inject per-SSID WiFi passwords from config into the device model.
  const withPasswords = { ...device };
  const devicePasswords = wifiPasswords[deviceName];
  if (withPasswords.wireless?.ssids && devicePasswords) {
    withPasswords.wireless = {
      ...withPasswords.wireless,
      ssids: Object.fromEntries(
        Object.entries(withPasswords.wireless.ssids).map(([ssidName, ssidConfig]) => [
          ssidName,
          { ...ssidConfig, key: devicePasswords[ssidName] ?? ssidConfig.key },
        ])
      ),
    };
  }

  devices[deviceName] = new OpenwrtDevice(deviceName, {
    device: withPasswords,
    policy: POLICY[deviceName],
    applyTimeout,
    rollbackVerified,
  });
}

export const deviceNames = Object.keys(devices);

/** Per-device, per-config-file reconcile summaries, handy in `pulumi stack output`. */
export const summaries = Object.fromEntries(
  Object.entries(devices).map(([name, d]) => [
    name,
    Object.fromEntries(Object.entries(d.configs).map(([cfgName, r]) => [cfgName, r!.summary])),
  ])
);
