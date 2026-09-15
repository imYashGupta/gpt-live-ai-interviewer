import "server-only";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  ACCESS_COOKIE_NAME,
  getConfiguredPasscode,
  isValidAccessCookie,
} from "@/lib/access-control";

export function requireApiAccess(request: NextRequest) {
  const configuredPasscode = getConfiguredPasscode();
  if (!configuredPasscode) {
    return NextResponse.json(
      { error: "APP_PASSCODE is not configured on the server." },
      { status: 503 },
    );
  }

  const cookieValue = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
  if (!isValidAccessCookie(cookieValue, configuredPasscode)) {
    return NextResponse.json(
      { error: "Passcode access is required." },
      { status: 401 },
    );
  }

  return null;
}
