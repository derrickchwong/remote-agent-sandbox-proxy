# Authentication & Authorization Architecture Plan

## Current State Analysis

### Existing Implementation
- **No authentication**: Anyone can access all endpoints
- **No authorization**: No user ownership or access control
- **Shared namespace**: All sandboxes in `default` namespace
- **No user management**: Username is just a label, not enforced
- **No API key system**: No way to identify/authenticate users

### API Endpoints (Current)
```
GET  /health
GET  /sandboxes (legacy)
GET  /api/sandboxes
GET  /api/sandboxes/:username/:name
POST /api/sandboxes
DELETE /api/sandboxes/:username/:name
POST /api/sandboxes/:username/:name/pause
POST /api/sandboxes/:username/:name/resume
ALL  /:username/:sandboxname/*  (proxy)
```

## Proposed Architecture

### 1. Database Schema

Use **PostgreSQL** (Cloud SQL on GCP) for production-ready auth system.

#### Tables

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(63) UNIQUE NOT NULL,  -- DNS-compliant (for namespace names)
  email VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,

  CONSTRAINT username_format CHECK (username ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')
);

-- API Keys table
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash VARCHAR(255) NOT NULL,  -- SHA-256 hash of the API key
  key_prefix VARCHAR(16) NOT NULL,  -- First 8 chars for identification (e.g., "sk_live_abcd1234")
  name VARCHAR(255),  -- Optional friendly name
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,  -- Optional expiration
  last_used_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,

  INDEX idx_key_hash (key_hash),
  INDEX idx_user_id (user_id)
);

-- Sandboxes table (ownership tracking)
CREATE TABLE sandboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(63) NOT NULL,  -- DNS-compliant
  namespace VARCHAR(63) NOT NULL,  -- K8s namespace where sandbox lives
  k8s_resource_name VARCHAR(63) NOT NULL,  -- Name of the Sandbox CRD
  image VARCHAR(512),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(user_id, name),
  UNIQUE(namespace, k8s_resource_name),
  INDEX idx_user_id (user_id),
  INDEX idx_namespace (namespace),

  CONSTRAINT name_format CHECK (name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$')
);

-- Audit log (optional but recommended)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(50) NOT NULL,  -- 'create_sandbox', 'delete_sandbox', 'proxy_request', etc.
  resource_type VARCHAR(50),  -- 'sandbox', 'api_key', etc.
  resource_id VARCHAR(255),
  ip_address INET,
  user_agent TEXT,
  status VARCHAR(20),  -- 'success', 'failed', 'denied'
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_user_id (user_id),
  INDEX idx_action (action),
  INDEX idx_created_at (created_at)
);
```

#### API Key Format
- Format: `sk_live_<random_32_chars>` or `sk_test_<random_32_chars>`
- Example: `sk_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`
- Store: SHA-256 hash in database
- Display: Only show once on creation, then show prefix only

### 2. Namespace Strategy

**One namespace per user** approach:

#### Benefits
- Natural isolation between users
- Easy resource quota management per user
- Simple cleanup (delete namespace to remove all user resources)
- Align with Kubernetes RBAC best practices

#### Namespace Naming
- Format: `user-<username>`
- Example: `user-alice`, `user-bob`
- Auto-create namespace when user is created
- Apply resource quotas and network policies per namespace

#### Kubernetes Resources Per Namespace
```yaml
# Resource quota per user namespace
apiVersion: v1
kind: ResourceQuota
metadata:
  name: user-quota
  namespace: user-<username>
spec:
  hard:
    requests.cpu: "4"
    requests.memory: "8Gi"
    persistentvolumeclaims: "5"
    sandboxes.agents.x-k8s.io: "10"  # Max 10 sandboxes per user

# Network policy (isolate user namespaces)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: deny-from-other-namespaces
  namespace: user-<username>
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: user-<username>
    - namespaceSelector:
        matchLabels:
          name: default  # Allow proxy from default namespace
```

### 3. Authentication Middleware

#### Request Flow
```
1. Client sends request with header: Authorization: Bearer sk_live_xxx...
2. Auth middleware extracts API key
3. Hash the key and look up in database
4. Validate:
   - Key exists
   - Key is active (is_active = true)
   - Key not expired (expires_at > now OR expires_at IS NULL)
   - User is active (users.is_active = true)
