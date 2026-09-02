/**
 * Main entry point: instantiate OpenWrt devices with per-device providers.
 * No for_each trap, no provider alias limits — just a plain loop.
 */

import * as pulumi from "@pulumi/pulumi";
import * as uapi from "@pulumi/uapi";
import { OpenwrtDevice } from "./device";
import { INVENTORY, filterByPlatform, filterEnabled } from "./inventory";
import { POLICY } from "./policy";
import { VLAN_NETWORKS } from "./vlans";

const cfg = new pulumi.Config();
const tokensObj = cfg.getObject<Record<string, string>>("tokens") || {};
const wifiPasswords = cfg.getObject<Record<string, Record<string, string>>>("wifiPasswords") || {};

// Filter to OpenWrt devices only and enabled only
const openwrtDevices = filterEnabled(filterByPlatform(INVENTORY, "openwrt"));

// Instantiate one per device
const devices: Record<string, OpenwrtDevice> = {};

for (const [deviceName, device] of Object.entries(openwrtDevices)) {
  // Get the API token from Pulumi config
  if (!tokensObj[deviceName]) {
    throw new Error(`Missing tokens.${deviceName} in configuration`);
  }
  const token = tokensObj[deviceName];

  // Create a provider for this device
  const provider = new uapi.Provider(`uapi-${deviceName}`, {
    endpoint: device.endpoint,
    token,
    insecure: device.insecure ?? true,
  });

  // Get the policy for this device (defaults to empty if absent)
  const devicePolicy = POLICY[deviceName];

  // Inject WiFi passwords into device config
  const deviceWithPasswords = { ...device };
  if (deviceWithPasswords.wireless?.ssids && wifiPasswords[deviceName]) {
    deviceWithPasswords.wireless = {
      ...deviceWithPasswords.wireless,
      ssids: Object.fromEntries(
        Object.entries(deviceWithPasswords.wireless.ssids).map(([ssidName, ssidConfig]) => [
          ssidName,
          {
            ...ssidConfig,
            key: wifiPasswords[deviceName][ssidName] || ssidConfig.key,
          },
        ])
      ),
    };
  }

  // Instantiate the device resource
  devices[deviceName] = new OpenwrtDevice(
    deviceName,
    {
      device: deviceWithPasswords,
      vlans: VLAN_NETWORKS,
      policy: devicePolicy,
    },
    {
      providers: { uapi: provider },
    }
  );
}

// Export device names for convenience
export const deviceNames = Object.keys(devices);
