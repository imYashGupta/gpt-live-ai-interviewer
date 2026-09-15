import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  ACCESS_COOKIE_NAME,
  getConfiguredPasscode,
  isValidAccessCookie,
} from "@/lib/access-control";

const ACCESS_PAGE_PATH = "/access";
const VERIFY_ACCESS_PATH = "/api/access/verify";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (
    pathname === ACCESS_PAGE_PATH ||
    pathname.startsWith(`${ACCESS_PAGE_PATH}/`) ||
    pathname === VERIFY_ACCESS_PATH
  ) {
    return NextResponse.next();
  }

  const configuredPasscode = getConfiguredPasscode();
  const cookieValue = request.cookies.get(ACCESS_COOKIE_NAME)?.value;

  if (
    configuredPasscode &&
    isValidAccessCookie(cookieValue, configuredPasscode)
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: configuredPasscode
          ? "Passcode access is required."
          : "APP_PASSCODE is not configured on the server.",
      },
      { status: configuredPasscode ? 401 : 503 },
    );
  }

  const accessUrl = new URL(ACCESS_PAGE_PATH, request.url);
  accessUrl.searchParams.set(
    "next",
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  return NextResponse.redirect(accessUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
