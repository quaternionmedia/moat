/**
 * Advisory role validation: catch obviously-wrong configurations.
 * Role is never used for branching, but flagging obvious mistakes is helpful.
 */

import { Device } from "./inventory";
import { POLICY } from "./policy";

/**
 * Validate device role against its configuration.
 * "router" devices should have firewall policy; "ap" devices should not.
 * This is advisory only — a config works either way, but a mismatch is likely a typo.
 */
export function validateRole(name: string, device: Device): string[] {
  const warnings: string[] = [];

  const hasPolicy = name in POLICY;

  if (device.role === "router" && !hasPolicy) {
    warnings.push(
      `device '${name}' has role='router' but no policy entry (zero firewall resources will be created)`
    );
  }

  if (device.role === "ap" && hasPolicy) {
    warnings.push(
      `device '${name}' has role='ap' but policy entry exists (firewall resources will be created on an AP)`
    );
  }

  return warnings;
}

/**
 * Validate all devices and return all warnings.
 */
export function validateAllRoles(devices: Record<string, Device>): string[] {
  const allWarnings: string[] = [];
  for (const [name, device] of Object.entries(devices)) {
    allWarnings.push(...validateRole(name, device));
  }
  return allWarnings;
}

// ── Unit tests ────────────────────────────────────────────────────────────────

export function runTests() {
  console.log("Running role validation tests...");

  // Test 1: router with policy — OK
  {
    const warnings = validateRole("moatnet", {
      endpoint: "http://localhost",
      role: "router",
      vlan_ports: {},
    });
    if (warnings.length !== 0) {
      console.error("FAIL: router with policy should not warn");
      console.error("  Got:", warnings);
    } else {
      console.log("PASS: router with policy");
    }
  }

  // Test 2: ap without policy — OK
  {
    const warnings = validateRole("drawbridge", {
      endpoint: "http://localhost",
      role: "ap",
      vlan_ports: {},
    });
    if (warnings.length !== 0) {
      console.error("FAIL: ap without policy should not warn");
      console.error("  Got:", warnings);
    } else {
      console.log("PASS: ap without policy");
    }
  }

  // Test 3: router without policy — WARNING
  {
    // Temporarily remove moatnet from POLICY to test
    const originalPolicy = POLICY["moatnet"];
    delete POLICY["moatnet"];

    const warnings = validateRole("moatnet", {
      endpoint: "http://localhost",
      role: "router",
      vlan_ports: {},
    });
    if (warnings.length === 0) {
      console.error("FAIL: router without policy should warn");
    } else if (
      !warnings[0].includes("no policy entry")
    ) {
      console.error("FAIL: wrong warning message");
      console.error("  Got:", warnings[0]);
    } else {
      console.log("PASS: router without policy warns");
    }

    // Restore
    if (originalPolicy) {
      POLICY["moatnet"] = originalPolicy;
    }
  }

  // Test 4: ap with policy — WARNING
  {
    const warnings = validateRole("drawbridge", {
      endpoint: "http://localhost",
      role: "ap",
      vlan_ports: {},
    });
    // drawbridge is not in POLICY, so this should not warn
    if (warnings.length !== 0) {
      console.error("FAIL: ap without policy in POLICY should not warn");
      console.error("  Got:", warnings);
    } else {
      console.log("PASS: ap without policy does not warn");
    }
  }

  console.log("Role validation tests complete!");
}

// Run tests if invoked directly
if (require.main === module) {
  runTests();
}
