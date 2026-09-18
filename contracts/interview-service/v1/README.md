# Interview service core contract — 0.1.0 draft

This is the canonical Phase 1 draft contract. It specifies seventeen operations and
normalized lifecycle, result-ready, and settlement callbacks. Phase 2 adds an opt-in
sandbox implementation of ten operations; see `INTERVIEW_SERVICE_SETUP.md` in the
service repository for the exact implemented surface and remaining operations.
The MVP routes retain their shared-passcode flow.

`openapi.json` references the JSON Schema 2020-12 definitions in `schemas.json`.
`fixtures/manifest.json` maps provider-neutral examples to their schema definitions.
The same snapshot is pinned in Recooty at
`tests/Fixtures/InterviewService/v1`, including SHA-256 hashes in `contract-lock.json`.
The example signing secret is deliberately public test data, never a deployment secret.

## Protocol rules

- Service credentials identify a service account belonging to an organization.
  Each interview belongs to a workspace. Authorization must be enforced for every
  resource, not just at creation. Candidate credentials cannot call this API.
- Authentication uses a server-only bearer credential over HTTPS. Recooty's client
  refuses redirects, bounds timeouts, and verifies returned workspace/resource IDs.
  It is a transport client, not the eventual ATS permission or provisioning layer.
- Mutations require an `Idempotency-Key` scoped to account + operation. Store the
  request fingerprint; replay returns the original result, conflicting payloads
  return HTTP 409 `idempotency_conflict`. Commands must survive network timeouts.
  Deduplicate creation by workspace + external reference beyond key expiry.
- Cancellation uses an expected resource version; stale commands return HTTP 409
  `version_conflict`. Starting and cancellation must serialize on the same resource.
- GET result returns HTTP 409 `result_pending` while assessment runs; HTTP 409
  `result_failed` when retry needs an explicit recovery action. Missing or inaccessible
  resources return HTTP 404. Insufficient credits return HTTP 409 `insufficient_credits`.
  Invalid input returns HTTP 422, invalid credentials HTTP 401, forbidden scope HTTP
  403, and throttling HTTP 429 with `Retry-After`. Errors use the Error schema.
- Recooty's client preserves pending/retryability but intentionally does not expose
  raw upstream errors or perform implicit retries. Queue orchestration must retain
  the original idempotency key and apply bounded retry/backoff in Phase 2/3.
- Availability timestamps are UTC with `Z`; display_timezone must be an IANA zone.
  Admission uses opens_at <= now < last_start_at and now < start_before. Windows
  must leave the configured duration available before must_finish_at. Slot choice
  happens in the ATS/careers app before an executable appointment is created.
- Authorization budgets delegate a bounded allocation, not permission to mint credits.
  Schema validation is supplemented by `validateInterviewSemantics`; neither replaces
  tenant authorization, current-time checks, credit reservation, or capability checks.
- Structured mode requires a reviewed plan version. Initial fake capabilities advertise
  adaptive mode only. A capability that is absent must be rejected, not silently changed.
- Seconds are integer external units; credit quantities are exact decimal strings with
  six fractional digits. Provider observations keep integer milliseconds. Billing
  policy converts verified measurements to billable seconds explicitly; the observer
  reducer does not price or debit anything.
- Provider cumulative audio duration is not automatically equal to connected wall time.
  Never sum cumulative snapshots. Missing final usage remains provisional; a terminal
  measurement alone does not prove transcript completeness or refund eligibility.
- Assessment evidence references candidate transcript IDs. Null is unassessed; zero is
  an assessed zero. Score scale/rubric version travel with the result. Evidence and
  interval semantics are validated separately from JSON Schema.
- Producer schemas reject undeclared fields. Consumers ignore additive response fields,
  tolerate new non-actionable event types, and never map unknown execution states to
  completed. Breaking semantics require a new major API version. This unreleased 0.1.0
  snapshot is a draft and must be frozen/versioned before an external pilot.

## Webhook signature and delivery

Serialize the body once and persist those exact UTF-8 bytes in an outbox. Sign:

```text
HMAC-SHA256(secret, timestamp + "." + event_id + "." + raw_body)
Interview-Event-Id: evt_example
Interview-Timestamp: <Unix seconds>
Interview-Signature: v1=<lowercase hex digest>
```

Use independently generated endpoint secrets of at least 32 bytes. Recooty supports
an active/previous secret overlap. It checks a five-minute past/future window and
compares signatures in constant time. The receiver must additionally validate the
payload schema, match header ID to body ID, validate account/workspace/subject/data
identity, and persist an inbox record uniquely by account + event ID before 202.
Signature verification does not implement replay storage or authorization by itself.

Retries use a fresh timestamp/signature with the same body and event ID. Workers
apply effects transactionally and deduplicate settlements by settlement ID. Out-of-order
resource versions cannot overwrite newer state. An interview can finish before its
result is ready; usage settlement is independent of assessment success.

## Execution state rules

The initial attempt progresses created → ready → in_progress, then completed,
interrupted, failed, or cancelled. Not-started records may expire or be cancelled.
Terminal records cannot be restarted by reusing the same invitation. Reconnects
remain in an active attempt; an authorized retake requires a new attempt and budget.
Assessment and usage have their own statuses; completed execution does not imply
ready assessment or settled usage. Transition enforcement and database locking are
part of Phase 2, not this transport/contract slice.

## Extended surface and implementation sequencing

The schemas also specify workspace provisioning, reviewed-plan generation/editing,
interview listing/rescheduling, artifacts/deletion, endpoint registration, and usage
adjustments. The first PHP client covers the eight core operations; extend its
interface as those workflows are implemented. The contract declares the target
surface; consult the service setup document for current implementation coverage.

Workspace external references are unique within the authenticated account. Approved
plans are immutable: changes require a new plan and approval. Plan ownership, rubric,
duration, language, and follow-up policy must match the interview using its version.
Interview updates are rejected once execution starts; rescheduling increments the
resource version and invalidates old invitation links. Cancellation/deletion must
stop admission immediately and drain or stop active execution before data removal.

Listing cursors must capture a stable high-water mark and order; updates during a scan
cannot be skipped. Clients overlap updated_after windows and deduplicate ID/version.
Usage cursors enumerate an append-only settlement/adjustment log. Adjustment records
reference an original settlement and use signed deltas; only accounting administrators
can create corrections. Public APIs in this draft expose read-only usage.

Webhook endpoint registration returns its secret once, before activation. Destination
verification and SSRF checks precede delivery; endpoint rotation/replay administration
is an internal operator flow for the first release. Signing secrets are encrypted at
rest; API credential hashes are a separate concern. Artifacts need authenticated
authorization before issuing short-lived URLs. Account creation, service-credit grants,
rubric/profile administration, and candidate-room APIs remain internal surfaces.

Webhook URLs may use HTTP in development/test so explicitly allowlisted local ATS
receivers can be exercised end to end. The delivery transport checks the runtime mode:
production accepts only public IPv4 HTTPS destinations on port 443, while non-production
may accept private IPv4, localhost, `.test` and nonstandard ports. Exact hostname
allowlisting, DNS pinning, redirect rejection, signatures and response timeouts apply in
all modes. Local HTTPS still verifies certificates; the exception never disables TLS.

## Validation

From the interviewer repository: `npm run test:contracts`.
From Recooty: `vendor/bin/phpunit tests/Unit/InterviewServiceClientTest.php`.
All tests use local fixtures/fakes; they do not send invitations, call paid providers,
contact a database, or change an existing customer subscription.
