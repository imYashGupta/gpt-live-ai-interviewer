import "server-only";

export function getClientIp(headers: Headers) {
  const directIpHeaders = [
    "cf-connecting-ip",
    "x-vercel-forwarded-for",
    "x-real-ip",
  ];

  for (const header of directIpHeaders) {
    const value = headers.get(header)?.trim();
    if (value) return firstForwardedValue(value);
  }

  const forwardedFor = headers.get("x-forwarded-for");
  return forwardedFor ? firstForwardedValue(forwardedFor) : "unknown";
}

function firstForwardedValue(value: string) {
  return value.split(",", 1)[0].trim().slice(0, 128) || "unknown";
}
