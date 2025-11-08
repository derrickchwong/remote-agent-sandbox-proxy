# Remote Agent Sandbox Proxy

An HTTP proxy service for routing requests to agent sandboxes running in Kubernetes. This proxy enables external clients to interact with sandboxes through a simple path-based routing system.

> **⚠️ PROTOTYPE DISCLAIMER**
>
> This proxy is a **prototype** and is **NOT production-ready**. It lacks critical security features required for production use:
> - ❌ **No authentication** - Anyone with network access can use the proxy
> - ❌ **No authorization** - No access control or user permissions
> - ❌ **No rate limiting** - Vulnerable to abuse and DoS attacks
> - ❌ **No request validation** - Limited input sanitization
>
> **Do not expose this proxy to the public internet without implementing proper security measures.**
>
> For production use, you must implement:
> - Authentication (API keys, OAuth, JWT, mutual TLS)
> - Authorization and access control
> - Rate limiting and quotas
> - Request validation and sanitization
> - Audit logging
> - Network policies

## Architecture

```
External Client (Gemini CLI)
    ↓ HTTP request
Public LoadBalancer (GKE)
    ↓
Proxy Service (discovers sandboxes via K8s API)
    ↓ routes based on path: /{username}/{sandboxname}/*
Sandbox Pods (internal services)
```

## Features

- **Path-based routing**: Route requests to sandboxes via `/{username}/{sandboxname}/{endpoint}`
- **Automatic discovery**: Watches Kubernetes for Sandbox resources and updates routing table
- **Public LoadBalancer**: Accessible from anywhere without port-forwarding
- **Sandbox management API**: Create, delete, pause, resume sandboxes
- **GCS persistence**: Sandboxes backed by Google Cloud Storage for persistent data
- **Health checks**: Built-in health and status endpoints
- **Lightweight**: Minimal resource footprint
- **Scalable**: Can run multiple replicas for high availability

## Prerequisites

- GKE cluster with [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) installed
- `kubectl` configured for your cluster
- GCP project with Artifact Registry repository
- Cloud Build API enabled
- GCS bucket for sandbox storage

---

## Quick Start

Deploy using **Cloud Build** - one command builds the image and deploys to your GKE cluster.

### 1. Setup GCS Storage

Create the GCS bucket and service accounts:

```bash
export PROJECT_ID="my-project-id"
export BUCKET_NAME="my-sandbox-storage-bucket"
export GCP_SA_NAME="sandbox-gcs-sa"

./setup-gcs-storage.sh
```

### 2. Create Artifact Registry Repository

```bash
gcloud artifacts repositories create my-repo \
  --repository-format=docker \
  --location=us-central1
```

### 3. Grant Cloud Build Permissions

```bash
# Get your project number
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')

# Grant Cloud Build permission to deploy to GKE
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com \
  --role=roles/container.developer
```

### 4. Build and Deploy

Run Cloud Build with your configuration:

```bash
gcloud builds submit \
  --substitutions=\
_REGION=us-central1,\
_REPO_NAME=my-repo,\
_IMAGE_TAG=latest,\
_GKE_CLUSTER=my-cluster,\
_GKE_LOCATION=us-central1,\
_OVERLAY=dev,\
_GCS_BUCKET_NAME=my-sandbox-storage-bucket,\
_GCS_SERVICE_ACCOUNT=sandbox-gcs-sa@my-project.iam.gserviceaccount.com,\
_DEFAULT_SANDBOX_IMAGE=us-central1-docker.pkg.dev/my-project/my-repo/sandbox-runtime:latest,\
_PROXY_SA=sandbox-proxy-sa@my-project.iam.gserviceaccount.com,\
_GCS_SA=sandbox-gcs-sa@my-project.iam.gserviceaccount.com
```

**That's it!** Cloud Build will:
1. ✅ Build the Docker image
2. ✅ Push to Artifact Registry
3. ✅ Generate Kustomize configuration
4. ✅ Deploy to GKE
5. ✅ Verify deployment succeeded

### 5. Get the LoadBalancer IP

