# CSI Proxmox
This chart installs the [proxmox-csi-plugin](https://github.com/sergelogvinov/proxmox-csi-plugin) to provide container storage through Proxmox VE.

## Install

Copied from the [proxmox-csi-plugin install documentation](https://github.com/sergelogvinov/proxmox-csi-plugin/blob/main/docs/install.md):

Create namespace and label it to allow privileged pods:

```bash
kubectl create ns csi-proxmox
kubectl label ns csi-proxmox pod-security.kubernetes.io/enforce=privileged
```

Label nodes with the topology region (proxmox cluster name) and zone (proxmox node name):
```bash
kubectl label nodes <node-name> topology.kubernetes.io/region=moat topology.kubernetes.io/zone=falcon
```

Create proxmox user, role and token:
```bash
pveum role add CSI -privs "VM.Audit VM.Allocate VM.Clone VM.Config.CPU VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Options VM.Migrate VM.Monitor VM.PowerMgmt Datastore.Allocate Datastore.AllocateSpace Datastore.Audit"
pveum role add CSI -privs "VM.Audit VM.Allocate VM.Clone VM.Config.CPU VM.Config.Disk VM.Config.HWType VM.Config.Memory VM.Config.Options VM.Migrate VM.PowerMgmt Datastore.Allocate Datastore.AllocateSpace Datastore.Audit"
pveum user add kubernetes-csi@pve
pveum aclmod / -user kubernetes-csi@pve -role CSI
pveum user token add kubernetes-csi@pve csi -privsep 0
```

Add the token to the `token_secret` field in `values.yaml`.
