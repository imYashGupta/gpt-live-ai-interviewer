import { createServicePool } from "./postgres.ts";
import { InterviewService } from "./service.ts";
import { ServiceError } from "./security.ts";

let instance: InterviewService | undefined;
export function serviceRuntime(): InterviewService {
  if (process.env.INTERVIEW_SERVICE_ENABLED !== "true") throw new ServiceError(503,"service_disabled");
  if (instance) return instance;
  const { INTERVIEW_DATABASE_URL: url, INTERVIEW_SERVICE_ENCRYPTION_KEY: key, INTERVIEW_SERVICE_ORIGIN: origin } = process.env;
  if (!url || !key || !/^[a-f0-9]{64}$/i.test(key) || !origin) throw new ServiceError(503,"service_not_configured");
  instance = new InterviewService(createServicePool(url),Buffer.from(key,"hex"),origin);
  return instance;
}
