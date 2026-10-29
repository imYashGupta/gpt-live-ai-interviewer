import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createServicePool, migrateService, transaction } from "../lib/interview-service/postgres.ts";
import { issueCredential, assertId } from "../lib/interview-service/security.ts";
import { createClient, renameClient, clientUsage, monthRange, registerWebhook } from "../lib/interview-service/clients.ts";
import { serviceRuntime } from "../lib/interview-service/runtime.ts";
import { destination, webhookTransport } from "../lib/interview-service/delivery.ts";
import { runWorkerOnce, expireInvitations, claimJob, runClaimedJob, scheduleRecordingJobs } from "../lib/interview-service/worker.ts";
import { attemptPrefix, chunkKey, recordingKey, recordingStorage } from "../lib/interview-service/recording-storage.ts";

const [command,...args] = process.argv.slice(2);
const webhookHosts=(process.env.INTERVIEW_WEBHOOK_HOSTS ?? "").split(",").map(x=>x.trim()).filter(Boolean);
const production=process.env.NODE_ENV === "production";
/** Laravel-style --name=value options, passed after `--` or straight to npm run (npm exposes those as npm_config_name). */
function option(name) {
  const prefix=`--${name}=`;
  return args.find(a => a.startsWith(prefix))?.slice(prefix.length) || process.env[`npm_config_${name}`] || undefined;
}
const positional = args.filter(a => !a.startsWith("--"));
async function clientAccount(value) {
  if (value.startsWith("acct_")) return assertId(value);
  const row=(await pool.query("SELECT id FROM service_accounts WHERE lower(name)=lower($1)",[value])).rows[0];
  if (!row) throw new Error(`Client ${value} not found; list clients with npm run service:clients`);
  return row.id;
}
function encryptionKey() {
  const key=process.env.INTERVIEW_SERVICE_ENCRYPTION_KEY ?? "";
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("Set INTERVIEW_SERVICE_ENCRYPTION_KEY (64 hex characters), the same value the app and worker use");
  return Buffer.from(key,"hex");
}
/** Round trip through the same presigned links the browser and report use, then removes the test object. */
async function recordingCheck() {
  const storage = recordingStorage();
  if (!storage) throw new Error("Set INTERVIEW_RECORDING_ENABLED=true and the INTERVIEW_RECORDING_S3_* settings first");
  const { bucket, region, prefix } = storage.config;
  const attempt = attemptPrefix(prefix,"acct_recording_check","int_recording_check",`att_${Date.now()}`);
  const key = chunkKey(attempt,0,"video/webm");
  const body = new TextEncoder().encode(`recording check ${new Date().toISOString()}`);
  const step = async (name, work) => {
    try { return await work(); }
    catch (error) {
      if (error?.constructor === Error && !error.$metadata) throw error;
      // S3 errors carry a code and status but no credentials.
      throw new Error(`${name} failed: ${error?.name ?? "error"}${error?.$metadata?.httpStatusCode ? ` (HTTP ${error.$metadata.httpStatusCode})` : ""}`);
    }
  };
  console.log(`Checking bucket ${bucket} in ${region} under ${attempt}`);
  const form = await step("Creating an upload link", () => storage.uploadForm(key,"video/webm"));
  await step("Browser-style upload", async () => {
    const data = new FormData();
    for (const [name,value] of Object.entries(form.fields)) data.append(name,value);
    data.append("file",new Blob([body],{type:"video/webm"}));
    const response = await fetch(form.url,{method:"POST",body:data});
    if (!response.ok) throw new Error(`Browser-style upload failed: HTTP ${response.status} ${(await response.text()).match(/<Code>(.*?)<\/Code>/)?.[1] ?? ""}`.trim());
  });
  console.log("Upload through presigned POST: ok");
  const size = await step("Reading object size", () => storage.size(key));
  if (size !== body.length) throw new Error(`Stored size ${size} does not match uploaded size ${body.length}`);
  console.log("Object stored: ok");
  const oversize = await step("Creating an upload link", () => storage.uploadForm(chunkKey(attempt,1,"video/webm"),"video/webm"));
  const tooLarge = new FormData();
  for (const [name,value] of Object.entries(oversize.fields)) tooLarge.append(name,value);
  tooLarge.append("file",new Blob([new Uint8Array(storage.config.maxChunkBytes + 1)],{type:"video/webm"}));
  // S3 may answer 400 EntityTooLarge or drop the connection; either way the upload is refused.
  const refused = await fetch(oversize.url,{method:"POST",body:tooLarge}).catch(() => ({ ok:false }));
  if (refused.ok) throw new Error("S3 accepted a chunk larger than INTERVIEW_RECORDING_MAX_CHUNK_BYTES");
  console.log("Oversized upload refused by S3: ok");
  const playback = await step("Playback", async () => {
    const response = await fetch(await storage.playbackUrl(key));
    if (!response.ok) throw new Error(`Playback failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  });
  if (Buffer.compare(Buffer.from(playback),Buffer.from(body)) !== 0) throw new Error("Played back bytes differ from the upload");
  console.log("Playback through presigned GET: ok");
  const second = new TextEncoder().encode(" second chunk");
  const secondForm = await step("Creating an upload link", () => storage.uploadForm(chunkKey(attempt,2,"video/webm"),"video/webm"));
  const secondData = new FormData();
  for (const [name,value] of Object.entries(secondForm.fields)) secondData.append(name,value);
  secondData.append("file",new Blob([second],{type:"video/webm"}));
  if (!(await fetch(secondForm.url,{method:"POST",body:secondData})).ok) throw new Error("Second chunk upload failed");
  const joinedKey = recordingKey(attempt,"video/webm");
  const joinedSize = await step("Joining chunks", () => storage.join([key,chunkKey(attempt,2,"video/webm")],joinedKey,"video/webm"));
  const joined = await step("Reading the joined file", async () => new Uint8Array(await (await fetch(await storage.playbackUrl(joinedKey))).arrayBuffer()));
  if (joinedSize !== body.length + second.length || Buffer.compare(Buffer.from(joined),Buffer.concat([body,second])) !== 0) throw new Error("Joined file does not match its chunks");
  console.log("Joining chunks with a multipart upload: ok");
  if (!storage.config.endpoint) {
    const anonymous = await fetch(`https://${bucket}.s3.${region}.amazonaws.com/${key}`);
    if (anonymous.ok) throw new Error("The object is publicly readable; block public access on the bucket");
    console.log("Public access blocked: ok");
  }
  const removed = await step("Deleting the test object", () => storage.deletePrefix(attempt));
  if (await step("Confirming deletion", () => storage.size(key)) !== null) throw new Error("Test object still exists after deletion");
  console.log(`Deleted ${removed} test object(s): ok\nRecording storage is ready.`);
}
let pool;
try {
  if (command !== "recording-check") {
    if (!process.env.INTERVIEW_DATABASE_URL) throw new Error("Set INTERVIEW_DATABASE_URL to your dedicated database on Herd's PostgreSQL server");
    pool = createServicePool(process.env.INTERVIEW_DATABASE_URL);
  }
  if (command === "recording-check") {
    await recordingCheck();
  } else if (command === "migrate") {
    await migrateService(pool); console.log("Interview service migrations applied.");
  } else if (command === "provision") {
    const hook = option("webhook");
    const name = option("client") ?? positional[0];
    const output = option("output") ?? positional[option("client") ? 0 : 1];
    if (!name) throw new Error("Usage: npm run service:provision --client=recooty_staging [--webhook=https://host/api/interview-service/webhook] [--output=FILE]");
    const key = hook ? encryptionKey() : null;
    const create = async db => {
      const client = await createClient(db,name);
      return { ...client, webhook: hook ? await registerWebhook(db,client.accountId,hook,key) : undefined };
    };
    if (!output) {
      // No file: show the secrets once. The credential is stored only as a hash and cannot be shown again.
      const client = await transaction(pool,create);
      console.log(`Client ${name} created. Copy these values into the client's .env now; they cannot be shown again and the credential expires in 90 days.\n`);
      console.log(`INTERVIEW_SERVICE_ACCOUNT_ID=${client.accountId}`);
      console.log(`INTERVIEW_SERVICE_WORKSPACE_ID=${client.clientWorkspaceId}`);
      console.log(`INTERVIEW_SERVICE_CREDENTIAL=${client.token}`);
      if (client.webhook) console.log(`INTERVIEW_SERVICE_WEBHOOK_SECRET=${client.webhook.secret}`);
      else console.log(`\nNo webhook: the client will rely on polling. Add one later with npm run service:webhook --client=${name} --webhook=https://...`);
    } else {
      const file = resolve(output); await mkdir(resolve(file,".."),{recursive:true,mode:0o700});
      // Exclusive creation inside transaction prevents accidentally overwriting a credential.
      await transaction(pool,async db => {
        const client = await create(db);
        await writeFile(file,JSON.stringify(client,null,2)+"\n",{mode:0o600,flag:"wx"});
      });
      console.log(`Client ${name} created. Credential, account ID and workspace ID saved to the requested private file; the credential expires in 90 days.`);
    }
  } else if (command === "webhook") {
    const client = option("client") ?? positional[0];
    const url = option("webhook") ?? positional[1];
    if (!client || !url) throw new Error("Usage: npm run service:webhook --client=recooty_dev --webhook=https://host/api/interview-service/webhook");
    const key = encryptionKey();
    const accountId = await clientAccount(client);
    const hook = await transaction(pool,db => registerWebhook(db,accountId,url,key));
    console.log(`Webhook ${hook.id} active for ${hook.url}. Put this in the client's .env now; it cannot be shown again.`);
    console.log("If the client already had a secret for this URL, move it to INTERVIEW_SERVICE_PREVIOUS_WEBHOOK_SECRET until it has switched.\n");
    console.log(`INTERVIEW_SERVICE_WEBHOOK_SECRET=${hook.secret}`);
  } else if (command === "clients") {
    const rows = await clientUsage(pool,args[0]);
    const minutes = seconds => (seconds/60).toFixed(1);
    console.log(`Usage for ${monthRange(args[0]).month} (UTC)`);
    console.table(rows.map(r => ({ client:r.client, account_id:r.account_id, disabled:r.disabled, interviews:r.interviews_month,
      measured_min:minutes(r.measured_seconds_month), billable_min:minutes(r.billable_seconds_month),
      interviews_total:r.interviews_total, billable_min_total:minutes(r.billable_seconds_total) })));
  } else if (command === "rename") {
    const [accountId,name] = args;
    if (!accountId || !name) throw new Error("Usage: rename ACCOUNT_ID NEW_NAME");
    await renameClient(pool,assertId(accountId),name);
    console.log(`Client renamed to ${name}.`);
  } else if (command === "credential") {
    const [accountId,output,workspaceId] = args;
    if (!accountId || !output) throw new Error("Usage: credential ACCOUNT_ID OUTPUT_FILE [WORKSPACE_ID]");
    const file=resolve(output); await mkdir(resolve(file,".."),{recursive:true,mode:0o700});
    await transaction(pool,async db => {
      const credential=await issueCredential(db,accountId,workspaceId ?? null);
      await writeFile(file,JSON.stringify(credential,null,2)+"\n",{mode:0o600,flag:"wx"});
    });
    console.log("Credential saved to the requested private file. Revoke the old key after updating clients.");
  } else if (command === "import-legacy") {
    if (!args[0]) throw new Error("Provide the path to the legacy SQLite database");
    const { importLegacy } = await import("../lib/interview-service/legacy.ts");
    console.log(`Archived ${await importLegacy(pool,resolve(args[0]))} internal/demo records; no usage or charges created.`);
  } else if (command === "revoke") {
    const id=assertId(args[0] ?? "");
    const result=await pool.query("UPDATE service_credentials SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL",[id]);
    console.log(`Revoked ${result.rowCount} credential(s).`);
  } else if (command === "activate-webhook") {
    const id=assertId(args[0] ?? "");
    const endpoint=(await pool.query("SELECT url FROM service_webhook_endpoints WHERE id=$1 AND status='pending_verification'",[id])).rows[0];
    if(!endpoint) throw new Error("Pending endpoint not found");
    await destination(endpoint.url,webhookHosts,production);
    await pool.query("UPDATE service_webhook_endpoints SET status='active' WHERE id=$1",[id]);
    console.log("Endpoint activated. Only newly created events will be delivered.");
  } else if (command === "attempts") {
    const result=await pool.query(`SELECT a.id,a.interview_id,a.connection_state,a.started_at,a.deadline_at,a.ended_at,
      a.stop_reason,i.execution_status,i.usage_status,a.observations->>'captureIncomplete' AS capture_incomplete
      FROM service_attempts a JOIN service_interviews i ON i.id=a.interview_id
      WHERE a.provider<>'fake' AND (a.ended_at IS NULL OR i.usage_status='provisional') ORDER BY a.started_at DESC LIMIT 100`);
    console.table(result.rows);
  } else if (command === "jobs") {
    const result=await pool.query("SELECT id,kind,status,attempts,last_error FROM service_jobs WHERE status<>'done' ORDER BY created_at LIMIT 100");
    console.table(result.rows);
  } else if (command === "replay") {
    const id=assertId(args[0] ?? "");
    const result=await pool.query("UPDATE service_jobs SET status='pending',attempts=0,available_at=now(),last_error=NULL WHERE id=$1 AND status='dead'",[id]);
    console.log(`Requeued ${result.rowCount} dead job(s), preserving event/attempt identity.`);
  } else if (command === "worker") {
    await pool.end(); pool=undefined;
    const service=serviceRuntime(); pool=service.pool;
    const transport=webhookTransport(webhookHosts,production);
    let stopping=false; process.on("SIGINT",()=>{stopping=true;}); process.on("SIGTERM",()=>{stopping=true;});
    console.log(`Interview worker started. Live interviews ${process.env.INTERVIEW_LIVE_ENABLED === "true" ? "enabled" : "disabled"}.`);
    if (args.includes("--once")) await runWorkerOnce(service,transport);
    else {
      const concurrency = Number(process.env.INTERVIEW_WORKER_CONCURRENCY ?? "4");
      if (!Number.isInteger(concurrency) || concurrency < 2 || concurrency > 20) throw new Error("Worker concurrency must be 2–20");
      const active = new Set();
      let recordingScan = 0;
      while (!stopping) {
        await expireInvitations(service);
        if (Date.now() - recordingScan > 15_000) { recordingScan = Date.now(); await scheduleRecordingJobs(service); }
        if (active.size < concurrency) {
          const job = await claimJob(service, active.size >= concurrency - 1);
          if (job) {
            const work = runClaimedJob(service,job,transport).catch(()=>{ console.error("Worker database operation failed; lease recovery required."); }).finally(()=>active.delete(work));
            active.add(work);
            continue;
          }
        }
        await setTimeout(500);
      }
      // Graceful shutdown stops intake while active capture continues to its bounded deadline.
      await Promise.all(active);
    }
  } else throw new Error("Command must be recording-check, migrate, provision, webhook, credential, revoke, import-legacy, activate-webhook, jobs, attempts, replay, or worker");
} catch(error) {
  // Database/transport exceptions can contain credentials. Only show known operator errors.
  console.error(error?.constructor === Error && !error.code ? error.message : "Operation failed. Check database connectivity and service configuration.");
  process.exitCode=1;
} finally { await pool?.end(); }
