import express, { Request, Response } from 'express';
import { authenticateAdmin } from '../middleware/auth.js';
import {
  createUser,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  getUserByUsername,
} from '../db/queries/users.js';
import {
  createApiKey,
  listApiKeysByUser,
  getApiKeyById,
  revokeApiKey,
  deleteApiKey,
} from '../db/queries/apiKeys.js';
import { createAuditLog } from '../db/queries/auditLogs.js';

const router = express.Router();

// All admin routes require admin authentication
router.use(authenticateAdmin);

// ========== User Management ==========

/**
 * POST /api/admin/users
 * Create a new user
 */
router.post('/users', async (req: Request, res: Response) => {
  try {
    const { username, email } = req.body;

    if (!username) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'username is required',
      });
      return;
    }

    // Check if username already exists
    const existing = await getUserByUsername(username);
    if (existing) {
      res.status(409).json({
        error: 'Conflict',
        message: `User with username '${username}' already exists`,
      });
      return;
    }

    const user = await createUser(username, email);

    await createAuditLog(null, 'admin_create_user', 'success', {
      resourceType: 'user',
      resourceId: user.id,
      details: { username, email },
    });

    res.status(201).json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at,
        is_active: user.is_active,
      },
    });
  } catch (error: any) {
    console.error('Error creating user:', error);

    await createAuditLog(null, 'admin_create_user', 'failed', {
      resourceType: 'user',
      details: { error: error.message },
    });

    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/users
 * List all users
 */
router.get('/users', async (req: Request, res: Response) => {
  try {
    const activeOnly = req.query.active_only === 'true';
    const users = await listUsers(activeOnly);

    res.json({
      count: users.length,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        created_at: u.created_at,
        is_active: u.is_active,
      })),
    });
  } catch (error: any) {
    console.error('Error listing users:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/users/:userId
 * Get user details
 */
router.get('/users/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const user = await getUserById(userId);

    if (!user) {
      res.status(404).json({
        error: 'Not Found',
        message: 'User not found',
      });
      return;
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        created_at: user.created_at,
        updated_at: user.updated_at,
        is_active: user.is_active,
      },
    });
  } catch (error: any) {
    console.error('Error getting user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * PUT /api/admin/users/:userId
 * Update user
 */
router.put('/users/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { email, is_active } = req.body;

    const user = await updateUser(userId, { email, is_active });

    if (!user) {
      res.status(404).json({
        error: 'Not Found',
        message: 'User not found',
      });
      return;
    }

    await createAuditLog(userId, 'admin_update_user', 'success', {
      resourceType: 'user',
      resourceId: userId,
      details: { email, is_active },
    });

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        updated_at: user.updated_at,
        is_active: user.is_active,
      },
    });
  } catch (error: any) {
    console.error('Error updating user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/admin/users/:userId
 * Delete user (cascade deletes API keys and sandboxes)
 */
router.delete('/users/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({
        error: 'Not Found',
        message: 'User not found',
      });
      return;
    }

    const deleted = await deleteUser(userId);

    if (!deleted) {
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to delete user',
      });
      return;
    }

    await createAuditLog(userId, 'admin_delete_user', 'success', {
      resourceType: 'user',
      resourceId: userId,
      details: { username: user.username },
    });

    res.json({
      success: true,
      message: `User '${user.username}' deleted successfully`,
    });
  } catch (error: any) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// ========== API Key Management ==========

/**
 * POST /api/admin/users/:userId/apikeys
 * Generate API key for a user
 */
router.post('/users/:userId/apikeys', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { name, expires_at } = req.body;

    // Verify user exists
    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({
        error: 'Not Found',
        message: 'User not found',
      });
      return;
    }

    const expiresAt = expires_at ? new Date(expires_at) : undefined;
    const apiKey = await createApiKey(userId, name, expiresAt);

    await createAuditLog(userId, 'admin_create_api_key', 'success', {
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
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

/**
 * GET /api/admin/users/:userId/apikeys
 * List API keys for a user
 */
router.get('/users/:userId/apikeys', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    // Verify user exists
    const user = await getUserById(userId);
    if (!user) {
      res.status(404).json({
        error: 'Not Found',
        message: 'User not found',
      });
      return;
    }

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
 * DELETE /api/admin/apikeys/:keyId
 * Revoke API key
 */
router.delete('/apikeys/:keyId', async (req: Request, res: Response) => {
  try {
    const { keyId } = req.params;

    const apiKey = await getApiKeyById(keyId);
    if (!apiKey) {
      res.status(404).json({
        error: 'Not Found',
        message: 'API key not found',
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

    await createAuditLog(apiKey.user_id, 'admin_revoke_api_key', 'success', {
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
