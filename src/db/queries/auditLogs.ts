import { pool } from '../pool.js';

export interface AuditLog {
  id: string;
  user_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  status: string;
  details: any;
  created_at: Date;
}

/**
 * Create an audit log entry
 */
export async function createAuditLog(
  userId: string | null,
  action: string,
  status: 'success' | 'failed' | 'denied',
  options?: {
    resourceType?: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    details?: any;
  }
): Promise<AuditLog> {
  const result = await pool.query(
    `INSERT INTO audit_logs (
       user_id, action, resource_type, resource_id,
       ip_address, user_agent, status, details
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      userId,
      action,
      options?.resourceType || null,
      options?.resourceId || null,
      options?.ipAddress || null,
      options?.userAgent || null,
      status,
      options?.details || null,
    ]
  );
  return result.rows[0];
}

/**
 * Get audit logs for a user
 */
export async function getAuditLogsByUser(
  userId: string,
  limit: number = 100
): Promise<AuditLog[]> {
  const result = await pool.query(
    `SELECT * FROM audit_logs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

/**
 * Get all audit logs (admin)
 */
export async function getAllAuditLogs(limit: number = 100): Promise<AuditLog[]> {
  const result = await pool.query(
    `SELECT * FROM audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}
