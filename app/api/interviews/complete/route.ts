import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireApiAccess } from "@/lib/api-access";
import { completeInterviewLog } from "@/lib/interview-log";

export const runtime = "nodejs";

interface CompletionBody {
  id: string;
  openaiSessionId: string;
  actualSeconds: number | null;
}

function validateBody(value: unknown): CompletionBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;

  if (
    typeof body.id !== "string" ||
    !body.id.trim() ||
    body.id.length > 100 ||
    typeof body.openaiSessionId !== "string" ||
    !body.openaiSessionId.trim() ||
    body.openaiSessionId.length > 255 ||
    (body.actualSeconds !== null &&
      (typeof body.actualSeconds !== "number" ||
        !Number.isFinite(body.actualSeconds) ||
        body.actualSeconds < 0 ||
        body.actualSeconds > 7_200))
  ) {
    return null;
  }

  return {
    id: body.id,
    openaiSessionId: body.openaiSessionId,
    actualSeconds:
      body.actualSeconds === null
        ? null
        : Math.round(body.actualSeconds * 1_000) / 1_000,
  };
}

export async function POST(request: NextRequest) {
  const accessError = requireApiAccess(request);
  if (accessError) return accessError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const completion = validateBody(body);
  if (!completion) {
    return NextResponse.json(
      { error: "A valid interview completion is required." },
      { status: 400 },
    );
  }

  try {
    completeInterviewLog(completion);
    return NextResponse.json({ ok: true });
  } catch {
    console.error("Interview session log completion failed");
    return NextResponse.json(
      { error: "The interview session log could not be completed." },
      { status: 500 },
    );
  }
}
