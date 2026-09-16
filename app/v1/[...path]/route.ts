import { errorResponse, handleApi } from "@/lib/interview-service/http";
import { serviceRuntime } from "@/lib/interview-service/runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  try { return await handleApi(request,serviceRuntime()); } catch (error) { return errorResponse(error); }
}
export { handle as GET, handle as POST, handle as PATCH, handle as DELETE };
