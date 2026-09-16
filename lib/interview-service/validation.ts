import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schemas from "../../contracts/interview-service/v1/schemas.json" with { type: "json" };
import { ServiceError } from "./security.ts";

const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats(ajv);
ajv.addSchema(schemas);
export function validate(schema: string, input: unknown): void {
  if (!ajv.validate(`${schemas.$id}#/$defs/${schema}`, input)) {
    throw new ServiceError(422, "validation_failed", `Invalid ${schema}`);
  }
}
export interface InterviewRequest {
  workspace_id: string;
  external_reference: string;
  candidate: { external_id: string; display_name: string };
  job: { external_id: string; title: string; description: string };
  configuration: {
    mode: "adaptive" | "structured"; modality: "audio"; language: string;
    duration_limit_seconds: number; difficulty: string; follow_ups_enabled: boolean;
    interviewer_profile_id: string; rubric_version_id: string; plan_version_id?: string;
  };
  availability: { kind: string; opens_at: string; last_start_at: string; must_finish_at: string; display_timezone: string };
  authorization_budget: { external_reservation_id: string; metric: string; max_quantity: number; start_before: string };
}
