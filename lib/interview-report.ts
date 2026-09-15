import type { InterviewConfig, PlanGenerationUsage, TranscriptEntry } from "@/lib/types";

export const REPORT_METRICS = [
  { id: "accuracy", label: "Answer accuracy", description: "Correctness of the claims and solutions given." },
  { id: "knowledge", label: "Technical knowledge", description: "Depth of understanding demonstrated in the discussion." },
  { id: "problemSolving", label: "Problem solving", description: "Reasoning, trade-offs, and practical approaches." },
  { id: "communication", label: "Communication", description: "Clear, relevant, and well-structured explanations." },
  { id: "answerConfidence", label: "Expressed confidence", description: "How clearly answers are owned, justified, and qualified." },
] as const;

export type ReportMetricId = (typeof REPORT_METRICS)[number]["id"];

export interface ReportMetric {
  score: number | null;
  rationale: string;
  evidenceIds: string[];
}

export interface ReportAnswer extends ReportMetric {
  topic: string;
  questionId: string;
  improvement: string;
}

export interface ReportObservation {
  text: string;
  evidenceIds: string[];
}

export interface ReportAnalysis {
  summary: string;
  metrics: Record<ReportMetricId, ReportMetric>;
  answers: ReportAnswer[];
  strengths: ReportObservation[];
  improvements: ReportObservation[];
  nextSteps: string[];
}

export interface InterviewReport extends ReportAnalysis {
  id: string;
  createdAt: string;
  candidateName: string;
  role: string;
  difficulty: InterviewConfig["difficulty"];
  durationSeconds: number | null;
  overallScore: number | null;
  transcript: TranscriptEntry[];
  generation: PlanGenerationUsage | null;
}

export function validateReportTranscript(value: unknown): TranscriptEntry[] | null {
  if (!Array.isArray(value) || value.length > 1_500) return null;
  const entries: TranscriptEntry[] = [];
  const ids = new Set<string>();
  let characters = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    if (
      typeof entry.id !== "string" || !entry.id || entry.id.length > 100 || ids.has(entry.id) ||
      (entry.speaker !== "candidate" && entry.speaker !== "interviewer") ||
      typeof entry.text !== "string" || entry.text.length > 30_000 ||
      typeof entry.startMs !== "number" || !Number.isFinite(entry.startMs) || entry.startMs < 0 ||
      typeof entry.endMs !== "number" || !Number.isFinite(entry.endMs) ||
      entry.endMs < entry.startMs || entry.endMs > 7_200_000
    ) return null;
    characters += entry.text.length;
    if (characters > 150_000) return null;
    ids.add(entry.id);
    if (entry.text.trim()) entries.push({
      id: entry.id, speaker: entry.speaker, text: entry.text.trim(),
      startMs: entry.startMs, endMs: entry.endMs,
    });
  }
  return entries.sort((a, b) => a.startMs - b.startMs);
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const isScore = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100);

/** Reject fabricated citations and unsupported numeric scores before saving a report. */
export function validateReportAnalysis(value: unknown, transcript: TranscriptEntry[]): ReportAnalysis | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const candidates = new Set(transcript.filter((entry) => entry.speaker === "candidate").map((entry) => entry.id));
  const questions = new Map(transcript.filter((entry) => entry.speaker === "interviewer").map((entry) => [entry.id, entry]));
  const entries = new Map(transcript.map((entry) => [entry.id, entry]));
  const validEvidence = (ids: unknown): ids is string[] =>
    Array.isArray(ids) && ids.length <= 5 && new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === "string" && candidates.has(id));
  const validMetric = (item: unknown): item is ReportMetric => {
    if (!item || typeof item !== "object") return false;
    const metric = item as ReportMetric;
    return isScore(metric.score) && isText(metric.rationale, 1_200) &&
      validEvidence(metric.evidenceIds) && (metric.score === null || metric.evidenceIds.length > 0);
  };

  if (!isText(raw.summary, 2_000) || !raw.metrics || typeof raw.metrics !== "object") return null;
  const metrics = raw.metrics as Record<ReportMetricId, ReportMetric>;
  if (Object.keys(metrics).length !== REPORT_METRICS.length ||
    REPORT_METRICS.some(({ id }) => !validMetric(metrics[id]))) return null;
  if (!Array.isArray(raw.answers) || raw.answers.length > 12) return null;
  const seenQuestions = new Set<string>();
  const usedAnswerEvidence = new Set<string>();
  for (const answer of raw.answers) {
    if (!validMetric(answer)) return null;
    const item = answer as ReportAnswer;
    const question = questions.get(item.questionId);
    if (!question || seenQuestions.has(item.questionId) || !isText(item.topic, 120) ||
      !isText(item.improvement, 1_200) || item.evidenceIds.some((id) =>
        entries.get(id)!.startMs < question.startMs || usedAnswerEvidence.has(id))) return null;
    seenQuestions.add(item.questionId);
    item.evidenceIds.forEach((id) => usedAnswerEvidence.add(id));
  }
  for (const list of [raw.strengths, raw.improvements]) {
    if (!Array.isArray(list) || list.length > 4 || list.some((item) =>
      !item || !isText(item.text, 1_000) || !validEvidence(item.evidenceIds) || item.evidenceIds.length === 0)) return null;
  }
  if (!Array.isArray(raw.nextSteps) || raw.nextSteps.length > 4 ||
    raw.nextSteps.some((step) => !isText(step, 1_000))) return null;
  // No numeric assessment can be justified when no answer was assessable.
  if (!raw.answers.some((answer) => answer.score !== null) &&
    REPORT_METRICS.some(({ id }) => metrics[id].score !== null)) return null;

  return {
    summary: raw.summary, metrics,
    answers: [...raw.answers].sort((a, b) => questions.get(a.questionId)!.startMs - questions.get(b.questionId)!.startMs),
    strengths: raw.strengths as ReportObservation[], improvements: raw.improvements as ReportObservation[],
    nextSteps: raw.nextSteps as string[],
  };
}

export function overallReportScore(analysis: ReportAnalysis): number | null {
  // Expressed confidence is descriptive; it never raises or lowers the overall score.
  const scores = REPORT_METRICS.filter(({ id }) => id !== "answerConfidence")
    .map(({ id }) => analysis.metrics[id].score);
  if (analysis.answers.filter((answer) => answer.score !== null).length < 2 ||
    scores.some((score) => score === null)) return null;
  return Math.round((scores as number[]).reduce((total, score) => total + score, 0) / scores.length);
}

export function emptyReportAnalysis(): ReportAnalysis {
  return {
    summary: "There are no candidate answers in the captured transcript, so this interview cannot be assessed yet.",
    metrics: Object.fromEntries<ReportMetric>(REPORT_METRICS.map(({ id }) => [id, {
      score: null, rationale: "No candidate answer was captured for this area.", evidenceIds: [],
    } satisfies ReportMetric])) as Record<ReportMetricId, ReportMetric>,
    answers: [], strengths: [], improvements: [],
    nextSteps: ["Complete an interview with substantive role-related answers to receive an assessment."],
  };
}

export function reportScoreLabel(score: number | null) {
  if (score === null) return "Not assessed";
  if (score >= 85) return "Strong evidence";
  if (score >= 70) return "Solid foundation";
  if (score >= 50) return "Developing";
  return "Needs development";
}
