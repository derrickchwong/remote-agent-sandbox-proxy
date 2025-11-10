import { pool } from '../pool.js';

export interface Sandbox {
  id: string;
  user_id: string;
  name: string;
  namespace: string;
  k8s_resource_name: string;
  image: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Create a new sandbox record
 */
export async function createSandbox(
  userId: string,
  name: string,
  namespace: string,
  k8sResourceName: string,
  image?: string
): Promise<Sandbox> {
  const result = await pool.query(
    `INSERT INTO sandboxes (user_id, name, namespace, k8s_resource_name, image)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, name, namespace, k8sResourceName, image || null]
  );
  return result.rows[0];
}

/**
 * Get sandbox by ID
 */
export async function getSandboxById(sandboxId: string): Promise<Sandbox | null> {
  const result = await pool.query(
    'SELECT * FROM sandboxes WHERE id = $1',
    [sandboxId]
  );
  return result.rows[0] || null;
}

/**
 * Get sandbox by user ID and name
 */
export async function getSandboxByUserAndName(
  userId: string,
  name: string
): Promise<Sandbox | null> {
  const result = await pool.query(
    'SELECT * FROM sandboxes WHERE user_id = $1 AND name = $2',
    [userId, name]
  );
  return result.rows[0] || null;
}

/**
 * Get sandbox by namespace and K8s resource name
 */
export async function getSandboxByK8sResource(
  namespace: string,
  k8sResourceName: string
): Promise<Sandbox | null> {
  const result = await pool.query(
    'SELECT * FROM sandboxes WHERE namespace = $1 AND k8s_resource_name = $2',
    [namespace, k8sResourceName]
  );
  return result.rows[0] || null;
}

/**
 * List all sandboxes for a user
 */
export async function listSandboxesByUser(userId: string): Promise<Sandbox[]> {
  const result = await pool.query(
    `SELECT * FROM sandboxes
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * List all sandboxes (admin only)
 */
export async function listAllSandboxes(): Promise<Sandbox[]> {
  const result = await pool.query(
    'SELECT * FROM sandboxes ORDER BY created_at DESC'
  );
  return result.rows;
}

/**
 * Check if user owns a sandbox
 */
export async function userOwnsSandbox(
  userId: string,
  sandboxName: string
): Promise<boolean> {
  const result = await pool.query(
    'SELECT id FROM sandboxes WHERE user_id = $1 AND name = $2',
    [userId, sandboxName]
  );
  return result.rows.length > 0;
}

/**
 * Update sandbox
 */
export async function updateSandbox(
  sandboxId: string,
  updates: { image?: string }
): Promise<Sandbox | null> {
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.image !== undefined) {
    setClauses.push(`image = $${paramIndex++}`);
    values.push(updates.image);
  }

  setClauses.push(`updated_at = CURRENT_TIMESTAMP`);

  if (setClauses.length === 1) {
    // Only updated_at, nothing to update
    return getSandboxById(sandboxId);
  }

  values.push(sandboxId);

  const result = await pool.query(
    `UPDATE sandboxes
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

/**
 * Delete sandbox
 */
export async function deleteSandbox(sandboxId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM sandboxes WHERE id = $1',
    [sandboxId]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Delete sandbox by user and name
 */
export async function deleteSandboxByUserAndName(
  userId: string,
  name: string
): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM sandboxes WHERE user_id = $1 AND name = $2',
    [userId, name]
  );
  return (result.rowCount || 0) > 0;
}
