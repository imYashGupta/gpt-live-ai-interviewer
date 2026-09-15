import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { requireApiAccess } from "@/lib/api-access";
import { createInterviewLog } from "@/lib/interview-log";
import { buildInterviewPrompt } from "@/lib/interview-prompt";
import { questionCountForDuration, validateInterviewPlan } from "@/lib/question-plan";
import { LIVE_VOICES } from "@/lib/types";
import type {
  Difficulty,
  InterviewConfig,
  InterviewMode,
  InterviewPlan,
  LiveVoice,
} from "@/lib/types";

export const runtime = "nodejs";

const difficulties = new Set<Difficulty>(["junior", "mid", "senior"]);
const voices = new Set<LiveVoice>(LIVE_VOICES);

function validateBody(value: unknown):
  | {
      ok: true;
      sdp: string;
      interview: InterviewConfig;
      plan: InterviewPlan | null;
    }
  | { ok: false; message: string } {
  if (!value || typeof value !== "object") {
    return { ok: false, message: "A JSON request body is required." };
  }

  const body = value as Record<string, unknown>;
  const interview = body.interview as Record<string, unknown> | undefined;

  if (typeof body.sdp !== "string" || !body.sdp.trim()) {
    return { ok: false, message: "A valid SDP offer is required." };
  }
  if (body.sdp.length > 64_000) {
    return { ok: false, message: "The SDP offer is too large." };
  }
  if (!interview || typeof interview !== "object") {
    return { ok: false, message: "Interview configuration is required." };
  }

  if (interview.mode !== "ai-led" && interview.mode !== "planned") {
    return { ok: false, message: "A valid interview mode is required." };
  }
  if (
    typeof interview.candidateName !== "string" ||
    !interview.candidateName.trim() ||
    typeof interview.role !== "string" ||
    !interview.role.trim() ||
    typeof interview.jobDescription !== "string" ||
    !interview.jobDescription.trim()
  ) {
    return { ok: false, message: "Candidate name, role, and job description are required." };
  }
  if (
    interview.candidateName.length > 120 ||
    interview.role.length > 180 ||
    interview.jobDescription.length > 6_000
  ) {
    return { ok: false, message: "Interview context exceeds the allowed length." };
  }

  if (
    typeof interview.durationMinutes !== "number" ||
    !Number.isInteger(interview.durationMinutes) ||
    interview.durationMinutes < 1 ||
    interview.durationMinutes > 60
  ) {
    return { ok: false, message: "Duration must be between 1 and 60 minutes." };
  }
  if (
    typeof interview.difficulty !== "string" ||
    !difficulties.has(interview.difficulty as Difficulty)
  ) {
    return { ok: false, message: "A valid difficulty is required." };
  }
  if (
    typeof interview.voice !== "string" ||
    !voices.has(interview.voice as LiveVoice)
  ) {
    return { ok: false, message: "A valid interviewer voice is required." };
  }
  if (typeof interview.followUpsEnabled !== "boolean") {
    return { ok: false, message: "A follow-up preference is required." };
  }
  if (
    interview.candidateNotes !== undefined &&
    (typeof interview.candidateNotes !== "string" ||
      interview.candidateNotes.length > 3_000)
  ) {
    return { ok: false, message: "Candidate notes must be text." };
  }

  let plan: InterviewPlan | null = null;
  if (interview.mode === "planned") {
    plan = validateInterviewPlan(body.plan);
    if (
      !plan ||
      plan.questions.length !== questionCountForDuration(interview.durationMinutes)
    ) {
      return { ok: false, message: "A valid reviewed interview plan is required." };
    }
    if (
      interview.followUpsEnabled === false &&
      plan.questions.some((question) => question.followUps.length > 0)
    ) {
      return { ok: false, message: "Follow-ups are disabled for this interview." };
    }
  }

  return {
    ok: true,
    sdp: body.sdp,
    interview: {
      mode: interview.mode as InterviewMode,
      candidateName: interview.candidateName as string,
      role: interview.role as string,
      jobDescription: interview.jobDescription as string,
      durationMinutes: interview.durationMinutes,
      difficulty: interview.difficulty as Difficulty,
      voice: interview.voice as LiveVoice,
      followUpsEnabled: interview.followUpsEnabled,
      candidateNotes: (interview.candidateNotes as string | undefined) ?? "",
    },
    plan,
  };
}

export async function POST(request: NextRequest) {
  const accessError = requireApiAccess(request);
  if (accessError) return accessError;

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured on the server." },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const parsed = validateBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.message }, { status: 400 });
  }

  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
    });
    const result = await openai.live.create({
      session: {
        model: "gpt-live-1",
        instructions: buildInterviewPrompt(parsed.interview, parsed.plan),
        audio: { output: { voice: parsed.interview.voice } },
        store: false,
      },
      transport: {
        type: "webrtc",
        sdp: parsed.sdp,
      },
    });
    const interviewLogId = createInterviewLog({
      headers: request.headers,
      openaiSessionId: result.session.id,
      interview: parsed.interview,
      plan: parsed.plan,
    });

    return NextResponse.json(
      {
        interview: { id: interviewLogId },
        session: { id: result.session.id },
        transport: { type: result.transport.type, sdp: result.transport.sdp },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      console.error("Live session creation failed", {
        status: error.status,
        requestId: error.requestID,
      });
      return NextResponse.json(
        { error: "OpenAI could not create the Live session." },
        { status: error.status ?? 502 },
      );
    }

    console.error("Unexpected Live session creation failure");
    return NextResponse.json(
      { error: "The Live session could not be created." },
      { status: 500 },
    );
  }
}
