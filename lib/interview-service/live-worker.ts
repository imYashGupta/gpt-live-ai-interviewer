import { transaction } from "./postgres.ts";
import { newId, seal, unseal } from "./security.ts";
import {
  emitEvent,
  recordShadowUsage,
  type InterviewRow,
  type InterviewService,
} from "./service.ts";
import { finishJob, ownsLease, type Job } from "./job-leases.ts";
import {
  applyObservation,
  initialObservationState,
  type Observation,
  type ObservationState,
} from "./provider.ts";
import {
  normalizeTranscript,
  type LiveConnection,
  type Assessment,
} from "./live-provider.ts";
import { validate } from "./validation.ts";

async function renew(service: InterviewService, job: Job) {
  const result = await service.pool.query(
    "UPDATE service_jobs SET lease_until=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now() RETURNING id",
    [job.id, job.lease_token]
  );
  if (!result.rowCount) throw new Error("Live worker lease lost");
}
async function checkpoint(
  service: InterviewService,
  job: Job,
  event: Observation
) {
  await transaction(service.pool, async (db) => {
    if (!(await ownsLease(db, job))) throw new Error("Live worker lease lost");
    const attempt = (
      await db.query(
        "SELECT * FROM service_attempts WHERE interview_id=$1 FOR UPDATE",
        [job.interview_id]
      )
    ).rows[0];
    const duplicate = (
      await db.query(
        "SELECT observation FROM service_observations WHERE attempt_id=$1 AND event_id=$2",
        [attempt.id, event.id]
      )
    ).rows[0];
    if (duplicate) {
      if (
        JSON.stringify(duplicate.observation) !==
        JSON.stringify(JSON.parse(JSON.stringify(event)))
      ) {
        // JSONB changes key order, so compare canonical JSONB values in PostgreSQL.
        const same = await db.query(
          "SELECT 1 FROM service_observations WHERE attempt_id=$1 AND event_id=$2 AND observation=$3::jsonb",
          [attempt.id, event.id, JSON.stringify(event)]
        );
        if (!same.rowCount) throw new Error("Conflicting provider replay");
      }
      return;
    }
    const prior = attempt.observations.usageStatus
      ? (attempt.observations as ObservationState)
      : initialObservationState();
    const next = applyObservation(
      { ...prior, events: {}, fragments: [] },
      event
    );
    const count =
      (prior as ObservationState & { count?: number; characters?: number })
        .count ?? 0;
    const characters =
      ((prior as ObservationState & { characters?: number }).characters ?? 0) +
      (event.kind === "transcript.fragment" ? event.text.length : 0);
    if (count >= 20000 || characters > 150000)
      throw new Error("Capture limit exceeded");
    await db.query(
      "INSERT INTO service_observations(attempt_id,event_id,observation) VALUES ($1,$2,$3)",
      [attempt.id, event.id, event]
    );
    await db.query("UPDATE service_attempts SET observations=$2 WHERE id=$1", [
      attempt.id,
      { ...next, events: {}, fragments: [], count: count + 1, characters },
    ]);
  });
}

