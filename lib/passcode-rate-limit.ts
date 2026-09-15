import "server-only";

import { getDatabase } from "@/lib/database";

export const PASSCODE_MAX_FAILED_ATTEMPTS = 5;
export const PASSCODE_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000;

interface RateLimitRow {
  failed_attempts: number;
  window_started_at: number;
}

export function getPasscodeRateLimit(
  ipAddress: string,
  now = Date.now(),
) {
  const database = getDatabase();
  const cutoff = now - PASSCODE_RATE_LIMIT_WINDOW_MS;

  database
    .prepare("DELETE FROM passcode_rate_limits WHERE window_started_at <= ?")
    .run(cutoff);

  const row = database
    .prepare(
      `SELECT failed_attempts, window_started_at
       FROM passcode_rate_limits
       WHERE ip_address = ?`,
    )
    .get(ipAddress) as RateLimitRow | undefined;

  if (!row || row.failed_attempts < PASSCODE_MAX_FAILED_ATTEMPTS) {
    return { blocked: false, retryAfterSeconds: 0 };
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(
      (row.window_started_at + PASSCODE_RATE_LIMIT_WINDOW_MS - now) / 1_000,
    ),
  );

  return { blocked: true, retryAfterSeconds };
}

export function recordFailedPasscodeAttempt(
  ipAddress: string,
  now = Date.now(),
) {
  const cutoff = now - PASSCODE_RATE_LIMIT_WINDOW_MS;

  getDatabase()
    .prepare(
      `INSERT INTO passcode_rate_limits (
         ip_address,
         failed_attempts,
         window_started_at
       ) VALUES (?, 1, ?)
       ON CONFLICT(ip_address) DO UPDATE SET
         failed_attempts = CASE
           WHEN window_started_at <= ? THEN 1
           ELSE failed_attempts + 1
         END,
         window_started_at = CASE
           WHEN window_started_at <= ? THEN excluded.window_started_at
           ELSE window_started_at
         END`,
    )
    .run(ipAddress, now, cutoff, cutoff);
}

export function clearFailedPasscodeAttempts(ipAddress: string) {
  getDatabase()
    .prepare("DELETE FROM passcode_rate_limits WHERE ip_address = ?")
    .run(ipAddress);
}
