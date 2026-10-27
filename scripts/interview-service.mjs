import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createServicePool, migrateService, transaction } from "../lib/interview-service/postgres.ts";
import { issueCredential, assertId } from "../lib/interview-service/security.ts";
import { createClient, renameClient, clientUsage, monthRange } from "../lib/interview-service/clients.ts";
import { serviceRuntime } from "../lib/interview-service/runtime.ts";
import { destination, webhookTransport } from "../lib/interview-service/delivery.ts";
import { runWorkerOnce, expireInvitations, claimJob, runClaimedJob } from "../lib/interview-service/worker.ts";

const [command,...args] = process.argv.slice(2);
const webhookHosts=(process.env.INTERVIEW_WEBHOOK_HOSTS ?? "").split(",").map(x=>x.trim()).filter(Boolean);
const production=process.env.NODE_ENV === "production";
let pool;
try {
  if (!process.env.INTERVIEW_DATABASE_URL) throw new Error("Set INTERVIEW_DATABASE_URL to your dedicated database on Herd's PostgreSQL server");
  pool = createServicePool(process.env.INTERVIEW_DATABASE_URL);
  if (command === "migrate") {
    await migrateService(pool); console.log("Interview service migrations applied.");
  } else if (command === "provision") {
    const [name,output] = args;
    if (!name) throw new Error("Usage: npm run service:provision -- recooty_staging [OUTPUT_FILE]");
    if (!output) {
      // No file: show the credential once. It is stored only as a hash and cannot be shown again.
      const client = await transaction(pool,db => createClient(db,name));
      console.log(`Client ${name} created. Copy these values now; the credential cannot be shown again and expires in 90 days.\n`);
      console.log(`INTERVIEW_SERVICE_ACCOUNT_ID=${client.accountId}`);
      console.log(`INTERVIEW_SERVICE_WORKSPACE_ID=${client.clientWorkspaceId}`);
      console.log(`INTERVIEW_SERVICE_CREDENTIAL=${client.token}`);
    } else {
      const file = resolve(output); await mkdir(resolve(file,".."),{recursive:true,mode:0o700});
      // Exclusive creation inside transaction prevents accidentally overwriting a credential.
      await transaction(pool,async db => {
        const client = await createClient(db,name);
        await writeFile(file,JSON.stringify(client,null,2)+"\n",{mode:0o600,flag:"wx"});
      });
      console.log(`Client ${name} created. Credential, account ID and workspace ID saved to the requested private file; the credential expires in 90 days.`);
    }
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
      while (!stopping) {
        await expireInvitations(service);
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
  } else throw new Error("Command must be migrate, provision, credential, revoke, import-legacy, activate-webhook, jobs, attempts, replay, or worker");
} catch(error) {
  // Database/transport exceptions can contain credentials. Only show known operator errors.
  console.error(error?.constructor === Error && !error.code ? error.message : "Operation failed. Check database connectivity and service configuration.");
  process.exitCode=1;
} finally { await pool?.end(); }