async function finalize(
  service: InterviewService,
  job: Job,
  uncertain = false
) {
  await transaction(service.pool, async (db) => {
    if (!(await ownsLease(db, job))) return;
    const row = (
      await db.query<InterviewRow>(
        "SELECT * FROM service_interviews WHERE id=$1 FOR UPDATE",
        [job.interview_id]
      )
    ).rows[0];
    const attempt = (
      await db.query("SELECT * FROM service_attempts WHERE id=$1 FOR UPDATE", [
        row.attempt_id,
      ])
    ).rows[0];
    if (attempt.ended_at) {
      await finishJob(db, job);
      return;
    }
    const state = attempt.observations.usageStatus
      ? (attempt.observations as ObservationState)
      : initialObservationState();
    const events = (
      await db.query(
        "SELECT observation FROM service_observations WHERE attempt_id=$1 ORDER BY sequence",
        [attempt.id]
      )
    ).rows.map((r) => r.observation as Observation);
    const transcript = normalizeTranscript(events);
    const final = state.usageStatus === "final";
    const outcome =
      row.execution_status === "cancelled"
        ? "cancelled"
        : final && !state.captureIncomplete
        ? state.outcome!
        : "interrupted";
    await db.query(
      "UPDATE service_attempts SET ended_at=now(),connection_state=$2,observations=$3,transcript=$4,offer_ciphertext=NULL,answer_ciphertext=NULL WHERE id=$1",
      [
        attempt.id,
        uncertain ? "uncertain" : "closed",
        { ...state, captureIncomplete: state.captureIncomplete || !final },
        JSON.stringify(transcript),
      ]
    );
    const updated = (
      await db.query<InterviewRow>(
        "UPDATE service_interviews SET execution_status=$2,usage_status=$3,assessment_status=$4,resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *",
        [
          row.id,
          outcome,
          final ? "settled" : "provisional",
          outcome === "cancelled" ? "not_requested" : "pending",
        ]
      )
    ).rows[0];
    if (final) {
      await db.query(
        "UPDATE service_reservations SET status='settled' WHERE attempt_id=$1",
        [attempt.id]
      );
      await recordShadowUsage(
        db,
        updated,
        attempt.id,
        Math.ceil(state.cumulativeAudioMs / 1000)
      );
    }
    // Unknown final usage stays provisional and keeps its quota reservation for operator reconciliation.
    await emitEvent(db, updated, `interview.${outcome}`);
    if (outcome !== "cancelled")
      await db.query(
        "INSERT INTO service_jobs(id,kind,dedupe_key,interview_id) VALUES ($1,'assess',$2,$3) ON CONFLICT (dedupe_key) DO NOTHING",
        [newId("job"), `assess:${attempt.id}`, row.id]
      );
    await finishJob(db, job);
  });
}

