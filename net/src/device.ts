/**
 * OpenwrtDevice ComponentResource: expands device config (inventory + policy)
 * into the UCI config files it owns, one Pulumi resource per file.
 *
 * The resource is driven by:
 * - device.vlan_ports: which VLANs go on which physical ports
 * - device.ip_vlans: which VLANs get IPs (driver for network interfaces)
 * - device.dhcp_vlans: which VLANs get DHCP pools
 * - device.wireless: radios and SSIDs
 * - policy: firewall zones, forwardings, rules, defaults, dnsmasq
 *
 * All inputs are plain data — no branching on role anywhere. The expansion
 * itself lives in `openwrt.ts` and is pure, so it is unit tested without a
 * router; this file only wires the results into Pulumi resources.
 *
 * ## Apply ordering
 *
 * Each config file applies independently (see uciResource.ts for why that is
 * forced by per-session UCI staging), so the order matters:
 *
 *   firewall → network → dhcp → wireless
 *
 * Firewall first means zones and rules already exist when the VLAN interfaces
 * come up, instead of interfaces appearing for a moment with no zone covering
 * them. Zones referring to not-yet-existing networks simply match nothing,
 * which is the harmless direction to fail in. DHCP follows the interfaces it
 * binds to, and wireless last since SSIDs attach to networks.
 */

import * as pulumi from "@pulumi/pulumi";
import { Device } from "./inventory";
import { DevicePolicy } from "./policy";
import { ExpandOptions, UciConfigName, expandDevice } from "./openwrt";
import { UciConfig } from "./uciResource";

export interface OpenwrtDeviceArgs {
  device: Device;
  policy?: Partial<DevicePolicy>;
  expand?: ExpandOptions;
  /** Rollback window in seconds; raised to 90 if lower. */
  applyTimeout?: number;
  /** Declare rollback measured-working on this device (reporting only). */
  rollbackVerified?: boolean;
  /** Strip our managed sections from the device on destroy. Default false. */
  deleteOnDestroy?: boolean;
}

/** Apply order. See the note above — this sequence is deliberate. */
const APPLY_ORDER: UciConfigName[] = ["firewall", "network", "dhcp", "wireless"];

export class OpenwrtDevice extends pulumi.ComponentResource {
  /** One resource per managed UCI config file, keyed by config name. */
  public readonly configs: Partial<Record<UciConfigName, UciConfig>> = {};

  constructor(name: string, args: OpenwrtDeviceArgs, opts?: pulumi.ComponentResourceOptions) {
    super("moat:device:OpenwrtDevice", name, {}, opts);

    const device = args.device;
    const plan = expandDevice(device, args.policy ?? {}, args.expand ?? {});

    // The inventory endpoint still carries the old uapi REST path in some
    // stacks; UCI wants the bare device base URL.
    const host = device.endpoint.replace(/\/api\/v\d+\/?$/, "").replace(/\/+$/, "");

    let previous: pulumi.Resource | undefined;

    for (const config of APPLY_ORDER) {
      const managed = plan[config];
      // A device with no opinion about a config file (moatnet has no radios)
      // must not get a resource, or reconcile would propose emptying it.
      if (Object.keys(managed.sections).length === 0) continue;

      const resource = new UciConfig(
        `${name}-${config}`,
        {
          deviceName: name,
          host,
          config,
          sections: managed.sections,
          ownership: managed.ownership,
          ...(args.applyTimeout !== undefined ? { applyTimeout: args.applyTimeout } : {}),
          ...(args.rollbackVerified !== undefined
            ? { rollbackVerified: args.rollbackVerified }
            : {}),
          ...(args.deleteOnDestroy !== undefined
            ? { deleteOnDestroy: args.deleteOnDestroy }
            : {}),
        },
        {
          parent: this,
          // Serialize the applies rather than letting Pulumi parallelise them:
          // concurrent applies to one device would race on UCI state.
          ...(previous ? { dependsOn: [previous] } : {}),
        }
      );

      this.configs[config] = resource;
      previous = resource;
    }

    this.registerOutputs({
      configs: Object.fromEntries(
        Object.entries(this.configs).map(([k, v]) => [k, v!.summary])
      ),
    });
  }
}
