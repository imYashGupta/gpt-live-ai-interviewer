import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { InterviewReportView } from "@/components/interview-report";
import { ACCESS_COOKIE_NAME, getConfiguredPasscode, isValidAccessCookie } from "@/lib/access-control";
import { getInterviewReport } from "@/lib/report-store";

export const runtime = "nodejs";

export default async function SavedInterviewReport({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const passcode = getConfiguredPasscode();
  const cookie = (await cookies()).get(ACCESS_COOKIE_NAME)?.value;
  if (!passcode || !isValidAccessCookie(cookie, passcode)) {
    redirect(`/access?next=${encodeURIComponent(`/interviews/${id}/report`)}`);
  }
  const report = getInterviewReport(id);
  if (!report) notFound();
  return <main className="saved-report-shell"><nav className="saved-report-nav"><Link href="/">← Live Interview Studio</Link><span>Saved interview report</span></nav><InterviewReportView report={report} standalone /></main>;
}
