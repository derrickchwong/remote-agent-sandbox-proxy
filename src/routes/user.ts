import express, { Response } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import {
  createApiKey,
  listApiKeysByUser,
  getApiKeyById,
  revokeApiKey,
} from '../db/queries/apiKeys.js';
import { createAuditLog } from '../db/queries/auditLogs.js';

const router = express.Router();

// All user routes require authentication
router.use(authenticate);

/**
 * GET /api/me
 * Get current user information
 */
router.get('/me', async (req: AuthenticatedRequest, res: Response) => {
  try {
    res.json({
      user: {
        id: req.user!.id,
        username: req.user!.username,
        email: req.user!.email,
      },
    });
  } catch (error: any) {
    console.error('Error getting user info:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * POST /api/me/apikeys
 * Generate API key for current user
 */
router.post('/me/apikeys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, expires_at } = req.body;

    const expiresAt = expires_at ? new Date(expires_at) : undefined;
    const apiKey = await createApiKey(userId, name, expiresAt);

    await createAuditLog(userId, 'create_api_key', 'success', {
      resourceType: 'api_key',
      resourceId: apiKey.id,
      details: { name, expires_at },
    });

    res.status(201).json({
      success: true,
      message: 'API key created successfully. Save this key - it will not be shown again.',
      api_key: apiKey.plaintext_key,
      key_info: {
        id: apiKey.id,
        key_prefix: apiKey.key_prefix,
        name: apiKey.name,
        created_at: apiKey.created_at,
        expires_at: apiKey.expires_at,
      },
    });
  } catch (error: any) {
    console.error('Error creating API key:', error);

    await createAuditLog(req.user!.id, 'create_api_key', 'failed', {
      resourceType: 'api_key',
      details: { error: error.message },
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/me/apikeys
 * List current user's API keys
 */
router.get('/me/apikeys', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const apiKeys = await listApiKeysByUser(userId);

    res.json({
      count: apiKeys.length,
      api_keys: apiKeys.map((k) => ({
        id: k.id,
        key_prefix: k.key_prefix,
        name: k.name,
        created_at: k.created_at,
        expires_at: k.expires_at,
        last_used_at: k.last_used_at,
        is_active: k.is_active,
      })),
    });
  } catch (error: any) {
    console.error('Error listing API keys:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/me/apikeys/:keyId
 * Revoke current user's API key
 */
router.delete('/me/apikeys/:keyId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { keyId } = req.params;

    // Verify the key belongs to the user
    const apiKey = await getApiKeyById(keyId);
    if (!apiKey) {
      res.status(404).json({
        error: 'Not Found',
        message: 'API key not found',
      });
      return;
    }

    if (apiKey.user_id !== userId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'You do not own this API key',
      });
      return;
    }

    const revoked = await revokeApiKey(keyId);

    if (!revoked) {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to revoke API key',
      });
      return;
    }

    await createAuditLog(userId, 'revoke_api_key', 'success', {
      resourceType: 'api_key',
      resourceId: keyId,
    });

    res.json({
      success: true,
      message: 'API key revoked successfully',
    });
  } catch (error: any) {
    console.error('Error revoking API key:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

export default router;
