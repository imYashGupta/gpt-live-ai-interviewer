import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { createServicePool, migrateService, transaction } from "../lib/interview-service/postgres.ts";
import { provisionAccount, issueCredential, assertId } from "../lib/interview-service/security.ts";
import { serviceRuntime } from "../lib/interview-service/runtime.ts";
import { destination, webhookTransport } from "../lib/interview-service/delivery.ts";
import { runWorkerOnce } from "../lib/interview-service/worker.ts";

const [command,...args] = process.argv.slice(2);
let pool;
try {
  if (!process.env.INTERVIEW_DATABASE_URL) throw new Error("Set INTERVIEW_DATABASE_URL to your dedicated database on Herd's PostgreSQL server");
  pool = createServicePool(process.env.INTERVIEW_DATABASE_URL);
  if (command === "migrate") {
    await migrateService(pool); console.log("Interview service migrations applied.");
  } else if (command === "provision") {
    const [name,output] = args;
    if (!name || !output) throw new Error("Usage: npm run service:provision -- Recooty .data/recooty-test-credential.json");
    const file = resolve(output); await mkdir(resolve(file,".."),{recursive:true,mode:0o700});
    // Exclusive creation inside transaction prevents accidentally overwriting a credential.
    await transaction(pool,async db => {
      const account = await provisionAccount(db,name);
      await writeFile(file,JSON.stringify(account,null,2)+"\n",{mode:0o600,flag:"wx"});
    });
    console.log("Test account created. Credential saved to the requested private file; expires in 90 days.");
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
    await destination(endpoint.url,(process.env.INTERVIEW_WEBHOOK_HOSTS ?? "").split(",").map(x=>x.trim()).filter(Boolean));
    await pool.query("UPDATE service_webhook_endpoints SET status='active' WHERE id=$1",[id]);
    console.log("Endpoint activated. Only newly created events will be delivered.");
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
    const transport=webhookTransport((process.env.INTERVIEW_WEBHOOK_HOSTS ?? "").split(",").map(x=>x.trim()).filter(Boolean));
    let stopping=false; process.on("SIGINT",()=>{stopping=true;}); process.on("SIGTERM",()=>{stopping=true;});
    console.log("Sandbox worker started. Synthetic data only; zero billable usage.");
    do { if(!await runWorkerOnce(service,transport)) { if(args.includes("--once")) break; await setTimeout(1000); } }
    while(!stopping && !args.includes("--once"));
  } else throw new Error("Command must be migrate, provision, credential, revoke, import-legacy, activate-webhook, jobs, replay, or worker");
} catch(error) {
  // Database/transport exceptions can contain credentials. Only show known operator errors.
  console.error(error?.constructor === Error && !error.code ? error.message : "Operation failed. Check database connectivity and service configuration.");
  process.exitCode=1;
} finally { await pool?.end(); }
