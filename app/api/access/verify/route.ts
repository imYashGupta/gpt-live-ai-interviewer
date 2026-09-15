import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  ACCESS_COOKIE_NAME,
  createAccessCookieValue,
  getConfiguredPasscode,
  isValidPasscode,
  sanitizeReturnPath,
} from "@/lib/access-control";
import { getClientIp } from "@/lib/client-ip";
import {
  clearFailedPasscodeAttempts,
  getPasscodeRateLimit,
  recordFailedPasscodeAttempt,
} from "@/lib/passcode-rate-limit";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const configuredPasscode = getConfiguredPasscode();
  if (!configuredPasscode) {
    return NextResponse.json(
      { error: "APP_PASSCODE is not configured on the server." },
      { status: 503 },
    );
  }

  const ipAddress = getClientIp(request.headers);
  let rateLimit: ReturnType<typeof getPasscodeRateLimit>;
  try {
    rateLimit = getPasscodeRateLimit(ipAddress);
  } catch {
    console.error("Passcode rate-limit lookup failed");
    return NextResponse.json(
      { error: "Access verification is temporarily unavailable." },
      { status: 503 },
    );
  }

  if (rateLimit.blocked) {
    return rateLimitedResponse(rateLimit.retryAfterSeconds);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const values =
    body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const candidate = values?.passcode;
  if (
    typeof candidate !== "string" ||
    !candidate.trim() ||
    candidate.length > 256 ||
    !isValidPasscode(candidate, configuredPasscode)
  ) {
    if (typeof candidate === "string" && candidate.length <= 256) {
      try {
        recordFailedPasscodeAttempt(ipAddress);
      } catch {
        console.error("Passcode rate-limit update failed");
        return NextResponse.json(
          { error: "Access verification is temporarily unavailable." },
          { status: 503 },
        );
      }
    }
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
  }

  try {
    clearFailedPasscodeAttempts(ipAddress);
  } catch {
    console.error("Passcode rate-limit reset failed");
    return NextResponse.json(
      { error: "Access verification is temporarily unavailable." },
      { status: 503 },
    );
  }

  const redirectTo = sanitizeReturnPath(values?.next);
  const response = NextResponse.json({ ok: true, redirectTo });
  response.cookies.set({
    name: ACCESS_COOKIE_NAME,
    value: createAccessCookieValue(configuredPasscode),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
    path: "/",
  });

  return response;
}

function rateLimitedResponse(retryAfterSeconds: number) {
  return NextResponse.json(
    {
      error: "Too many passcode attempts. Try again later.",
      retryAfterSeconds,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}
