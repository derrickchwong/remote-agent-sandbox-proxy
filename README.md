# Remote Agent Sandbox Proxy

An HTTP proxy service for routing requests to agent sandboxes running in Kubernetes. This proxy enables external clients to interact with sandboxes through a simple path-based routing system.

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
- **Health checks**: Built-in health and status endpoints
- **Lightweight**: Minimal resource footprint
- **Scalable**: Can run multiple replicas for high availability

## Prerequisites

- GKE cluster with [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) installed
- `kubectl` configured for your cluster
- Docker for building the image
- GCR (Google Container Registry) access or another container registry

## Quick Start

### 1. Build the Docker Image

```bash
# Set your GCP project ID
export PROJECT_ID=your-gcp-project-id

# Build the image
docker build -t gcr.io/${PROJECT_ID}/sandbox-proxy:latest .

# Push to GCR
docker push gcr.io/${PROJECT_ID}/sandbox-proxy:latest
```

### 2. Update Kubernetes Manifests

Edit `k8s/deployment.yaml` and replace `YOUR_PROJECT_ID` with your actual GCP project ID:

```yaml
image: gcr.io/your-gcp-project-id/sandbox-proxy:latest
```

### 3. Deploy to Kubernetes

```bash
# Apply RBAC (ServiceAccount, ClusterRole, ClusterRoleBinding)
kubectl apply -f k8s/rbac.yaml

# Deploy the proxy
kubectl apply -f k8s/deployment.yaml
```

### 4. Get the LoadBalancer IP

```bash
kubectl get service sandbox-proxy

# Wait for EXTERNAL-IP to be assigned
# Output:
# NAME            TYPE           CLUSTER-IP      EXTERNAL-IP      PORT(S)        AGE
# sandbox-proxy   LoadBalancer   10.100.200.50   35.123.45.67     80:32000/TCP   2m
```

### 5. Test the Proxy

```bash
# Health check
curl http://EXTERNAL-IP/health

# List available sandboxes
curl http://EXTERNAL-IP/sandboxes

# Execute command in a sandbox
curl -X POST http://EXTERNAL-IP/alice/my-sandbox/execute \
  -H "Content-Type: application/json" \
  -d '{"command": "ls -la"}'
```

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

### List Sandboxes
```
GET /sandboxes
```

Returns all discovered sandboxes.

**Response:**
```json
{
  "count": 2,
  "sandboxes": [
    {
      "path": "alice/my-sandbox",
      "service": "sandbox-my-sandbox",
      "namespace": "default",
      "ready": true
    },
    {
      "path": "bob/test-env",
      "service": "sandbox-test-env",
      "namespace": "default",
      "ready": true
    }
  ]
}
```

### Proxy to Sandbox
```
{METHOD} /{username}/{sandboxname}/{endpoint}
```

Forwards the request to the sandbox's internal service.

**Example - Execute Command:**
```bash
curl -X POST http://EXTERNAL-IP/alice/my-sandbox/execute \
  -H "Content-Type: application/json" \
  -d '{"command": "python script.py"}'
```

**Response:**
```json
{
  "stdout": "Hello from sandbox",
  "stderr": "",
  "exit_code": 0
}
```

## Username Labeling

For the proxy to route by username, sandboxes must be labeled with a `user` label:

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
kind: Sandbox
metadata:
  name: my-sandbox
  labels:
    user: alice  # Username for routing
spec:
  # ... rest of sandbox spec
```

If no `user` label is present, the sandbox is accessible via `default/{sandboxname}`.

## Configuration

### Environment Variables

- `PORT`: HTTP port to listen on (default: 8080)

### Customization

Edit `src/server.ts` to customize:
- Sandbox port (default: 8888)
- Cache refresh interval (default: 30 seconds)
- Add authentication/authorization
- Add rate limiting
- Add request logging

## Development

### Local Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally (requires kubeconfig)
npm start
```

### Testing with Port-Forward

If you want to test without a LoadBalancer:

```bash
kubectl port-forward service/sandbox-proxy 8080:80

# Then access at http://localhost:8080
```

## Deployment Strategies

### Single Region
Deploy one proxy per cluster (default configuration).

### Multi-Region
Deploy proxies in multiple GKE clusters and use a global load balancer to route traffic.

### High Availability
- Use `replicas: 2` or more in deployment.yaml (already configured)
- Proxy is stateless, so all replicas can serve traffic

## Security Considerations

1. **Authentication**: Currently no authentication. Consider adding:
   - API keys
   - OAuth/JWT tokens
   - Mutual TLS

2. **Network Policies**: Restrict which pods can access sandboxes

3. **RBAC**: The proxy has read-only access to Sandbox resources (already configured)

4. **Rate Limiting**: Add rate limiting to prevent abuse

## Monitoring

### Logs

```bash
# View proxy logs
kubectl logs -l app=sandbox-proxy -f
```

### Metrics

Consider adding Prometheus metrics:
- Request count by sandbox
- Request latency
- Error rates

## Troubleshooting

### Proxy not discovering sandboxes

Check RBAC permissions:
```bash
kubectl get clusterrole sandbox-proxy-role
kubectl get clusterrolebinding sandbox-proxy-binding
```

### LoadBalancer stuck in Pending

Check GKE quota and ensure LoadBalancer services are enabled in your cluster.

### 404 Sandbox not found

1. Check if sandbox exists: `kubectl get sandboxes`
2. Check if sandbox is labeled correctly with `user` label
3. Check proxy logs for discovery errors

### 503 Sandbox not ready

Wait for the sandbox pod to become ready:
```bash
kubectl get pods -l sandbox=my-sandbox
```

## Updating the Proxy

```bash
# Build new image
docker build -t gcr.io/${PROJECT_ID}/sandbox-proxy:v2 .
docker push gcr.io/${PROJECT_ID}/sandbox-proxy:v2

# Update deployment
kubectl set image deployment/sandbox-proxy proxy=gcr.io/${PROJECT_ID}/sandbox-proxy:v2

# Or edit deployment.yaml and re-apply
kubectl apply -f k8s/deployment.yaml
```

## Cleaning Up

```bash
kubectl delete -f k8s/deployment.yaml
kubectl delete -f k8s/rbac.yaml
```

## License

Apache-2.0
