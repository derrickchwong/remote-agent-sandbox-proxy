# Deployment Guide - Authenticated Sandbox Proxy

This guide covers deploying the sandbox proxy with authentication and authorization to GKE.

## Prerequisites

- GKE cluster with agent-sandbox installed
- `kubectl` configured for your cluster
- `gcloud` CLI installed and authenticated
- GCP project with Artifact Registry repository
- Cloud Build API enabled
- GCS bucket for sandbox storage
- `jq` installed (for bootstrap script)

## Architecture Overview

The proxy uses:
- **PostgreSQL on GKE** for user/API key/sandbox tracking
- **Namespace-per-user** isolation with resource quotas
- **API key authentication** for all operations
- **Admin API** for user management
- **User namespaces** in format `user-<username>`

## Step-by-Step Deployment

### 1. Set Environment Variables

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export CLUSTER_NAME="your-gke-cluster"
export REPO_NAME="your-artifact-registry-repo"
export GCS_BUCKET="your-sandbox-storage-bucket"
```

### 2. Deploy PostgreSQL and Proxy

Using Cloud Build:

```bash
gcloud builds submit \
  --substitutions=\
_REGION=${REGION},\
_REPO_NAME=${REPO_NAME},\
_IMAGE_TAG=latest,\
_GKE_CLUSTER=${CLUSTER_NAME},\
_GKE_LOCATION=${REGION},\
_OVERLAY=dev,\
_GCS_BUCKET_NAME=${GCS_BUCKET},\
_GCS_SERVICE_ACCOUNT=sandbox-gcs-sa@${PROJECT_ID}.iam.gserviceaccount.com,\
_DEFAULT_SANDBOX_IMAGE=${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/sandbox-runtime:latest,\
_PROXY_SA=sandbox-proxy-sa@${PROJECT_ID}.iam.gserviceaccount.com,\
_GCS_SA=sandbox-gcs-sa@${PROJECT_ID}.iam.gserviceaccount.com
```

### 3. Wait for PostgreSQL to be Ready

```bash
kubectl wait --for=condition=ready pod -l app=postgres --timeout=300s
```

### 4. Bootstrap Admin Credentials

Run the bootstrap script to:
- Generate secure admin API key
- Create admin user in database
- Update Kubernetes secrets

```bash
./scripts/bootstrap-admin.sh
```

**IMPORTANT**: Save the admin API key shown by the script! You'll need it for admin operations.

### 5. Restart Proxy to Pick Up Admin Key

```bash
kubectl rollout restart deployment/sandbox-proxy
kubectl rollout status deployment/sandbox-proxy
```

### 6. Verify Deployment

```bash
# Get LoadBalancer IP
export PROXY_IP=$(kubectl get svc sandbox-proxy -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Test health endpoint (public, no auth required)
curl http://$PROXY_IP/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2025-11-09T...",
  "database": "connected"
}
```

## Initial Setup: Creating Users

### Create Your First User

Use the admin API key from the bootstrap script:

```bash
export ADMIN_API_KEY="<key-from-bootstrap-script>"

# Create a user
curl -X POST http://$PROXY_IP/api/admin/users \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "email": "alice@example.com"
  }'
```

Response:
```json
{
  "success": true,
  "user": {
    "id": "uuid-here",
    "username": "alice",
    "email": "alice@example.com",
    "created_at": "2025-11-09T...",
    "is_active": true
  }
}
```

### Generate API Key for User

```bash
# Save user ID from previous response
export USER_ID="uuid-from-above"

# Generate API key
curl -X POST http://$PROXY_IP/api/admin/users/$USER_ID/apikeys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice primary key"
  }'
```

Response:
```json
{
  "success": true,
  "message": "API key created successfully. Save this key - it will not be shown again.",
  "api_key": "sk_live_abc123def456...",
  "key_info": {
    "id": "key-uuid",
    "key_prefix": "sk_live_abc1",
    "name": "Alice primary key",
    "created_at": "2025-11-09T...",
    "expires_at": null
  }
}
```

**IMPORTANT**: Save the `api_key` value! It will not be shown again.

## User Operations

Now the user can operate with their API key:

```bash
export USER_API_KEY="sk_live_abc123def456..."

# Get user info
curl http://$PROXY_IP/api/me \
  -H "Authorization: Bearer $USER_API_KEY"

# Create a sandbox
curl -X POST http://$PROXY_IP/api/sandboxes \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-sandbox",
    "image": "us-central1-docker.pkg.dev/project/repo/sandbox-runtime:latest"
  }'

# List sandboxes (shows only user's sandboxes)
curl http://$PROXY_IP/api/sandboxes \
  -H "Authorization: Bearer $USER_API_KEY"

