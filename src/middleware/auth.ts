import { Request, Response, NextFunction } from 'express';
import { hashApiKey } from '../utils/crypto.js';
import { validateApiKey } from '../db/queries/apiKeys.js';

// Extend Express Request to include user
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    username: string;
    email: string;
  };
}

/**
 * Authentication middleware - validates API key from Authorization header
 */
export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract API key from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing Authorization header',
      });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid Authorization header format. Expected: Bearer <api-key>',
      });
      return;
    }

    const apiKey = authHeader.substring(7); // Remove 'Bearer '

    if (!apiKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Empty API key',
      });
      return;
    }

    // Hash the API key
    const keyHash = hashApiKey(apiKey);

    // Validate against database
    const result = await validateApiKey(keyHash);

    if (!result.valid) {
      res.status(401).json({
        error: 'Unauthorized',
        message: result.reason || 'Invalid API key',
      });
      return;
    }

    // Attach user to request
    req.user = result.user!;

    // Continue to next middleware
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to authenticate request',
    });
  }
}

/**
 * Admin authentication middleware - validates admin API key
 */
export function authenticateAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing Authorization header',
      });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid Authorization header format. Expected: Bearer <api-key>',
      });
      return;
    }

    const apiKey = authHeader.substring(7);
    const adminApiKey = process.env.ADMIN_API_KEY;

    if (!adminApiKey) {
      console.error('ADMIN_API_KEY environment variable not set');
      res.status(500).json({
        error: 'Internal server error',
        message: 'Admin authentication not configured',
      });
      return;
    }

    if (apiKey !== adminApiKey) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid admin API key',
      });
      return;
    }

    // Admin authenticated
    next();
  } catch (error) {
    console.error('Admin authentication error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to authenticate admin request',
    });
  }
}

/**
 * Optional authentication - doesn't fail if no auth header, but validates if present
 */
export async function optionalAuthenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    // No auth provided, continue without user
    next();
    return;
  }

  // Auth provided, validate it
  await authenticate(req, res, next);
}
