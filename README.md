# moat

Homelab configuration. 

Includes:
- Kubernetes cluster
- Home automation
- Security systems
- And all things guarding the Castle 🏰

## Install

### Kubernetes Cluster
Installing a Kubernetes cluster is beyond the scope of this document. However k3s or minikube are great options for testing and local development.

#### k3s
[k3s](https://docs.k3s.io/) is a lightweight Kubernetes distribution that is easy to install and manage. It is ideal for running on low-resource devices like Raspberry Pi or in a local development environment.


```sh 
curl -sfL https://get.k3s.io | sh -
```

Use the following command to check the status of the cluster:
```sh
KUBE_CONFIG=/etc/rancher/k3s/k3s.yaml kubectl get nodes
```

### Clone the repo
```sh
git clone https://github.com/quaternionmedia/moat.git
cd moat
```

### Bootstrap
Use the `/groot` chart to bootstrap the cluster

```sh
kubectl create ns argo-cd
helm install argo-cd argo-cd/ -n argo-cd
helm template groot/ | k apply -f  -
```