# Use sandbox via proxy
curl -X POST http://$PROXY_IP/proxy/my-sandbox/v1/shell/exec \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command": "ls -la"}'
```

## Namespace Structure

Each user gets their own namespace:

```
user-alice/          # Alice's namespace
├── Sandbox: my-sandbox
├── ResourceQuota: user-quota
│   ├── CPU: 4 cores (request), 8 cores (limit)
│   ├── Memory: 8Gi (request), 16Gi (limit)
│   └── Max sandboxes: 10
└── NetworkPolicy: allow-from-default
```

## Resource Quotas

Per-user limits (configurable in `src/routes/sandboxes.ts`):

- CPU requests: 4 cores
- CPU limits: 8 cores
- Memory requests: 8Gi
- Memory limits: 16Gi
- Max PVCs: 5
- Max sandboxes: 10

## Security Features

✅ **Authentication**: All endpoints except `/health` require API key
✅ **Authorization**: Users can only access their own sandboxes
✅ **Namespace Isolation**: Each user in separate namespace
✅ **Network Policies**: Traffic restricted between user namespaces
✅ **Resource Quotas**: Prevent resource abuse
✅ **Audit Logging**: All operations logged to database
✅ **API Key Hashing**: Keys stored as SHA-256 hashes

## Troubleshooting

### PostgreSQL Not Starting

```bash
# Check pod status
kubectl get pods -l app=postgres

# Check logs
kubectl logs -l app=postgres

# Verify PVC
kubectl get pvc postgres-pvc
```

### Proxy Can't Connect to Database

```bash
# Check proxy logs
kubectl logs -l app=sandbox-proxy

# Verify database credentials
kubectl get secret postgres-credentials -o yaml

# Test connection from proxy pod
kubectl exec -it deployment/sandbox-proxy -- sh
# Inside pod:
nc -zv postgres.default.svc.cluster.local 5432
```

### Authentication Failures

```bash
# Verify admin API key is set
kubectl get secret admin-credentials -o jsonpath='{.data.ADMIN_API_KEY}' | base64 -d

# Restart proxy after updating secrets
kubectl rollout restart deployment/sandbox-proxy
```

### User Can't Create Sandbox

```bash
# Check if user namespace exists
kubectl get namespace user-<username>

# Check resource quota usage
kubectl get resourcequota -n user-<username>

# Check proxy logs for errors
kubectl logs -l app=sandbox-proxy --tail=50
```

## Updating Secrets

### Change Database Password

```bash
kubectl create secret generic postgres-credentials \
  --from-literal=POSTGRES_USER=sandbox_proxy_user \
  --from-literal=POSTGRES_PASSWORD=NEW_SECURE_PASSWORD \
  --from-literal=POSTGRES_DB=sandbox_proxy \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart PostgreSQL
kubectl rollout restart statefulset/postgres

# Restart proxy
kubectl rollout restart deployment/sandbox-proxy
```

### Rotate Admin API Key

```bash
# Generate new key
./scripts/generate-admin-key.sh

# Update secret with new key
kubectl create secret generic admin-credentials \
  --from-literal=ADMIN_API_KEY=<new-key> \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart proxy
kubectl rollout restart deployment/sandbox-proxy
```

## Monitoring

```bash
# Check proxy logs
kubectl logs -f -l app=sandbox-proxy

# Check PostgreSQL logs
kubectl logs -f -l app=postgres

# View audit logs (from database)
kubectl exec -it $(kubectl get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}') -- \
  psql -U sandbox_proxy_user -d sandbox_proxy -c \
  "SELECT created_at, user_id, action, status FROM audit_logs ORDER BY created_at DESC LIMIT 20;"
```

## Backup and Recovery

### Backup PostgreSQL

```bash
# Create backup
kubectl exec $(kubectl get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}') -- \
  pg_dump -U sandbox_proxy_user sandbox_proxy > backup.sql

# Store in GCS
gsutil cp backup.sql gs://your-backup-bucket/postgres-backups/$(date +%Y%m%d-%H%M%S).sql
```

### Restore PostgreSQL

```bash
# Copy backup to pod
kubectl cp backup.sql $(kubectl get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}'):/tmp/

# Restore
kubectl exec $(kubectl get pod -l app=postgres -o jsonpath='{.items[0].metadata.name}') -- \
  psql -U sandbox_proxy_user sandbox_proxy < /tmp/backup.sql
```

## Next Steps

- Review [API_USAGE.md](./API_USAGE.md) for detailed API documentation
- Review [ARCHITECTURE_AUTH.md](./ARCHITECTURE_AUTH.md) for architecture details
- Set up monitoring and alerting
- Configure TLS for LoadBalancer
- Set up automated backups
