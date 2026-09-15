import { NextResponse } from "next/server";

import {
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  ACCESS_COOKIE_NAME,
  createAccessCookieValue,
  getConfiguredPasscode,
  isValidPasscode,
  sanitizeReturnPath,
} from "@/lib/access-control";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const configuredPasscode = getConfiguredPasscode();
  if (!configuredPasscode) {
    return NextResponse.json(
      { error: "APP_PASSCODE is not configured on the server." },
      { status: 503 },
    );
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
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
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
