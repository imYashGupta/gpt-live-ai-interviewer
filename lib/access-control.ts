import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ACCESS_COOKIE_NAME = "interview_access";
export const ACCESS_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const ACCESS_COOKIE_CONTEXT = "gpt-live-ai-interviewer-access-v1";

export function getConfiguredPasscode() {
  return process.env.APP_PASSCODE?.trim() || null;
}

export function isValidPasscode(candidate: string, configuredPasscode: string) {
  const candidateDigest = createHash("sha256").update(candidate.trim()).digest();
  const configuredDigest = createHash("sha256")
    .update(configuredPasscode)
    .digest();

  return timingSafeEqual(candidateDigest, configuredDigest);
}

export function createAccessCookieValue(configuredPasscode: string) {
  return createHmac("sha256", configuredPasscode)
    .update(ACCESS_COOKIE_CONTEXT)
    .digest("hex");
}

export function isValidAccessCookie(
  cookieValue: string | undefined,
  configuredPasscode: string,
) {
  if (!cookieValue) return false;

  const expectedValue = createAccessCookieValue(configuredPasscode);
  const candidateBuffer = Buffer.from(cookieValue);
  const expectedBuffer = Buffer.from(expectedValue);

  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

export function sanitizeReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return "/";
  }

  return value.slice(0, 2_000);
}
