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

// Filter to OpenWrt devices only and enabled only
const openwrtDevices = filterEnabled(filterByPlatform(INVENTORY, "openwrt"));

// Instantiate one per device
const devices: Record<string, OpenwrtDevice> = {};

for (const [deviceName, device] of Object.entries(openwrtDevices)) {
  // Get the API token from Pulumi config (secret)
  const token = cfg.requireSecret(`tokens:${deviceName}`);

  // Create a provider for this device
  const provider = new uapi.Provider(`uapi-${deviceName}`, {
    endpoint: device.endpoint,
    token,
    insecure: device.insecure ?? true,
  });

  // Get the policy for this device (defaults to empty if absent)
  const devicePolicy = POLICY[deviceName];

  // Instantiate the device resource
  devices[deviceName] = new OpenwrtDevice(
    deviceName,
    {
      device,
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