/** Network calls are outside transactions; every persisted effect is fenced by the job lease. */
export async function executeLive(service: InterviewService, job: Job) {
  const provider = service.live?.provider;
  if (!provider) throw new Error("Live provider is not configured");
  const row = (
    await service.pool.query<InterviewRow>(
      "SELECT * FROM service_interviews WHERE id=$1",
      [job.interview_id]
    )
  ).rows[0];
  let attempt = (
    await service.pool.query("SELECT * FROM service_attempts WHERE id=$1", [
      row.attempt_id,
    ])
  ).rows[0];
  if (attempt.ended_at) {
    await transaction(service.pool, async (db) => {
      if (await ownsLease(db, job)) await finishJob(db, job);
    });
    return;
  }
  let connection: LiveConnection | undefined;
  try {
    await renew(service, job);
    if (attempt.connection_state === "queued") {
      const account = (
        await service.pool.query(
          "SELECT disabled_at FROM service_accounts WHERE id=$1",
          [row.account_id]
        )
      ).rows[0];
      if (
        account.disabled_at ||
        attempt.stop_requested_at ||
        Date.now() >= attempt.deadline_at.getTime() ||
        !service.liveEnabled(row.account_id)
      ) {
        await checkpoint(service, job, {
          id: "never_started",
          kind: "execution.closed",
          cumulativeAudioMs: 0,
          outcome: "interrupted",
        });
        await finalize(service, job);
        return;
      }
      await transaction(service.pool, async (db) => {
        if (!(await ownsLease(db, job))) throw new Error("Lease lost");
        await db.query(
          "UPDATE service_attempts SET connection_state='creating' WHERE id=$1",
          [attempt.id]
        );
      });
      // A lost response must never create a second provider session for this attempt.
      const created = await provider.create(
        row.request,
        unseal(attempt.offer_ciphertext, service.key)
      );
      try {
        await transaction(service.pool, async (db) => {
          if (!(await ownsLease(db, job))) throw new Error("Lease lost");
          await db.query(
            "UPDATE service_attempts SET provider_reference=$2,answer_ciphertext=$3,connection_state='created',offer_ciphertext=NULL WHERE id=$1",
            [attempt.id, created.reference, seal(created.answer, service.key)]
          );
        });
      } catch (error) {
        await provider.hangup(created.reference);
        throw error;
      }
      attempt = (
        await service.pool.query("SELECT * FROM service_attempts WHERE id=$1", [
          attempt.id,
        ])
      ).rows[0];
    } else {
      // SDK reconnect is not a replay guarantee. Stop recovered sessions and expose the capture gap.
      if (attempt.connection_state !== "creating")
        await provider.hangup(attempt.provider_reference);
      await finalize(service, job, true);
      return;
    }
    await renew(service, job);
    connection = provider.attach(attempt.provider_reference);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        connection.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Observer timeout")),
            10000
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await transaction(service.pool, async (db) => {
      if (!(await ownsLease(db, job))) throw new Error("Lease lost");
      await db.query(
        "UPDATE service_attempts SET connection_state='observing',observer_ready_at=now() WHERE id=$1",
        [attempt.id]
      );
    });
    let stoppingAt: number | null = null;
    for (;;) {
      await renew(service, job);
      const current = (
        await service.pool.query(
          "SELECT a.stop_requested_at,a.deadline_at,s.disabled_at FROM service_attempts a JOIN service_interviews i ON i.id=a.interview_id JOIN service_accounts s ON s.id=i.account_id WHERE a.id=$1",
          [attempt.id]
        )
      ).rows[0];
      if (
        !stoppingAt &&
        (current.stop_requested_at ||
          current.disabled_at ||
          Date.now() >= current.deadline_at.getTime() ||
          !service.liveEnabled(row.account_id))
      ) {
        await transaction(service.pool, async (db) => {
          if (!(await ownsLease(db, job))) throw new Error("Live worker lease lost");
          await db.query(
            "UPDATE service_attempts SET stop_requested_at=coalesce(stop_requested_at,now()),stop_reason=coalesce(stop_reason,$2) WHERE id=$1",
            [attempt.id, current.disabled_at || !service.liveEnabled(row.account_id)
              ? "service_disabled" : "duration_limit"],
          );
        });
        connection.stop();
        stoppingAt = Date.now();
      }
      if (!stoppingAt)
        connection.updateTimeRemaining(
          Math.max(0, Math.ceil((current.deadline_at.getTime() - Date.now()) / 1000))
        );
      if (stoppingAt && Date.now() - stoppingAt > 10000)
        throw new Error("Provider did not confirm stop");
      const event = await connection.next(AbortSignal.timeout(2000));
      if (!event) {
        // A tick timeout is harmless; the adapter throws if the socket closes without final usage.
        continue;
      }
      await checkpoint(service, job, event);
      if (event.kind === "execution.closed") {
        await finalize(service, job);
        return;
      }
    }
  } catch {
    const latest = (
      await service.pool.query("SELECT * FROM service_attempts WHERE id=$1", [
        attempt.id,
      ])
    ).rows[0];
    if (["created", "observing"].includes(latest.connection_state))
      await provider.hangup(latest.provider_reference);
    await finalize(service, job, true);
  } finally {
    connection?.close();
  }
}