```bash
kubectl get service sandbox-proxy

# Wait for EXTERNAL-IP to be assigned
# NAME            TYPE           CLUSTER-IP      EXTERNAL-IP      PORT(S)        AGE
# sandbox-proxy   LoadBalancer   10.100.200.50   35.123.45.67     80:32000/TCP   2m
```

### 6. Test the Proxy

```bash
# Health check
curl http://EXTERNAL-IP/health

# List sandboxes
curl http://EXTERNAL-IP/api/sandboxes
```

---

## Configuration Parameters

All configuration is passed via Cloud Build substitutions:

| Parameter | Description | Example |
|-----------|-------------|---------|
| `_REGION` | Artifact Registry region | `us-central1` |
| `_REPO_NAME` | Artifact Registry repository | `my-repo` |
| `_IMAGE_TAG` | Image tag | `latest` or `v1.0.0` |
| `_GKE_CLUSTER` | GKE cluster name | `my-cluster` |
| `_GKE_LOCATION` | GKE cluster region | `us-central1` |
| `_OVERLAY` | Environment name | `dev`, `staging`, or `prod` |
| `_GCS_BUCKET_NAME` | GCS bucket for storage | `my-sandbox-storage` |
| `_GCS_SERVICE_ACCOUNT` | Service account for GCS | `gcs-sa@project.iam.gserviceaccount.com` |
| `_DEFAULT_SANDBOX_IMAGE` | Default sandbox image | `registry/sandbox-runtime:latest` |
| `_PROXY_SA` | Proxy service account | `proxy-sa@project.iam.gserviceaccount.com` |
| `_GCS_SA` | GCS service account | `gcs-sa@project.iam.gserviceaccount.com` |

---

## File Structure

```
remote-agent-sandbox-proxy/
├── src/
│   └── server.ts                      # Proxy server code
├── k8s/
│   ├── base/                          # Base Kubernetes resources
│   │   ├── deployment.yaml            # Deployment + Service
│   │   ├── rbac.yaml                  # RBAC configuration
│   │   ├── sandbox-gcs-sa.yaml        # GCS ServiceAccount
│   │   └── kustomization.yaml         # Kustomize base
│   └── overlays/
│       └── kustomization.yaml.template  # Template (for reference)
├── cloudbuild.yaml                    # Cloud Build CI/CD pipeline
├── setup-gcs-storage.sh               # GCS setup script
└── README.md                          # This file
```

**Note:** The `k8s/overlays/` directory is gitignored. Cloud Build generates the overlay dynamically during deployment.

---

## API Endpoints

### Health Check
```
GET /health
```

Returns proxy status and number of discovered sandboxes.

**Response:**
```json
{
  "status": "ok",
  "sandboxes": 3,
  "timestamp": "2025-10-31T10:30:00.000Z"
}
```

### Management API

#### List All Sandboxes
```
GET /api/sandboxes
```

Returns all sandboxes with detailed information.

#### Get Sandbox Status
```
GET /api/sandboxes/:username/:name
```

Returns status for a specific sandbox.

#### Create Sandbox
```
POST /api/sandboxes
```

**Request:**
```json
{
  "name": "my-sandbox",
  "username": "alice",
  "image": "us-central1-docker.pkg.dev/project/repo/sandbox-runtime:latest",
  "namespace": "default"
}
```

#### Delete Sandbox
```
DELETE /api/sandboxes/:username/:name?namespace=default
```

#### Pause Sandbox
```
POST /api/sandboxes/:username/:name/pause
```

Sets sandbox replicas to 0, stopping the pod but preserving configuration.

#### Resume Sandbox
```
POST /api/sandboxes/:username/:name/resume
```

Sets sandbox replicas to 1, restarting the pod.

### Proxy to Sandbox
```
{METHOD} /{username}/{sandboxname}/{endpoint}
```

Forwards the request to the sandbox's internal service.

**Example:**
```bash
curl -X POST http://EXTERNAL-IP/alice/my-sandbox/v1/shell/exec \
  -H "Content-Type: application/json" \
  -d '{"command": "ls -la"}'
```

---

## Multi-Environment Deployment

Deploy to different environments by changing the `_OVERLAY` parameter:

