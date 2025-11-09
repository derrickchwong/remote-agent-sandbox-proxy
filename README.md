# Remote Agent Sandbox Proxy

An authenticated HTTP proxy service for routing requests to agent sandboxes running in Kubernetes. This proxy enables external clients to securely interact with their own sandboxes through API key authentication and namespace-based isolation.

## Security Status

✅ **Authentication**: API key-based authentication (SHA-256 hashed)
✅ **Authorization**: User-based access control - users can only access their own sandboxes
✅ **Resource Quotas**: Per-user namespace quotas to prevent abuse
✅ **Network Isolation**: Network policies between user namespaces
✅ **Audit Logging**: All operations logged to PostgreSQL database
✅ **Namespace Isolation**: Each user gets their own Kubernetes namespace

⚠️ **Still Recommended for Production**:
- Rate limiting per API key/user
- TLS/HTTPS on LoadBalancer
- Advanced monitoring and alerting
- Regular security audits
- Automated backups

## Architecture

```
External Client
    ↓ HTTP request with API key
Public LoadBalancer (GKE)
    ↓
Proxy Service (validates API key, checks ownership)
    ├─ PostgreSQL (users, API keys, sandboxes, audit logs)
    └─ routes to: /proxy/{sandboxname}/*
         ↓
User Namespace (user-<username>)
├─ Resource Quota (4 CPU, 8Gi RAM, max 10 sandboxes)
├─ Network Policy (isolated from other users)
└─ Sandbox Pods (internal services)
    └─ GCS Storage (persistent data)
```

## Features

- **🔐 API Key Authentication**: SHA-256 hashed API keys with expiration support
- **👥 User Management**: Admin API for creating users and managing API keys
- **🏠 Namespace Isolation**: Each user gets their own Kubernetes namespace
- **📊 Resource Quotas**: Per-user limits to prevent resource abuse
- **🔒 Network Policies**: Traffic isolation between user namespaces
- **📝 Audit Logging**: All operations logged to database
- **🔄 Sandbox Management**: Create, delete, pause, resume sandboxes
- **📦 GCS Persistence**: Sandboxes backed by Google Cloud Storage
- **🚀 Scalable**: Can run multiple replicas for high availability

## Prerequisites

- GKE cluster with [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) installed
- `kubectl` configured for your cluster
- GCP project with Artifact Registry repository
- Cloud Build API enabled
- GCS bucket for sandbox storage

---

## Quick Start

**📚 For complete deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)**
**📖 For API documentation, see [API_USAGE.md](./API_USAGE.md)**

Deploy using **Cloud Build** - builds the image, deploys PostgreSQL and proxy to your GKE cluster.

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

### 6. Bootstrap Authentication

```bash
# Wait for PostgreSQL to be ready
kubectl wait --for=condition=ready pod -l app=postgres --timeout=300s

# Run bootstrap script (generates admin key, creates admin user)
./scripts/bootstrap-admin.sh

# Restart proxy to pick up admin key
kubectl rollout restart deployment/sandbox-proxy
kubectl rollout status deployment/sandbox-proxy
```

**Save the admin API key shown by the bootstrap script!**

### 7. Create Your First User

```bash
export PROXY_IP=$(kubectl get svc sandbox-proxy -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
export ADMIN_API_KEY="<key-from-bootstrap>"

# Create user
curl -X POST http://$PROXY_IP/api/admin/users \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com"}'

# Generate API key for user (save the user ID from above response)
curl -X POST http://$PROXY_IP/api/admin/users/<USER_ID>/apikeys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice primary key"}'
```

**Save the user API key! It's only shown once.**

### 8. User Creates Sandbox

```bash
export USER_API_KEY="<key-from-above>"

# Create sandbox (automatically creates user-alice namespace)
curl -X POST http://$PROXY_IP/api/sandboxes \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-sandbox"}'

# List sandboxes (shows only user's sandboxes)
curl http://$PROXY_IP/api/sandboxes \
  -H "Authorization: Bearer $USER_API_KEY"
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

## Documentation

- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Complete deployment guide with troubleshooting
- **[API_USAGE.md](./API_USAGE.md)** - Comprehensive API reference with examples
- **[ARCHITECTURE_AUTH.md](./ARCHITECTURE_AUTH.md)** - Architecture and design decisions

## File Structure

```
remote-agent-sandbox-proxy/
├── src/
│   ├── server.ts                      # Main server
│   ├── db/
│   │   ├── pool.ts                    # Database connection pool
│   │   └── queries/                   # Database query functions
│   │       ├── users.ts
│   │       ├── apiKeys.ts
│   │       ├── sandboxes.ts
│   │       └── auditLogs.ts
│   ├── middleware/
│   │   ├── auth.ts                    # Authentication middleware
│   │   └── authorize.ts               # Authorization middleware
│   ├── routes/
│   │   ├── admin.ts                   # Admin API routes
│   │   ├── user.ts                    # User self-service routes
│   │   ├── sandboxes.ts               # Sandbox management routes
│   │   └── proxy.ts                   # Proxy routes
│   └── utils/
│       └── crypto.ts                  # API key generation/hashing
├── k8s/
│   ├── base/
│   │   ├── deployment.yaml            # Proxy deployment + service
│   │   ├── postgres.yaml              # PostgreSQL StatefulSet + service
│   │   ├── postgres-secret.yaml       # Database credentials
│   │   ├── admin-secret.yaml          # Admin API key
│   │   ├── rbac.yaml                  # RBAC configuration
│   │   ├── sandbox-gcs-sa.yaml        # GCS ServiceAccount
│   │   └── kustomization.yaml         # Kustomize base
│   └── overlays/                      # Generated by Cloud Build
├── scripts/
│   ├── bootstrap-admin.sh             # Bootstrap admin credentials
│   └── generate-admin-key.sh          # Generate admin API key
├── cloudbuild.yaml                    # Cloud Build CI/CD
├── DEPLOYMENT.md                      # Deployment guide
├── API_USAGE.md                       # API documentation
├── ARCHITECTURE_AUTH.md               # Architecture documentation
└── README.md                          # This file
```

---

## API Endpoints

**📖 For complete API documentation with examples, see [API_USAGE.md](./API_USAGE.md)**

### Public Endpoints

```
GET /health  # No authentication required
```

### Admin API (requires admin API key)

```
POST   /api/admin/users                    # Create user
GET    /api/admin/users                    # List users
GET    /api/admin/users/:userId            # Get user details
PUT    /api/admin/users/:userId            # Update user
DELETE /api/admin/users/:userId            # Delete user

POST   /api/admin/users/:userId/apikeys    # Generate API key for user
GET    /api/admin/users/:userId/apikeys    # List user's API keys
DELETE /api/admin/apikeys/:keyId           # Revoke API key
```

### User Self-Service API (requires user API key)

```
GET    /api/me                             # Get own info
POST   /api/me/apikeys                     # Generate own API key
GET    /api/me/apikeys                     # List own API keys
DELETE /api/me/apikeys/:keyId              # Revoke own API key
```

### Sandbox Management API (requires user API key)

```
GET    /api/sandboxes          # List user's sandboxes
POST   /api/sandboxes          # Create sandbox
GET    /api/sandboxes/:name    # Get sandbox status
DELETE /api/sandboxes/:name    # Delete sandbox
POST   /api/sandboxes/:name/pause    # Pause sandbox
POST   /api/sandboxes/:name/resume   # Resume sandbox
```

### Proxy API (requires user API key)

```
ALL    /proxy/:sandboxname/*   # Proxy to sandbox
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