5. Update last_used_at timestamp
6. Attach user context to request: req.user = { id, username, ... }
7. Continue to route handler
```

#### Middleware Implementation
```typescript
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    email: string;
  };
}

async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Extract API key from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }

  const apiKey = authHeader.substring(7); // Remove 'Bearer '

  // Hash the API key
  const keyHash = hashApiKey(apiKey);

  // Look up in database and validate
  const result = await validateApiKey(keyHash);

  if (!result.valid) {
    return res.status(401).json({ error: result.reason });
  }

  // Attach user to request
  req.user = result.user;

  // Continue
  next();
}
```

### 4. Authorization Rules

#### Endpoint Protection

| Endpoint | Auth Required | Authorization Logic |
|----------|---------------|---------------------|
| `GET /health` | No | Public |
| `GET /api/sandboxes` | Yes | Return only user's sandboxes |
| `GET /api/sandboxes/:username/:name` | Yes | Allow only if user owns sandbox |
| `POST /api/sandboxes` | Yes | Create sandbox in user's namespace |
| `DELETE /api/sandboxes/:username/:name` | Yes | Allow only if user owns sandbox |
| `POST /api/sandboxes/:username/:name/pause` | Yes | Allow only if user owns sandbox |
| `POST /api/sandboxes/:username/:name/resume` | Yes | Allow only if user owns sandbox |
| `ALL /:username/:sandboxname/*` | Yes | Allow only if user owns sandbox |

#### Authorization Logic
```typescript
// Check if user owns the sandbox
async function userOwnsSandbox(
  userId: string,
  sandboxName: string
): Promise<boolean> {
  const sandbox = await db.query(
    'SELECT id FROM sandboxes WHERE user_id = $1 AND name = $2',
    [userId, sandboxName]
  );
  return sandbox.rowCount > 0;
}

// Authorization middleware
async function authorizeSandboxAccess(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { name } = req.params;
  const userId = req.user!.id;

  const hasAccess = await userOwnsSandbox(userId, name);

  if (!hasAccess) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have access to this sandbox'
    });
  }

  next();
}
```

### 5. Admin API for User & API Key Management

#### New Admin Endpoints

```
POST   /api/admin/users                    # Create user
GET    /api/admin/users                    # List all users
GET    /api/admin/users/:userId            # Get user details
PUT    /api/admin/users/:userId            # Update user
DELETE /api/admin/users/:userId            # Delete user (cascade deletes sandboxes)

POST   /api/admin/users/:userId/apikeys    # Generate API key
GET    /api/admin/users/:userId/apikeys    # List user's API keys
DELETE /api/admin/apikeys/:keyId           # Revoke API key

# Self-service endpoints (authenticated user managing their own keys)
GET    /api/me                             # Get current user info
POST   /api/me/apikeys                     # Generate API key for self
GET    /api/me/apikeys                     # List own API keys
DELETE /api/me/apikeys/:keyId              # Revoke own API key
```

#### Admin Authentication
For admin endpoints, use one of:
- **Option A**: Special admin API key (stored as env var)
- **Option B**: Admin user role with elevated permissions
- **Option C**: mTLS certificate-based auth for admin operations

**Recommendation**: Option A for simplicity (admin API key in K8s Secret)

### 6. Database Connection

#### Cloud SQL Setup
```bash
# Create Cloud SQL PostgreSQL instance
gcloud sql instances create sandbox-proxy-db \
  --database-version=POSTGRES_15 \
  --tier=db-f1-micro \
  --region=us-central1

# Create database
gcloud sql databases create sandbox_proxy \
  --instance=sandbox-proxy-db

# Create user
gcloud sql users create sandbox_proxy_user \
  --instance=sandbox-proxy-db \
  --password=<secure-password>
```

#### Connection from GKE
Use **Cloud SQL Proxy** sidecar container or **Workload Identity** with Cloud SQL IAM authentication.

```yaml
# Deployment with Cloud SQL Proxy sidecar
containers:
- name: proxy
  image: <proxy-image>
  env:
  - name: DB_HOST
    value: "127.0.0.1"
  - name: DB_PORT
    value: "5432"
  - name: DB_NAME
    value: "sandbox_proxy"
  - name: DB_USER
    value: "sandbox_proxy_user"
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: cloudsql-db-credentials
        key: password

- name: cloud-sql-proxy
  image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.8.0
  args:
  - "--structured-logs"
  - "--port=5432"
  - "PROJECT_ID:REGION:sandbox-proxy-db"
  securityContext:
    runAsNonRoot: true
```

#### Node.js Database Client
Use `pg` (node-postgres) library:

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

### 7. Migration Strategy

#### Phase 1: Database Setup
1. Create Cloud SQL instance
2. Run schema migrations
3. Create initial admin user and API key

#### Phase 2: Code Changes
1. Add database connection layer
2. Implement auth middleware
3. Add admin API endpoints for user/key management
4. Update existing endpoints to:
   - Require authentication
   - Enforce authorization
   - Use database for sandbox tracking

#### Phase 3: Namespace Migration
1. Implement namespace-per-user logic
2. Create namespaces for existing users
3. Apply resource quotas
4. Migrate existing sandboxes to user namespaces (if any)

#### Phase 4: Deployment
1. Update ConfigMap with DB connection details
2. Add DB password as Secret
3. Deploy updated proxy with Cloud SQL Proxy sidecar
4. Test authentication and authorization
5. Update documentation

### 8. Updated Sandbox Creation Flow

#### Old Flow
```
1. POST /api/sandboxes with { name, username, image }
2. Create Sandbox CRD in 'default' namespace
3. No ownership tracking
```

#### New Flow
```
1. POST /api/sandboxes with { name, image }
   - API key in Authorization header
2. Auth middleware validates API key → gets user
3. Check if user already has sandbox with this name → 409 if exists
4. Create user namespace if doesn't exist (user-<username>)
5. Create Sandbox CRD in user namespace (user-<username>)
6. Create GCS folder: <username>/<sandboxname>/
7. Record sandbox in database with user_id
8. Return sandbox details
```

### 9. Security Considerations

#### API Key Security
- Never log full API keys
- Use constant-time comparison for key validation
- Rate limit authentication attempts
- Rotate keys periodically
- Support key expiration

#### Database Security
- Use connection pooling with limits
- Parameterized queries to prevent SQL injection
- Encrypt DB password in K8s Secret
- Use Cloud SQL Proxy for secure connection
- Enable Cloud SQL audit logging

#### Network Security
- Keep Cloud SQL private (no public IP)
- Network policies between namespaces
- TLS for LoadBalancer (optional but recommended)

#### RBAC
- Proxy ServiceAccount needs cluster-wide permissions for:
  - Creating namespaces
  - Creating Sandbox CRDs in any namespace
  - Reading pods/services in any namespace
- No user pods should have access to proxy namespace

### 10. Code Structure Changes

#### Proposed File Structure
```
src/
├── server.ts              # Main Express app
├── middleware/
│   ├── auth.ts           # Authentication middleware
│   └── authorize.ts      # Authorization middleware
├── routes/
│   ├── admin.ts          # Admin API routes
│   ├── sandboxes.ts      # Sandbox management routes
│   ├── proxy.ts          # Proxy routes
│   └── user.ts           # User self-service routes
├── db/
│   ├── pool.ts           # Database connection pool
│   ├── migrations/       # SQL migration files
│   │   ├── 001_initial_schema.sql
│   │   └── 002_add_audit_logs.sql
│   └── queries/
│       ├── users.ts      # User queries
│       ├── apiKeys.ts    # API key queries
│       └── sandboxes.ts  # Sandbox queries
├── services/
│   ├── auth.ts           # Auth service (key validation, hashing)
│   ├── user.ts           # User management service
│   ├── sandbox.ts        # Sandbox management service
│   └── kubernetes.ts     # K8s API wrapper
└── utils/
    ├── crypto.ts         # API key generation and hashing
    ├── validators.ts     # Input validation
    └── errors.ts         # Custom error classes
```

### 11. Environment Variables

#### New Variables Needed
```bash
# Database
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=sandbox_proxy
DB_USER=sandbox_proxy_user
DB_PASSWORD=<from-secret>
DB_SSL=true

# Admin
ADMIN_API_KEY=<generated-admin-key>  # For admin endpoints

# Existing (keep)
GOOGLE_CLOUD_PROJECT=...
GCS_BUCKET_NAME=...
GCS_SERVICE_ACCOUNT=...
DEFAULT_SANDBOX_IMAGE=...
PORT=8080
```

### 12. Testing Strategy

#### Unit Tests
- Auth middleware with valid/invalid keys
- Authorization logic
- API key generation and hashing
- Database queries

#### Integration Tests
- Full auth flow (create user → create key → authenticate)
- Sandbox creation with ownership tracking
- Authorization enforcement (user A cannot access user B's sandbox)
- Namespace creation and resource quotas

#### Manual Testing Checklist
- [ ] Create user via admin API
- [ ] Generate API key for user
- [ ] Authenticate with API key
- [ ] Create sandbox (should go to user namespace)
- [ ] List sandboxes (should see only own sandboxes)
- [ ] Try to access another user's sandbox (should get 403)
- [ ] Proxy request to own sandbox
- [ ] Delete sandbox
- [ ] Revoke API key (subsequent requests should fail)

## Implementation Roadmap

### Sprint 1: Foundation (Week 1)
- [ ] Set up Cloud SQL instance
- [ ] Create database schema
- [ ] Add `pg` dependency and connection pool
- [ ] Create migration scripts
- [ ] Basic database query functions

### Sprint 2: Authentication (Week 2)
- [ ] Implement auth middleware
- [ ] API key generation and hashing utilities
- [ ] Admin API for user management
- [ ] Admin API for API key management
- [ ] Update Kubernetes deployment with DB connection

### Sprint 3: Authorization (Week 3)
- [ ] Add authorization middleware
- [ ] Update all existing endpoints to require auth
- [ ] Implement ownership checks
- [ ] Database tracking for sandboxes
- [ ] Update GET /api/sandboxes to filter by user

### Sprint 4: Namespace Strategy (Week 4)
- [ ] Implement namespace-per-user creation
- [ ] Update sandbox creation to use user namespaces
- [ ] Apply resource quotas per namespace
- [ ] Update RBAC for namespace creation
- [ ] Migrate existing sandboxes (if any)

### Sprint 5: Polish & Testing (Week 5)
- [ ] Add audit logging
- [ ] Comprehensive tests
- [ ] Documentation updates
- [ ] Performance testing
- [ ] Security review

## Breaking Changes

### API Changes
1. All endpoints (except `/health`) now require `Authorization: Bearer <api-key>` header
2. `POST /api/sandboxes` no longer accepts `username` parameter (derived from API key)
3. `GET /api/sandboxes` returns only authenticated user's sandboxes
4. Sandbox namespace is now `user-<username>` instead of `default`

### Backward Compatibility
- Old clients without API keys will get 401 Unauthorized
- Existing sandboxes in `default` namespace need migration
- Consider grace period with warning logs before enforcing auth

## Rollout Plan

### Option A: Big Bang (Not Recommended)
- Deploy all changes at once
- High risk of breaking existing users

### Option B: Gradual Rollout (Recommended)
1. **Phase 1**: Deploy with auth disabled (feature flag)
   - Add database and admin API
   - Create users and API keys
   - Test without enforcing auth
2. **Phase 2**: Enable auth in warning mode
   - Log unauthorized requests but allow them
   - Give users time to migrate
3. **Phase 3**: Enforce auth fully
   - Reject requests without valid API keys
   - All sandboxes in user namespaces

## Open Questions

1. **Admin key distribution**: How will the initial admin API key be distributed to administrators?
   - Recommendation: Store in K8s Secret, display once on deployment

2. **User self-registration**: Should users be able to create their own accounts, or admin-only?
   - Recommendation: Start with admin-only, add self-registration later if needed

3. **API key rotation**: Should there be automatic key rotation?
   - Recommendation: Support manual rotation, add automatic rotation in future

4. **Multi-tenancy**: Should we support organizations/teams with multiple users?
   - Recommendation: Start with simple user model, add teams later if needed

5. **Rate limiting**: What rate limits should be applied per user?
   - Recommendation: Start with generous limits, add configurable limits per user later

## Success Metrics

- ✅ 100% of API endpoints protected by authentication
- ✅ Each user can only access their own sandboxes
- ✅ All sandboxes tracked in database with ownership
- ✅ All sandboxes in user-specific namespaces
- ✅ Resource quotas applied per user
- ✅ Audit trail for all operations
- ✅ Zero downtime deployment
- ✅ <100ms authentication overhead per request

---

**Status**: Architecture design complete, ready for review and implementation