```bash
# Development
gcloud builds submit --substitutions=_OVERLAY=dev,...

# Staging
gcloud builds submit --substitutions=_OVERLAY=staging,...

# Production
gcloud builds submit --substitutions=_OVERLAY=prod,...
```

---

## Local Development

### Run Locally

```bash
# Install dependencies
npm install

# Build
npm run build

# Set environment variables
export GOOGLE_CLOUD_PROJECT=my-project
export GCS_BUCKET_NAME=my-bucket
export GCS_SERVICE_ACCOUNT=my-sa@my-project.iam.gserviceaccount.com
export DEFAULT_SANDBOX_IMAGE=my-image:latest

# Run
npm start
```

### Deploy Manually with kubectl

If you need to deploy without Cloud Build:

```bash
# 1. Create overlay from template
mkdir -p k8s/overlays/dev
cp k8s/overlays/kustomization.yaml.template k8s/overlays/dev/kustomization.yaml

# 2. Edit with your values
nano k8s/overlays/dev/kustomization.yaml

# 3. Build and push image manually
docker build -t us-central1-docker.pkg.dev/my-project/my-repo/sandbox-proxy:latest .
docker push us-central1-docker.pkg.dev/my-project/my-repo/sandbox-proxy:latest

# 4. Deploy
kubectl apply -k k8s/overlays/dev/
```

### Port Forward for Testing

```bash
kubectl port-forward service/sandbox-proxy 8080:80
# Access at http://localhost:8080
```

---

## Updating the Deployment

To update code or configuration:

```bash
# Just run Cloud Build again
gcloud builds submit --substitutions=...
```

Cloud Build will rebuild, push, and redeploy automatically.

---

## Troubleshooting

### Cloud Build fails with permission error

Grant Cloud Build permission to deploy:
```bash
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member=serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com \
  --role=roles/container.developer
```

### Pod fails with "environment variable required" error

Check Cloud Build substitutions are correct:
```bash
# View the generated ConfigMap
kubectl get configmap -o yaml | grep sandbox-proxy-config
```

### Workload Identity issues

Verify service account annotations:
```bash
kubectl get sa sandbox-proxy -o yaml
kubectl get sa sandbox-gcs-ksa -o yaml
```

Check IAM bindings:
```bash
gcloud iam service-accounts get-iam-policy sandbox-gcs-sa@${PROJECT_ID}.iam.gserviceaccount.com
```

### Sandbox not discovered

1. Check if sandbox exists: `kubectl get sandboxes`
2. Check if sandbox is labeled with `user` label
3. Check proxy logs: `kubectl logs -l app=sandbox-proxy`

### LoadBalancer stuck in Pending

Check GKE quota and ensure LoadBalancer services are enabled.

---

## Useful Commands

```bash
# Check deployment status
kubectl get pods -l app=sandbox-proxy
kubectl rollout status deployment/sandbox-proxy

# View logs
kubectl logs -f -l app=sandbox-proxy

# Verify configuration
kubectl get configmap -o yaml | grep sandbox-proxy-config
kubectl get sa sandbox-proxy -o yaml
kubectl get sa sandbox-gcs-ksa -o yaml

# Get LoadBalancer IP
kubectl get svc sandbox-proxy

# Test endpoints
curl http://EXTERNAL-IP/health
curl http://EXTERNAL-IP/api/sandboxes
```

---

## Security Considerations

1. **Authentication**: Currently no authentication. Consider adding:
   - API keys
   - OAuth/JWT tokens
   - Mutual TLS

2. **Network Policies**: Restrict which pods can access sandboxes

3. **RBAC**: The proxy has appropriate ClusterRole permissions (configured)

4. **Workload Identity**: GKE Workload Identity configured for secure GCP access

5. **Rate Limiting**: Add rate limiting to prevent abuse

---

## Monitoring

### Logs

```bash
kubectl logs -l app=sandbox-proxy -f
```

### Metrics

Consider adding Prometheus metrics:
- Request count by sandbox
- Request latency
- Error rates
- Sandbox discovery stats

---

## License

Apache-2.0
