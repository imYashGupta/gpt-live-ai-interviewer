/** Semantic checks supplement JSON Schema; they are not authentication or tenant authorization. */
export function validateInterviewSemantics(request: {
  configuration: { duration_limit_seconds: number };
  availability: { opens_at: string; last_start_at: string; must_finish_at: string; display_timezone: string };
  authorization_budget: { max_quantity: number; start_before: string };
}): void {
  const { availability: window, configuration: config, authorization_budget: budget } = request;
  const [opens, last, finish, authorizedUntil] = [window.opens_at, window.last_start_at, window.must_finish_at, budget.start_before].map(Date.parse);
  if (![opens, last, finish, authorizedUntil].every(Number.isFinite)
    || opens > last || last >= finish || last + config.duration_limit_seconds * 1000 > finish
    || authorizedUntil < last || budget.max_quantity < config.duration_limit_seconds) {
    throw new Error("Interview window or authorization budget cannot cover the configured duration");
  }
  new Intl.DateTimeFormat("en", { timeZone: window.display_timezone }).format(0);
}

export function validateResultEvidence(result: {
  transcript: Array<{ id: string; speaker: string; start_ms: number; end_ms: number }>;
  competencies: Array<{ id: string; score: number | null; evidence_ids: string[] }>;
}): void {
  const ids = new Set<string>();
  const candidateIds = new Set<string>();
  for (const turn of result.transcript) {
    if (ids.has(turn.id) || turn.end_ms < turn.start_ms) throw new Error("Invalid transcript identity or timing");
    ids.add(turn.id);
    if (turn.speaker === "candidate") candidateIds.add(turn.id);
  }
  const competencies = new Set<string>();
  for (const competency of result.competencies) {
    if (competencies.has(competency.id)) throw new Error("Duplicate competency");
    competencies.add(competency.id);
    if ((competency.score !== null && competency.evidence_ids.length === 0)
      || new Set(competency.evidence_ids).size !== competency.evidence_ids.length
      || competency.evidence_ids.some((id) => !candidateIds.has(id))) {
      throw new Error("Assessment evidence must reference unique candidate transcript turns");
    }
  }
}
