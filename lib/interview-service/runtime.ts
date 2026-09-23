import { OpenAILiveProvider } from "./providers/openai-live.ts";
import { OpenAILiveAssessor } from "./providers/openai-assessment.ts";
import { createServicePool } from "./postgres.ts";
import { InterviewService } from "./service.ts";
import { ServiceError } from "./security.ts";

let instance: InterviewService | undefined;
export function serviceRuntime(): InterviewService {
  if (process.env.INTERVIEW_SERVICE_ENABLED !== "true") throw new ServiceError(503,"service_disabled");
  if (instance) return instance;
  const { INTERVIEW_DATABASE_URL: url, INTERVIEW_SERVICE_ENCRYPTION_KEY: key, INTERVIEW_SERVICE_ORIGIN: origin } = process.env;
  if (!url || !key || !/^[a-f0-9]{64}$/i.test(key) || !origin) throw new ServiceError(503,"service_not_configured");
  const apiKey = process.env.OPENAI_API_KEY;
  const liveConfigured = Boolean(apiKey);
  const accountIds = process.env.INTERVIEW_LIVE_ENABLED === "true" ? (process.env.INTERVIEW_LIVE_ACCOUNT_IDS ?? "").split(",").map(s=>s.trim()).filter(Boolean) : [];
  if (accountIds.length && !apiKey) throw new ServiceError(503,"live_not_configured");
  // Keep the adapter available for stopping/recovering existing sessions after disabling new starts.
  instance = new InterviewService(createServicePool(url),Buffer.from(key,"hex"),origin,liveConfigured ? {
    accountIds,provider:new OpenAILiveProvider(apiKey!),assessor:new OpenAILiveAssessor(apiKey!),
  } : undefined);
  instance.billableAccountIds = (process.env.INTERVIEW_BILLABLE_ACCOUNT_IDS ?? "").split(",").map(s=>s.trim()).filter(Boolean);
  return instance;
}
