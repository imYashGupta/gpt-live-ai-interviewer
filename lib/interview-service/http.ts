import { capabilities, type InterviewService } from "./service.ts";
import { newId, ServiceError } from "./security.ts";
import { candidateStatus, exchangeInvitation, startCandidate } from "./candidate.ts";
import type { InterviewRequest } from "./validation.ts";

const responseHeaders = { "Cache-Control":"no-store", "Referrer-Policy":"no-referrer", "X-Content-Type-Options":"nosniff" };
function json(body: unknown,status = 200,headers: Record<string,string> = {}) { return Response.json(body,{status,headers:{...responseHeaders,...headers}}); }
export function errorResponse(error: unknown) {
  const expected = error instanceof ServiceError;
  return json({error:{code:expected?error.code:"internal_error",message:expected?error.message:"Service temporarily unavailable",
    request_id:newId("req"),retryable:!expected || error.status>=500}},expected?error.status:503);
}
async function body(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new ServiceError(415,"json_required");
  // Enforce an actual streamed bound, not just the untrusted Content-Length header.
  if (!request.body) throw new ServiceError(400,"invalid_json");
  const reader = request.body.getReader(); const parts: Uint8Array[]=[]; let length=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if (done) break;
      length+=value.length;
      if (length>64*1024) { await reader.cancel(); throw new ServiceError(413,"payload_too_large"); }
      parts.push(value);
    }
    try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new ServiceError(400,"invalid_json"); }
  } finally { reader.releaseLock(); }
}
function candidateToken(request: Request) {
  return request.headers.get("cookie")?.split(";").map(c=>c.trim()).find(c=>c.startsWith("__Host-interview_session="))?.slice("__Host-interview_session=".length) ?? null;
}
export async function handleCandidate(request: Request,service: InterviewService) {
  try {
    const url = new URL(request.url);
    if (request.method === "POST" && request.headers.get("origin") !== service.origin) throw new ServiceError(403,"invalid_origin");
    if (request.method === "GET" && url.pathname === "/candidate/session") return json(await candidateStatus(service,candidateToken(request)));
    if (request.method === "POST" && url.pathname === "/candidate/exchange") {
      const input = await body(request);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k=>k!=="token")) throw new ServiceError(422,"validation_failed");
      const session = await exchangeInvitation(service,(input as {token?:unknown}).token);
      return json({status:"ready"},200,{"Set-Cookie":`__Host-interview_session=${session.token}; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=${new Date(session.expiresAt).toUTCString()}`});
    }
    if (request.method === "POST" && url.pathname === "/candidate/start") {
      const input = await body(request);
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new ServiceError(422,"validation_failed");
      return json(await startCandidate(service,candidateToken(request)));
    }
    throw new ServiceError(404,"not_found");
  } catch (error) { return errorResponse(error); }
}
export async function handleApi(request: Request,service: InterviewService) {
  try {
    const p = await service.principal(request.headers.get("authorization"));
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const key = request.headers.get("idempotency-key");
    if (method === "GET" && path === "/v1/capabilities") return json(capabilities);
    if (method === "POST" && path === "/v1/workspaces") return json(await service.createWorkspace(p,await body(request) as Parameters<InterviewService["createWorkspace"]>[1],key),201);
    if (method === "POST" && path === "/v1/interviews") return json(await service.createInterview(p,await body(request) as InterviewRequest,key),201);
    if (method === "POST" && path === "/v1/webhook-endpoints") return json(await service.webhookEndpoint(p,await body(request) as Parameters<InterviewService["webhookEndpoint"]>[1],key),201);
    if (method === "GET" && path === "/v1/usage") return json(await service.usage(p,url.searchParams.get("workspace_id") ?? "",url.searchParams.get("cursor")));
    if (method === "GET" && path === "/v1/balance") return json(await service.balance(p,url.searchParams.get("workspace_id") ?? ""));
    const match = /^\/v1\/interviews\/([A-Za-z0-9_-]+)(?:\/(access-links|cancel|result))?$/.exec(path);
    if (match) {
      const [,id,action]=match;
      if (method === "GET" && !action) return json(await service.readInterview(p,id));
      if (method === "GET" && action === "result") return json(await service.readResult(p,id));
      if (method === "POST" && action === "access-links") return json(await service.accessLink(p,id,await body(request) as {expires_at:string},key),201);
      if (method === "POST" && action === "cancel") return json(await service.cancel(p,id,await body(request) as {expected_resource_version:number;reason:string},key));
    }
    throw new ServiceError(404,"not_found","Endpoint not implemented in the sandbox service");
  } catch (error) { return errorResponse(error); }
}
