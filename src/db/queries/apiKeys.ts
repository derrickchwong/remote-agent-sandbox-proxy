import { pool } from '../pool.js';
import { generateApiKey, hashApiKey, getApiKeyPrefix } from '../../utils/crypto.js';

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string | null;
  created_at: Date;
  expires_at: Date | null;
  last_used_at: Date | null;
  is_active: boolean;
}

export interface ApiKeyWithPlaintext extends ApiKey {
  plaintext_key: string; // Only available on creation
}

/**
 * Create a new API key for a user
 */
export async function createApiKey(
  userId: string,
  name?: string,
  expiresAt?: Date
): Promise<ApiKeyWithPlaintext> {
  const plaintextKey = generateApiKey('sk_live');
  const keyHash = hashApiKey(plaintextKey);
  const keyPrefix = getApiKeyPrefix(plaintextKey);

  const result = await pool.query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, expires_at, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [userId, keyHash, keyPrefix, name || null, expiresAt || null]
  );

  return {
    ...result.rows[0],
    plaintext_key: plaintextKey,
  };
}

/**
 * Validate an API key and return user info
 */
export async function validateApiKey(
  keyHash: string
): Promise<{ valid: boolean; user?: any; reason?: string }> {
  const result = await pool.query(
    `SELECT ak.*, u.id as user_id, u.username, u.email, u.is_active as user_is_active
     FROM api_keys ak
     JOIN users u ON ak.user_id = u.id
     WHERE ak.key_hash = $1`,
    [keyHash]
  );

  if (result.rows.length === 0) {
    return { valid: false, reason: 'Invalid API key' };
  }

  const key = result.rows[0];

  // Check if key is active
  if (!key.is_active) {
    return { valid: false, reason: 'API key is inactive' };
  }

  // Check if user is active
  if (!key.user_is_active) {
    return { valid: false, reason: 'User account is inactive' };
  }

  // Check if key is expired
  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    return { valid: false, reason: 'API key has expired' };
  }

  // Update last_used_at timestamp (async, don't wait)
  pool.query(
    'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
    [key.id]
  ).catch((err) => {
    console.error('Failed to update last_used_at:', err);
  });

  return {
    valid: true,
    user: {
      id: key.user_id,
      username: key.username,
      email: key.email,
    },
  };
}

/**
 * List API keys for a user
 */
export async function listApiKeysByUser(userId: string): Promise<ApiKey[]> {
  const result = await pool.query(
    `SELECT * FROM api_keys
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Get API key by ID
 */
export async function getApiKeyById(keyId: string): Promise<ApiKey | null> {
  const result = await pool.query(
    'SELECT * FROM api_keys WHERE id = $1',
    [keyId]
  );
  return result.rows[0] || null;
}

/**
 * Revoke (deactivate) an API key
 */
export async function revokeApiKey(keyId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE api_keys SET is_active = false WHERE id = $1',
    [keyId]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Delete an API key
 */
export async function deleteApiKey(keyId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM api_keys WHERE id = $1',
    [keyId]
  );
  return (result.rowCount || 0) > 0;
}
