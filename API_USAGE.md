# API Usage Guide

Complete guide to using the Sandbox Proxy API with authentication.

## Table of Contents

1. [Authentication](#authentication)
2. [Admin API](#admin-api)
3. [User Self-Service API](#user-self-service-api)
4. [Sandbox Management API](#sandbox-management-api)
5. [Proxy API](#proxy-api)
6. [Error Handling](#error-handling)

## Authentication

All API endpoints except `/health` require authentication via API key in the `Authorization` header.

### API Key Format

```
Authorization: Bearer <api-key>
```

### Types of API Keys

1. **Admin API Key**: For admin endpoints (`/api/admin/*`)
   - Stored in Kubernetes Secret `admin-credentials`
   - Generated during bootstrap

2. **User API Keys**: For user and sandbox endpoints
   - Format: `sk_live_<32_random_chars>`
   - Stored as SHA-256 hash in database
   - Created via admin or self-service API

## Admin API

Base path: `/api/admin/*`
Authentication: Admin API key required

### User Management

#### Create User

```bash
POST /api/admin/users
Content-Type: application/json
Authorization: Bearer <admin-api-key>

{
  "username": "alice",     # Required, DNS-compliant (lowercase, alphanumeric, hyphens)
  "email": "alice@example.com"  # Optional
}
```

Response:
```json
{
  "success": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "username": "alice",
    "email": "alice@example.com",
    "created_at": "2025-11-09T10:30:00.000Z",
    "is_active": true
  }
}
```

#### List Users

```bash
GET /api/admin/users?active_only=true
Authorization: Bearer <admin-api-key>
```

Response:
```json
{
  "count": 2,
  "users": [
    {
      "id": "uuid",
      "username": "alice",
      "email": "alice@example.com",
      "created_at": "2025-11-09T10:30:00.000Z",
      "is_active": true
    },
    {
      "id": "uuid",
      "username": "bob",
      "email": "bob@example.com",
      "created_at": "2025-11-09T11:00:00.000Z",
      "is_active": true
    }
  ]
}
```

#### Get User Details

```bash
GET /api/admin/users/:userId
Authorization: Bearer <admin-api-key>
```

#### Update User

```bash
PUT /api/admin/users/:userId
Content-Type: application/json
Authorization: Bearer <admin-api-key>

{
  "email": "newemail@example.com",  # Optional
  "is_active": false                # Optional - deactivate user
}
```

#### Delete User

**Warning**: Deletes user and all their API keys and sandboxes (cascade delete).

```bash
DELETE /api/admin/users/:userId
Authorization: Bearer <admin-api-key>
```

### API Key Management

#### Generate API Key for User

```bash
POST /api/admin/users/:userId/apikeys
Content-Type: application/json
Authorization: Bearer <admin-api-key>

{
  "name": "Alice primary key",      # Optional, friendly name
  "expires_at": "2026-12-31T23:59:59Z"  # Optional, ISO 8601 format
}
```

Response:
```json
{
  "success": true,
  "message": "API key created successfully. Save this key - it will not be shown again.",
  "api_key": "sk_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
  "key_info": {
    "id": "key-uuid",
    "key_prefix": "sk_live_a1b2",
    "name": "Alice primary key",
    "created_at": "2025-11-09T10:35:00.000Z",
    "expires_at": "2026-12-31T23:59:59Z"
  }
}
```

**Important**: The plaintext `api_key` is only shown once. Save it securely!

#### List User's API Keys

```bash
GET /api/admin/users/:userId/apikeys
Authorization: Bearer <admin-api-key>
```

Response:
```json
{
  "count": 2,
  "api_keys": [
    {
      "id": "key-uuid",
      "key_prefix": "sk_live_a1b2",
      "name": "Alice primary key",
      "created_at": "2025-11-09T10:35:00.000Z",
      "expires_at": null,
      "last_used_at": "2025-11-09T12:00:00.000Z",
      "is_active": true
    }
  ]
}
```

#### Revoke API Key

```bash
DELETE /api/admin/apikeys/:keyId
Authorization: Bearer <admin-api-key>
```

Response:
```json
{
  "success": true,
  "message": "API key revoked successfully"
}
```

## User Self-Service API

Base path: `/api/*`
Authentication: User API key required

### Get Current User Info

```bash
GET /api/me
Authorization: Bearer <user-api-key>
```

Response:
```json
{
  "user": {
    "id": "uuid",
    "username": "alice",
    "email": "alice@example.com"
  }
}
```

### Manage Own API Keys

#### Generate Own API Key

```bash
POST /api/me/apikeys
Content-Type: application/json
Authorization: Bearer <user-api-key>

{
  "name": "My laptop key",
  "expires_at": "2026-12-31T23:59:59Z"  # Optional
}
```

#### List Own API Keys

```bash
GET /api/me/apikeys
Authorization: Bearer <user-api-key>
```

#### Revoke Own API Key

```bash
DELETE /api/me/apikeys/:keyId
Authorization: Bearer <user-api-key>
```

## Sandbox Management API

Base path: `/api/sandboxes/*`
Authentication: User API key required
Authorization: User can only access their own sandboxes

### List Sandboxes

Returns only the authenticated user's sandboxes.

```bash
GET /api/sandboxes
Authorization: Bearer <user-api-key>
```

Response:
```json
{
  "count": 1,
  "sandboxes": [
    {
      "name": "my-sandbox",
      "namespace": "user-alice",
      "serviceFQDN": "my-sandbox.user-alice.svc.cluster.local",
      "service": "my-sandbox",
      "ready": true,
      "createdAt": "2025-11-09T10:40:00.000Z"
    }
  ]
}
```

### Create Sandbox

Creates sandbox in user's namespace (`user-<username>`).

```bash
POST /api/sandboxes
Content-Type: application/json
Authorization: Bearer <user-api-key>

{
  "name": "my-sandbox",    # Required, DNS-compliant
  "image": "us-central1-docker.pkg.dev/project/repo/sandbox-runtime:latest"  # Optional
}
```

Response:
```json
{
  "success": true,
  "message": "Sandbox 'my-sandbox' created successfully",
  "sandbox": {
    "name": "my-sandbox",
    "namespace": "user-alice",
    "image": "us-central1-docker.pkg.dev/..."
  }
}
```

**What happens**:
1. User namespace created if doesn't exist (`user-alice`)
2. Resource quota applied (4 CPU, 8Gi RAM, max 10 sandboxes)
3. Network policy created (isolate from other users)
4. GCS folder created (`alice/my-sandbox/`)
5. Sandbox CRD created in user namespace
6. Ownership recorded in database

### Get Sandbox Status

```bash
GET /api/sandboxes/:name
Authorization: Bearer <user-api-key>
```

Response:
```json
{
  "name": "my-sandbox",
  "namespace": "user-alice",
  "serviceFQDN": "my-sandbox.user-alice.svc.cluster.local",
  "service": "my-sandbox",
  "replicas": 1,
  "ready": true,
  "readyReason": null,
  "readyMessage": null,
  "createdAt": "2025-11-09T10:40:00.000Z"
}
```

### Delete Sandbox

```bash
DELETE /api/sandboxes/:name
Authorization: Bearer <user-api-key>
```

Response:
```json
{
  "success": true,
  "message": "Sandbox 'my-sandbox' deleted successfully"
}
```

### Pause Sandbox

Sets replicas to 0, stopping the pod but preserving configuration.

```bash
POST /api/sandboxes/:name/pause
Authorization: Bearer <user-api-key>
```

Response:
```json
{
  "success": true,
  "message": "Sandbox 'my-sandbox' paused successfully",
  "replicas": 0
}
```

### Resume Sandbox

Sets replicas to 1, restarting the pod.

```bash
POST /api/sandboxes/:name/resume
Authorization: Bearer <user-api-key>
```

Response:
```json
{
  "success": true,
  "message": "Sandbox 'my-sandbox' resumed successfully",
  "replicas": 1
}
```

## Proxy API

Base path: `/proxy/*`
Authentication: User API key required
Authorization: User must own the sandbox

### Proxy to Sandbox

Forward any request to a sandbox. The proxy validates ownership before forwarding.

```bash
{METHOD} /proxy/:sandboxname/{endpoint}
Authorization: Bearer <user-api-key>
Content-Type: application/json

{request body}
```

**Example**: Execute command in sandbox

```bash
POST /proxy/my-sandbox/v1/shell/exec
Authorization: Bearer <user-api-key>
Content-Type: application/json

{
  "command": "ls -la /sandbox"
}
```

The request is forwarded to:
```
http://my-sandbox.user-alice.svc.cluster.local:8080/v1/shell/exec
```

## Error Handling

### HTTP Status Codes

- `200 OK` - Success
- `201 Created` - Resource created
- `400 Bad Request` - Invalid request (missing fields, validation errors)
- `401 Unauthorized` - Missing or invalid API key
- `403 Forbidden` - Valid API key but no permission (e.g., accessing another user's sandbox)
- `404 Not Found` - Resource not found
- `409 Conflict` - Resource already exists (e.g., duplicate username or sandbox name)
- `500 Internal Server Error` - Server error
- `503 Service Unavailable` - Sandbox not ready

### Error Response Format

```json
{
  "error": "Error Type",
  "message": "Detailed error message"
}
```

### Common Errors

#### Invalid API Key

```json
{
  "error": "Unauthorized",
  "message": "Invalid API key"
}
```

#### Accessing Another User's Sandbox

```json
{
  "error": "Forbidden",
  "message": "You do not have access to this sandbox"
}
```

#### Duplicate Sandbox Name

```json
{
  "error": "Conflict",
  "message": "Sandbox 'my-sandbox' already exists"
}
```

#### Sandbox Not Ready

```json
{
  "error": "Service Unavailable",
  "message": "Sandbox not ready"
}
```

## Example Workflows

### Complete User Onboarding

```bash
# 1. Admin creates user
curl -X POST http://$PROXY_IP/api/admin/users \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","email":"alice@example.com"}'

# Save user ID from response
USER_ID="uuid-from-response"

# 2. Admin generates API key for user
curl -X POST http://$PROXY_IP/api/admin/users/$USER_ID/apikeys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice primary key"}'

# Save API key from response
USER_API_KEY="sk_live_from_response"

# 3. User creates sandbox
curl -X POST http://$PROXY_IP/api/sandboxes \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-sandbox"}'

# 4. User uses sandbox
curl -X POST http://$PROXY_IP/proxy/my-sandbox/v1/shell/exec \
  -H "Authorization: Bearer $USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"command":"echo Hello from sandbox"}'
```

### API Key Rotation

```bash
# 1. User creates new API key
curl -X POST http://$PROXY_IP/api/me/apikeys \
  -H "Authorization: Bearer $OLD_USER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Rotated key"}'

# Save new API key
NEW_USER_API_KEY="sk_live_from_response"

# 2. Update applications to use new key
# ... update configs ...

# 3. Revoke old API key
curl -X DELETE http://$PROXY_IP/api/me/apikeys/$OLD_KEY_ID \
  -H "Authorization: Bearer $NEW_USER_API_KEY"
```

## Rate Limiting

Currently not implemented. Consider adding rate limiting in production:
- Per API key
- Per endpoint
- Using tools like nginx-ingress rate limiting or API gateway

## Best Practices

1. **API Key Security**
   - Never commit API keys to version control
   - Use environment variables or secrets managers
   - Rotate keys regularly
   - Set expiration dates when possible

2. **Sandbox Naming**
   - Use descriptive, DNS-compliant names
   - Keep names unique per user
   - Lowercase alphanumeric with hyphens only

3. **Resource Management**
   - Monitor resource quota usage
   - Pause unused sandboxes
   - Delete sandboxes when no longer needed

4. **Error Handling**
   - Always check HTTP status codes
   - Parse error messages for details
   - Implement retry logic with exponential backoff