export function validateAssessment(
  assessment: Assessment,
  candidateIds: Set<string>
) {
  if (
    !assessment ||
    typeof assessment.summary !== "string" ||
    !assessment.summary.trim() ||
    assessment.summary.length > 6000 ||
    !Array.isArray(assessment.competencies) ||
    assessment.competencies.length > 10
  )
    throw new Error("Invalid assessment");
  const ids = new Set<string>();
  for (const item of assessment.competencies) {
    if (
      !["accuracy", "knowledge", "problem_solving"].includes(item.id) ||
      ids.has(item.id) ||
      typeof item.rationale !== "string" ||
      !item.rationale.trim() ||
      item.rationale.length > 4000 ||
      !Array.isArray(item.evidence_ids) ||
      item.evidence_ids.some((id) => !candidateIds.has(id)) ||
      new Set(item.evidence_ids).size !== item.evidence_ids.length ||
      (item.score !== null &&
        (!Number.isInteger(item.score) ||
          item.score < 0 ||
          item.score > 100 ||
          !item.evidence_ids.length))
    )
      throw new Error("Unsupported assessment evidence");
    ids.add(item.id);
  }
}
export async function assessLive(service: InterviewService, job: Job) {
  const row = (
    await service.pool.query<InterviewRow>(
      "SELECT * FROM service_interviews WHERE id=$1",
      [job.interview_id]
    )
  ).rows[0];
  const attempt = (
    await service.pool.query("SELECT * FROM service_attempts WHERE id=$1", [
      row.attempt_id,
    ])
  ).rows[0];
  if (attempt.result || row.execution_status === "cancelled") {
    await transaction(service.pool, async (db) => {
      if (await ownsLease(db, job)) await finishJob(db, job);
    });
    return;
  }
  await renew(service, job);
  let assessment: Assessment = {
    summary:
      "The available transcript is incomplete or contains insufficient evidence for assessment.",
    competencies: [],
  };
  const eligible =
    row.execution_status === "completed" &&
    attempt.observations.usageStatus === "final" &&
    !attempt.observations.captureIncomplete &&
    attempt.transcript.some(
      (t: { speaker: string; text: string }) =>
        t.speaker === "candidate" && t.text.trim().length > 30
    );
  if (eligible) {
    if (!service.live?.assessor) throw new Error("Assessment not configured");
    // Assessment calls are bounded to 20 seconds, below the renewable job lease.
    assessment = await service.live.assessor.assess(
      row.request,
      attempt.transcript
    );
  }
  validateAssessment(
    assessment,
    new Set(
      attempt.transcript
        .filter((t: { speaker: string }) => t.speaker === "candidate")
        .map((t: { id: string }) => t.id)
    )
  );
  const scores = assessment.competencies.flatMap((c) =>
    c.score === null ? [] : [c.score]
  );
  const result = {
    schema_version: "1.0",
    interview_id: row.id,
    workspace_id: row.workspace_id,
    attempt_id: attempt.id,
    revision: 1,
    status: scores.length ? "ready" : "insufficient_evidence",
    rubric_version_id: row.request.configuration.rubric_version_id,
    summary: assessment.summary,
    score_scale: { min: 0, max: 100 },
    overall_score:
      scores.length >= 2
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : null,
    competencies: assessment.competencies,
    transcript: attempt.transcript,
    coverage_limits: [
      ...(eligible
        ? []
        : [
            "Incomplete capture or insufficient substantive evidence; no scores assigned.",
          ]),
      "Unbilled live pilot. Rubric scores require recruiter review and are not a hiring recommendation.",
    ],
  };
  validate("Result", result);
  await transaction(service.pool, async (db) => {
    if (!(await ownsLease(db, job))) return;
    const locked = (
      await db.query<InterviewRow>(
        "SELECT * FROM service_interviews WHERE id=$1 FOR UPDATE",
        [row.id]
      )
    ).rows[0];
    if (locked.execution_status === "cancelled") {
      await finishJob(db, job);
      return;
    }
    await db.query("UPDATE service_attempts SET result=$2 WHERE id=$1", [
      attempt.id,
      result,
    ]);
    const updated = (
      await db.query<InterviewRow>(
        "UPDATE service_interviews SET assessment_status=$2,resource_version=resource_version+1,updated_at=now() WHERE id=$1 RETURNING *",
        [row.id, result.status]
      )
    ).rows[0];
    await emitEvent(db, updated, "result.ready", {
      interview_id: row.id,
      attempt_id: attempt.id,
      external_reference: row.external_reference,
      result_revision: 1,
      assessment_status: result.status,
    });
    await finishJob(db, job);
  });
}
