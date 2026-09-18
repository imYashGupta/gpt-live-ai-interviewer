import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createServicePool,
  migrateService,
  transaction,
} from "../lib/interview-service/postgres.ts";
import {
  provisionAccount,
  authenticate,
  newId,
} from "../lib/interview-service/security.ts";
import { InterviewService } from "../lib/interview-service/service.ts";
import {
  exchangeInvitation,
  startCandidate,
  candidateConnection,
  stopCandidate,
} from "../lib/interview-service/candidate.ts";
import { handleCandidate } from "../lib/interview-service/http.ts";
import { claimJob, runClaimedJob } from "../lib/interview-service/worker.ts";

const url =
  process.env.INTERVIEW_TEST_DATABASE_URL || process.env.INTERVIEW_DATABASE_URL;
if (!url && process.env.INTERVIEW_DATABASE_TEST_REQUIRED === "true")
  throw new Error("Configure the existing Herd PostgreSQL server");
test(
  "live lifecycle uses durable trusted capture on Herd PostgreSQL",
  { skip: !url },
  async (t) => {
    const schema = "live_test_" + randomBytes(8).toString("hex"),
      admin = createServicePool(url);
    let pool;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      pool = createServicePool(url, schema);
      await migrateService(pool);
      const account = await transaction(pool, (db) =>
        provisionAccount(db, "Live test")
      );
      const p = await authenticate(pool, `Bearer ${account.token}`),
        key = randomBytes(32),
        origin = "https://interviewer.test";
      let events = [],
        clockUpdates = [],
        creates = 0,
        hangups = 0,
        assessments = 0,
        assessmentFails = false,
        mode = "normal",
        duringCreate = async () => {},
        onNext = async () => {};
      const closed = () => ({
        id: "closed",
        kind: "execution.closed",
        cumulativeAudioMs: 12000,
        outcome: "completed",
      });
      const provider = {
        async create() {
          creates++;
          await duringCreate();
          if (mode === "lost-create") throw new Error("Lost response");
          return { reference: newId("private"), answer: "private-sdp-answer" };
        },
        attach() {
          return {
            ready: Promise.resolve(),
            updateTimeRemaining(seconds) { clockUpdates.push(seconds); },
            async next() {
              await onNext();
              if (events.length) return events.shift();
              throw new Error("Observer disconnected");
            },
            stop() {
              events.push(closed());
            },
            close() {},
          };
        },
        async hangup() {
          hangups++;
          if (mode === "hangup-failed") throw new Error("Hangup unavailable");
        },
      };
      const assessor = {
        async assess() {
          assessments++;
          if (assessmentFails) throw new Error("Assessment unavailable");
          return {
            summary: "An evidence-based answer.",
            competencies: [
              {
                id: "knowledge",
                score: 75,
                rationale: "Explains the read/write tradeoff.",
                evidence_ids: ["turn_2"],
              },
              {
                id: "accuracy",
                score: 70,
                rationale: "Describes indexes.",
                evidence_ids: ["turn_2"],
              },
            ],
          };
        },
      };
      const service = new InterviewService(pool, key, origin, {
        accountIds: [p.accountId],
        provider,
        assessor,
      });
      const offer = {
        sdp: "v=0\r\nsynthetic-offer",
        consent_version: "transcript_v1",
      };
      async function invite() {
        mode = "normal";
        events = [];
        clockUpdates = [];
        duringCreate = async () => {};
        onNext = async () => {};
        const ws = await service.createWorkspace(
          p,
          { external_reference: newId("team"), display_name: "Internal test" },
          newId("cmd")
        );
        const now = Date.now(),
          last = new Date(now + 120000).toISOString();
        const input = {
          workspace_id: ws.id,
          external_reference: newId("ats"),
          candidate: {
            external_id: "candidate",
            display_name: "Synthetic Candidate",
          },
          job: {
            external_id: "job",
            title: "Engineer",
            description: "Build APIs",
          },
          configuration: {
            mode: "adaptive",
            modality: "audio",
            language: "en",
            duration_limit_seconds: 60,
            difficulty: "mid",
            follow_ups_enabled: true,
            interviewer_profile_id: "pilot_default",
            rubric_version_id: "pilot_v1",
          },
          availability: {
            kind: "window",
            opens_at: new Date(now - 1000).toISOString(),
            last_start_at: last,
            must_finish_at: new Date(now + 240000).toISOString(),
            display_timezone: "UTC",
          },
          authorization_budget: {
            external_reservation_id: newId("hold"),
            metric: "interview_seconds",
            max_quantity: 60,
            start_before: last,
          },
        };
        const createKey = newId("cmd");
        const interview = await service.createInterview(p, input, createKey);
        const link = await service.accessLink(
          p,
          interview.id,
          { expires_at: last },
          newId("cmd")
        );
        const session = await exchangeInvitation(
          service,
          new URL(link.url).hash.slice(1)
        );
        return { interview, session, input, createKey };
      }
      async function run(id, kind = "execute") {
        const job = await transaction(pool, async (db) => {
          const row = (
            await db.query(
              "SELECT * FROM service_jobs WHERE interview_id=$1 AND kind=$2 AND status<>'done' FOR UPDATE",
              [id, kind]
            )
          ).rows[0];
          assert.ok(row, `Expected ${kind} job`);
          return (
            await db.query(
              "UPDATE service_jobs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
              [row.id, newId("lease")]
            )
          ).rows[0];
        });
        await runClaimedJob(service, job, async () => {});
        return job;
      }
      const fullEvents = () => [
        {
          id: "q",
          kind: "transcript.fragment",
          speaker: "interviewer",
          text: "Explain a database index.",
          startMs: 0,
          endMs: 1000,
        },
        {
          id: "a",
          kind: "transcript.fragment",
          speaker: "candidate",
          text: "An index speeds up reads but requires extra storage and increases the cost of writes.",
          startMs: 1100,
          endMs: 8000,
        },
        { id: "u", kind: "usage.snapshot", cumulativeAudioMs: 10000 },
        closed(),
      ];
      await t.test(
        "admission requires consent; account routing and retries cannot mint a second session",
        async () => {
          const x = await invite();
          assert.deepEqual(
            service.capabilities("other").interviewer_profile_ids,
            ["sandbox_default"]
          );
          await assert.rejects(
            startCandidate(service, x.session.token),
            (e) => e.code === "consent_and_offer_required"
          );
          const malicious = await handleCandidate(
            new Request(origin + "/candidate/start", {
              method: "POST",
              headers: {
                Origin: origin,
                "Content-Type": "application/json",
                Cookie: `__Host-interview_session=${x.session.token}`,
              },
              body: JSON.stringify({
                ...offer,
                transcript: [{ text: "Invented evidence" }],
              }),
            }),
            service
          );
          assert.equal(malicious.status, 422);
          const starts = await Promise.all([
            startCandidate(service, x.session.token, offer),
            startCandidate(service, x.session.token, offer),
          ]);
          assert.equal(starts[0].attempt_id, starts[1].attempt_id);
          await assert.rejects(
            startCandidate(service, x.session.token, {
              ...offer,
              sdp: "v=0\r\nother",
            }),
            (e) => e.code === "connection_already_started"
          );
          assert.equal(
            (await candidateConnection(service, x.session.token)).answer,
            null
          );
          const before = creates;
          events = fullEvents();
          events.splice(2, 0, events[1]);
          onNext = async () => {
            const state = await candidateConnection(service, x.session.token);
            assert.equal(state.answer, "private-sdp-answer");
            assert.equal(state.provider_reference, undefined);
          };
          await run(x.interview.id);
          assert.equal(creates, before + 1);
          const row = (
            await pool.query("SELECT * FROM service_attempts WHERE id=$1", [
              starts[0].attempt_id,
            ])
          ).rows[0];
          assert.equal(row.consent_version, "transcript_v1");
          assert.equal(row.transcript.length, 2);
          assert.equal(row.offer_ciphertext, null);
          assert.equal(row.answer_ciphertext, null);
          await run(x.interview.id, "assess");
          const result = await service.readResult(p, x.interview.id);
          assert.equal(result.status, "ready");
          assert.equal(result.overall_score, 73);
          assert.equal(result.transcript[1].text, fullEvents()[1].text);
          const usage = await service.usage(p, x.input.workspace_id, null);
          assert.equal(usage.data.length, 1);
          assert.equal(usage.data[0].billable_quantity, 0);
          assert.equal(usage.data[0].measured_quantity, 12);
          assert.equal(
            (await service.readInterview(p, x.interview.id)).execution_status,
            "completed"
          );
          const serialized = JSON.stringify(result) + JSON.stringify(usage);
          assert.ok(!serialized.includes("private"));
        }
      );
      await t.test(
        "capture loss retains provisional usage and never generates unsupported scores",
        async () => {
          const x = await invite();
          await startCandidate(service, x.session.token, offer);
          events = fullEvents().slice(0, 3);
          const before = assessments;
          await run(x.interview.id);
          await run(x.interview.id, "assess");
          const state = await service.readInterview(p, x.interview.id);
          assert.equal(state.execution_status, "interrupted");
          assert.equal(state.usage_status, "provisional");
          const result = await service.readResult(p, x.interview.id);
          assert.equal(result.status, "insufficient_evidence");
          assert.equal(result.overall_score, null);
          assert.equal(assessments, before);
          assert.equal(
            (await service.usage(p, x.input.workspace_id, null)).data.length,
            0
          );
          assert.equal(
            (
              await pool.query(
                "SELECT status FROM service_reservations WHERE interview_id=$1",
                [x.interview.id]
              )
            ).rows[0].status,
            "reserved"
          );
          assert.ok(hangups > 0);
        }
      );
      await t.test(
        "lost creation response is quarantined without retrying provider creation",
        async () => {
          const x = await invite();
          await startCandidate(service, x.session.token, offer);
          mode = "lost-create";
          const before = creates;
          const job = await run(x.interview.id);
          assert.equal(creates, before + 1);
          await runClaimedJob(service, job, async () => {});
          assert.equal(creates, before + 1);
          const attempt = (
            await pool.query(
              "SELECT * FROM service_attempts WHERE interview_id=$1",
              [x.interview.id]
            )
          ).rows[0];
          assert.equal(attempt.connection_state, "uncertain");
          assert.equal(attempt.observations.captureIncomplete, true);
        }
      );
      await t.test(
        "worker recovery stops an existing provider session instead of replaying missing evidence",
        async () => {
          const x = await invite();
          const started = await startCandidate(service, x.session.token, offer);
          await pool.query(
            "UPDATE service_attempts SET connection_state='observing',provider_reference='private_recovered' WHERE id=$1",
            [started.attempt_id]
          );
          const before = creates,
            stops = hangups;
          await run(x.interview.id);
          assert.equal(creates, before);
          assert.equal(hangups, stops + 1);
          assert.equal(
            (await service.readInterview(p, x.interview.id)).execution_status,
            "interrupted"
          );
        }
      );
      await t.test(
        "candidate end and deadline watchdog await authoritative closure",
        async () => {
          for (const reason of ["candidate", "deadline"]) {
            const x = await invite();
            const started = await startCandidate(
              service,
              x.session.token,
              offer
            );
            duringCreate = async () => {
              if (reason === "candidate")
                await stopCandidate(service, x.session.token);
              else
                await pool.query(
                  "UPDATE service_attempts SET deadline_at=now()-interval '1 second' WHERE id=$1",
                  [started.attempt_id]
                );
            };
            await run(x.interview.id);
            assert.equal(
              (await service.readInterview(p, x.interview.id)).usage_status,
              "settled"
            );
            assert.equal((await service.readInterview(p, x.interview.id)).execution_status, "completed");
            assert.equal((await pool.query("SELECT stop_reason FROM service_attempts WHERE id=$1", [started.attempt_id])).rows[0].stop_reason,
              reason === "candidate" ? "candidate_end" : "duration_limit");
            assert.deepEqual(clockUpdates, [], "no pacing commands after stop is requested");
          }
        }
      );
      await t.test("the worker supplies its clock, then closes automatically at the deadline", async () => {
        const x = await invite();
        const started = await startCandidate(service, x.session.token, offer);
        duringCreate = async () => {
          await pool.query("UPDATE service_attempts SET deadline_at=now()+interval '19 seconds' WHERE id=$1", [started.attempt_id]);
          events.push({id: "answer", kind: "transcript.fragment", speaker: "candidate", text: "A short answer.", startMs: 0, endMs: 1000});
        };
        onNext = async () => {
          assert.ok(clockUpdates[0] > 0 && clockUpdates[0] <= 20);
          await pool.query("UPDATE service_attempts SET deadline_at=now()-interval '1 second' WHERE id=$1", [started.attempt_id]);
        };
        await run(x.interview.id);
        assert.equal(clockUpdates.length, 1);
        assert.equal((await service.readInterview(p, x.interview.id)).execution_status, "completed");
        assert.equal((await pool.query("SELECT stop_reason FROM service_attempts WHERE id=$1", [started.attempt_id])).rows[0].stop_reason, "duration_limit");
      });
      await t.test(
        "employer cancellation requests remote stop before releasing the reservation",
        async () => {
          const x = await invite();
          await startCandidate(service, x.session.token, offer);
          duringCreate = async () => {
            const state = await service.readInterview(p, x.interview.id);
            await service.cancel(
              p,
              x.interview.id,
              {
                expected_resource_version: state.resource_version,
                reason: "employer_request",
              },
              newId("cmd")
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT status FROM service_reservations WHERE interview_id=$1",
                  [x.interview.id]
                )
              ).rows[0].status,
              "reserved"
            );
          };
          await run(x.interview.id);
          const state = await service.readInterview(p, x.interview.id);
          assert.equal(state.execution_status, "cancelled");
          assert.equal(state.usage_status, "settled");
          assert.equal(
            (
              await pool.query(
                "SELECT status FROM service_reservations WHERE interview_id=$1",
                [x.interview.id]
              )
            ).rows[0].status,
            "settled"
          );
        }
      );
      await t.test(
        "stale lease cannot publish capture or completion",
        async () => {
          const x = await invite();
          await startCandidate(service, x.session.token, offer);
          events = fullEvents();
          onNext = async () => {
            await pool.query(
              "UPDATE service_jobs SET lease_until=now()-interval '1 second' WHERE interview_id=$1 AND kind='execute'",
              [x.interview.id]
            );
          };
          await run(x.interview.id);
          assert.equal(
            (await service.readInterview(p, x.interview.id)).execution_status,
            "in_progress"
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM service_observations o JOIN service_attempts a ON a.id=o.attempt_id WHERE a.interview_id=$1",
                [x.interview.id]
              )
            ).rows[0].n,
            0
          );
          onNext = async () => {};
          await run(x.interview.id);
          assert.equal(
            (await service.readInterview(p, x.interview.id)).execution_status,
            "interrupted"
          );
        }
      );
      await t.test(
        "failed remote stop stays retryable and keeps the quota reservation",
        async () => {
          const x = await invite();
          const started = await startCandidate(service, x.session.token, offer);
          await pool.query(
            "UPDATE service_attempts SET connection_state='observing',provider_reference='private_retry' WHERE id=$1",
            [started.attempt_id]
          );
          mode = "hangup-failed";
          const job = await run(x.interview.id);
          assert.equal(
            (
              await pool.query("SELECT status FROM service_jobs WHERE id=$1", [
                job.id,
              ])
            ).rows[0].status,
            "pending"
          );
          assert.equal(
            (await service.readInterview(p, x.interview.id)).execution_status,
            "in_progress"
          );
          assert.equal(
            (
              await pool.query(
                "SELECT ended_at FROM service_attempts WHERE id=$1",
                [started.attempt_id]
              )
            ).rows[0].ended_at,
            null
          );
          mode = "normal";
          await run(x.interview.id);
          assert.equal(
            (await service.readInterview(p, x.interview.id)).execution_status,
            "interrupted"
          );
        }
      );
      await t.test(
        "assessment retries are bounded and expose a durable failure event",
        async () => {
          const x = await invite();
          await startCandidate(service, x.session.token, offer);
          events = fullEvents();
          await run(x.interview.id);
          assessmentFails = true;
          const before = assessments;
          let job;
          for (let retry = 0; retry < 3; retry++)
            job = await run(x.interview.id, "assess");
          assessmentFails = false;
          assert.equal(assessments, before + 3);
          assert.equal(
            (await service.readInterview(p, x.interview.id)).assessment_status,
            "failed"
          );
          assert.equal(
            (
              await pool.query("SELECT status FROM service_jobs WHERE id=$1", [
                job.id,
              ])
            ).rows[0].status,
            "dead"
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int n FROM service_events WHERE interview_id=$1 AND type='result.failed'",
                [x.interview.id]
              )
            ).rows[0].n,
            1
          );
        }
      );
      await t.test(
        "rollback keeps create replay stable and blocks new live starts",
        async () => {
          const x = await invite();
          service.live.accountIds = [];
          assert.deepEqual(
            await service.createInterview(p, x.input, x.createKey),
            x.interview
          );
          await assert.rejects(
            startCandidate(service, x.session.token, offer),
            (e) => e.code === "live_pilot_disabled"
          );
          service.live.accountIds = [p.accountId];
        }
      );
      await t.test(
        "control-only worker claim leaves long execution jobs for capture slots",
        async () => {
          const x = await invite();
          await startCandidate(service, x.session.token, offer);
          const job = await claimJob(service, true);
          assert.ok(!job || job.kind !== "execute");
        }
      );
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  }
);
