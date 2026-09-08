# OpenTofu Configuration for OpenWRT Router Network

## Context

Bootstrap OpenTofu config in `/root/moat/net/` to manage a network of OpenWRT routers with custom interfaces, firewalls, VLANs, etc.

**Provider:** `openwrt-iac/uapi` v3.0.1 — uses the [uapi REST API](https://github.com/openwrt-iac/uapi).

**Devices:**
- **MoatNet** — primary router (the castle gate)
- **Drawbridge** — primary access point (the bridge to the keep)

**Naming:** By role, with medieval castle terminology where it enhances clarity.

**State:** Local `.tfstate` for now.

---

## Router Bootstrap (Manual, One-Time)

Before OpenTofu can manage a router, `uapi` must be installed and a token created.

### 1. Install uapi on the router

```sh
ssh root@<router-ip>
opkg update
opkg install uapi
```

### 2. Create an API token

```sh
uapi-token create --name tofu
# Save the token — it's shown only once
```

### 3. (Optional) Configure HTTPS certificate

uapi ships with a self-signed cert. For production, install a real cert via `luci-app-acme` or `acme.sh`. For now, we'll use `insecure = true`.

### 4. Note the endpoint

Default: `https://<router-ip>/api/v3`

---

## VLAN Topology (from MoatNet.csv)

| VLAN | Name | Network | Mask | Purpose |
|------|------|---------|------|---------|
| 1 | config | 192.168.1.0 | /24 | Device configuration |
| 2 | vwan | 192.168.2.0 | /24 | Virtual WAN |
| 3 | lan | 192.168.3.0 | /24 | Trusted WiFi |
| 4 | home | 192.168.4.0 | /24 | Home Assistant + trusted IoT |
| 5 | work | 192.168.5.0 | /24 | Work devices |
| 6 | guest | 192.168.6.0 | /24 | Guest WiFi |
| 7 | lab | 192.168.7.0 | /24 | Laboratory |
| 8 | k8s | 192.168.8.0 | /24 | Public Kubernetes |
| 9 | qm | 192.168.9.0 | /24 | QM network |
| 10 | lights | 10.10.0.0 | /16 | Lighting primary |
| 11 | lights_moat | 10.11.0.0 | /16 | Perimeter lighting |
| 12 | lights_studio | 10.12.0.0 | /16 | Studio DMX |
| 13 | lights_halloween | 10.13.0.0 | /16 | Exterior theatrical (WLED, xLights) |
| 14 | lights_home | 10.14.0.0 | /16 | Interior home lighting |
| 20 | audio | 10.20.0.0 | /16 | Audio primary |
| 21 | audio_moat | 10.21.0.0 | /16 | Perimeter audio |
| 22 | audio_studio | 10.22.0.0 | /16 | Studio (Dante, AES67) |
| 23 | audio_halloween | 10.23.0.0 | /16 | xLights audio |
| 24 | audio_home | 10.24.0.0 | /16 | Home music |
| 30 | video | 10.30.0.0 | /16 | Video primary |
| 31 | video_moat | 10.31.0.0 | /16 | Perimeter cameras (Frigate) |
| 32 | video_studio | 10.32.0.0 | /16 | Broadcast video |
| 33 | video_halloween | 10.33.0.0 | /16 | Theatrical video |
| 34 | video_home | 10.34.0.0 | /16 | Home video |
| 80 | kubernetes | 10.80.0.0 | /16 | Private Kubernetes |
| 86 | iot | 10.86.0.0 | /16 | Untrusted IoT |

---

## Approach

1. **providers.tf** — aliased `uapi` provider per device (`moatnet`, `drawbridge`)
2. **variables.tf** — device endpoints/tokens + VLAN definitions as a local map
3. **vlans.tf** — `uapi_network_bridge_vlan` for each VLAN
4. **interfaces.tf** — `uapi_network_interface` for each VLAN interface
5. **firewall.tf** — zones per VLAN, inter-zone rules, default policies
6. **dhcp.tf** — DHCP server per VLAN (where needed)
7. **.gitignore** — state files, tfvars, .terraform/

Tokens passed via environment variables: `TF_VAR_moatnet_token`, `TF_VAR_drawbridge_token`.

---

## Files to Create

```
net/
├── providers.tf      # uapi provider per device
├── variables.tf      # endpoints, tokens, VLAN map
├── vlans.tf          # bridge VLANs
├── interfaces.tf     # network interfaces
├── firewall.tf       # zones, rules, forwardings
├── dhcp.tf           # DHCP servers
└── .gitignore        # secrets + state
```

---

## Reuse

- Pattern from `/root/moat/tofu/providers.tf` — provider block style
- Pattern from `/root/moat/tofu/moat/variables.tf` — variable structure

---

## Steps

- [ ] Create `.gitignore`
- [ ] Create `providers.tf` with uapi provider + aliases for moatnet/drawbridge
- [ ] Create `variables.tf` with device config + VLAN definitions
- [ ] Create `vlans.tf` with bridge VLANs from CSV
- [ ] Create `interfaces.tf` with network interfaces per VLAN
- [ ] Create `firewall.tf` with zones and baseline rules
- [ ] Create `dhcp.tf` with DHCP servers for applicable VLANs

---

## Verification

```sh
cd /root/moat/net
export TF_VAR_moatnet_token="<token>"
export TF_VAR_drawbridge_token="<token>"
tofu init
tofu validate
tofu plan
```
