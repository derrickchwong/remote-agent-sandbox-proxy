import { pool } from '../pool.js';

export interface User {
  id: string;
  username: string;
  email: string | null;
  created_at: Date;
  updated_at: Date;
  is_active: boolean;
}

/**
 * Create a new user
 */
export async function createUser(
  username: string,
  email?: string
): Promise<User> {
  const result = await pool.query(
    `INSERT INTO users (username, email, is_active)
     VALUES ($1, $2, true)
     RETURNING *`,
    [username, email || null]
  );
  return result.rows[0];
}

/**
 * Get user by ID
 */
export async function getUserById(userId: string): Promise<User | null> {
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Get user by username
 */
export async function getUserByUsername(username: string): Promise<User | null> {
  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0] || null;
}

/**
 * List all users
 */
export async function listUsers(
  activeOnly: boolean = false
): Promise<User[]> {
  let query = 'SELECT * FROM users';
  const params: any[] = [];

  if (activeOnly) {
    query += ' WHERE is_active = true';
  }

  query += ' ORDER BY created_at DESC';

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Update user
 */
export async function updateUser(
  userId: string,
  updates: { email?: string; is_active?: boolean }
): Promise<User | null> {
  const setClauses: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.email !== undefined) {
    setClauses.push(`email = $${paramIndex++}`);
    values.push(updates.email);
  }

  if (updates.is_active !== undefined) {
    setClauses.push(`is_active = $${paramIndex++}`);
    values.push(updates.is_active);
  }

  setClauses.push(`updated_at = CURRENT_TIMESTAMP`);

  if (setClauses.length === 1) {
    // Only updated_at, nothing to update
    return getUserById(userId);
  }

  values.push(userId);

  const result = await pool.query(
    `UPDATE users
     SET ${setClauses.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    values
  );

  return result.rows[0] || null;
}

/**
 * Delete user (cascade deletes API keys and sandboxes)
 */
export async function deleteUser(userId: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM users WHERE id = $1',
    [userId]
  );
  return (result.rowCount || 0) > 0;
}
