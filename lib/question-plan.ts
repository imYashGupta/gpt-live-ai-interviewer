import type { InterviewPlan, InterviewQuestion } from "@/lib/types";

const QUESTION_COUNT_BY_DURATION: Record<number, number> = {
  5: 3,
  10: 5,
  15: 7,
  20: 9,
  30: 12,
};

export const LUNA_INPUT_USD_PER_MILLION = 0.2;
export const LUNA_CACHED_INPUT_USD_PER_MILLION = 0.02;
export const LUNA_OUTPUT_USD_PER_MILLION = 1.2;

export function questionCountForDuration(durationMinutes: number) {
  return (
    QUESTION_COUNT_BY_DURATION[durationMinutes] ??
    Math.max(2, Math.min(12, Math.round(durationMinutes * 0.45)))
  );
}

export function followUpTargetForQuestionCount(questionCount: number) {
  return Math.max(1, Math.round(questionCount * 0.35));
}

export function normalizeQuestions(
  questions: InterviewQuestion[],
  questionCount: number,
  followUpsEnabled: boolean,
) {
  const normalized = questions.slice(0, questionCount).map((question, index) => ({
    ...question,
    id: `question_${index + 1}`,
    followUps: question.followUps.slice(0, 2),
  }));

  if (!followUpsEnabled) {
    return normalized.map((question) => ({ ...question, followUps: [] }));
  }

  const target = followUpTargetForQuestionCount(questionCount);
  const selected = normalized
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => question.followUps.length > 0)
    .slice(0, target);
  const selectedIndexes = new Set(selected.map(({ index }) => index));

  for (let index = 0; selectedIndexes.size < target && index < normalized.length; index += 1) {
    selectedIndexes.add(index);
  }

  return normalized.map((question, index) => ({
    ...question,
    followUps: selectedIndexes.has(index)
      ? question.followUps.length > 0
        ? question.followUps
        : [`Can you walk me through a concrete example involving ${question.topic}?`]
      : [],
  }));
}

export function estimateLunaCost({
  inputTokens,
  cachedInputTokens,
  outputTokens,
}: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}) {
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInputTokens * LUNA_INPUT_USD_PER_MILLION +
      cachedInputTokens * LUNA_CACHED_INPUT_USD_PER_MILLION +
      outputTokens * LUNA_OUTPUT_USD_PER_MILLION) /
    1_000_000
  );
}

export function validateInterviewPlan(value: unknown): InterviewPlan | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as Record<string, unknown>;
  if (typeof plan.summary !== "string" || !plan.summary.trim()) return null;
  if (!Array.isArray(plan.questions) || plan.questions.length < 1 || plan.questions.length > 20) {
    return null;
  }

  const questions: InterviewQuestion[] = [];
  for (const value of plan.questions) {
    if (!value || typeof value !== "object") return null;
    const question = value as Record<string, unknown>;
    if (
      typeof question.id !== "string" ||
      typeof question.topic !== "string" ||
      !question.topic.trim() ||
      question.topic.length > 120 ||
      typeof question.question !== "string" ||
      !question.question.trim() ||
      question.question.length > 700 ||
      typeof question.intent !== "string" ||
      !question.intent.trim() ||
      question.intent.length > 400 ||
      !Array.isArray(question.followUps) ||
      question.followUps.length > 2 ||
      question.followUps.some(
        (followUp) =>
          typeof followUp !== "string" ||
          !followUp.trim() ||
          followUp.length > 500,
      )
    ) {
      return null;
    }
    questions.push({
      id: question.id.slice(0, 80),
      topic: question.topic.trim(),
      question: question.question.trim(),
      intent: question.intent.trim(),
      followUps: (question.followUps as string[]).map((followUp) => followUp.trim()),
    });
  }

  if (!plan.generation || typeof plan.generation !== "object") return null;
  const generation = plan.generation as Record<string, unknown>;
  if (
    generation.model !== "gpt-5.6-luna" ||
    !isNonNegativeNumber(generation.inputTokens) ||
    !isNonNegativeNumber(generation.cachedInputTokens) ||
    !isNonNegativeNumber(generation.outputTokens) ||
    !isNonNegativeNumber(generation.estimatedCostUsd)
  ) {
    return null;
  }

  return {
    summary: plan.summary.trim().slice(0, 600),
    questions,
    generation: {
      model: "gpt-5.6-luna",
      inputTokens: Math.round(generation.inputTokens),
      cachedInputTokens: Math.round(generation.cachedInputTokens),
      outputTokens: Math.round(generation.outputTokens),
      estimatedCostUsd: generation.estimatedCostUsd,
    },
  };
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
