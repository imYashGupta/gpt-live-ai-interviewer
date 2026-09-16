import { createHmac } from "node:crypto";

/** Sign the exact serialized bytes persisted for delivery; retries keep the event ID. */
export function signWebhook(body: string, eventId: string, timestamp: number, secret: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(eventId)
    || !Number.isSafeInteger(timestamp) || timestamp < 1 || timestamp > 99_999_999_999
    || secret.length < 32) throw new Error("Invalid webhook signing parameters");
  const signature = createHmac("sha256", secret).update(`${timestamp}.${eventId}.${body}`).digest("hex");
  return {
    "Interview-Event-Id": eventId,
    "Interview-Timestamp": String(timestamp),
    "Interview-Signature": `v1=${signature}`,
  };
}
