import crypto from 'crypto';

/**
 * Generate a secure API key
 * Format: sk_live_<32_random_chars>
 */
export function generateApiKey(prefix: string = 'sk_live'): string {
  const randomBytes = crypto.randomBytes(24); // 24 bytes = 32 chars in base64url
  const randomPart = randomBytes.toString('base64url').substring(0, 32);
  return `${prefix}_${randomPart}`;
}

/**
 * Hash an API key using SHA-256
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * Get the prefix from an API key (first 12 characters for display)
 */
export function getApiKeyPrefix(apiKey: string): string {
  return apiKey.substring(0, 12);
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);

  return crypto.timingSafeEqual(bufferA, bufferB);
}
