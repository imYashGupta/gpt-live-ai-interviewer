"use client";
import { useEffect, useRef, useState } from "react";

type Session = { job_title: string; execution_status: string; duration_limit_seconds: number; opens_at: string; last_start_at: string };
export default function Join() {
  const invitation = useRef("");
  const [session,setSession] = useState<Session|null>(null);
  const [message,setMessage] = useState("Open your invitation, then continue when you are ready.");
  const [busy,setBusy] = useState(false);
  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (fragment) invitation.current = fragment;
    // Invitation stays in memory, never in query strings, storage, analytics or referrers.
    if (invitation.current) window.history.replaceState(null,"",window.location.pathname);
  },[]);
  async function action(path: string, input: unknown) {
    const res = await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? "Please try again.");
    return data;
  }
  async function refresh() {
    const res = await fetch("/candidate/session",{cache:"no-store"}); const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? "Session unavailable. Ask the sender for a new link.");
    setSession(data); return data;
  }
  async function perform(work:()=>Promise<void>) {
    setBusy(true); setMessage("");
    try { await work(); } catch(error) { setMessage(error instanceof Error?error.message:"Please try again."); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-xl space-y-6 px-6 py-20">
    <p className="text-sm font-semibold uppercase tracking-wide">Integration test</p>
    <h1 className="text-3xl font-semibold">Interview sandbox</h1>
    <p>This page runs a synthetic interview to test the integration. It does not record your microphone, assess you, or use paid credits.</p>
    {session ? <section className="space-y-4 rounded-xl border p-5">
      <h2 className="text-xl font-semibold">{session.job_title}</h2>
      <p>Status: <strong>{session.execution_status.replaceAll("_"," ")}</strong></p>
      <p>Configured duration: {session.duration_limit_seconds/60} minutes</p>
      {session.execution_status === "ready" && <button disabled={busy} className="rounded-lg bg-black px-5 py-3 text-white disabled:opacity-50" onClick={()=>perform(async()=>{setSession(await action("/candidate/start",{}));setMessage("Test queued. Refresh status to check worker progress.");})}>Run synthetic test</button>}
      <button disabled={busy} className="ml-3 rounded-lg border px-5 py-3 disabled:opacity-50" onClick={()=>perform(async()=>{await refresh();})}>Refresh status</button>
    </section> : <button disabled={busy} className="rounded-lg bg-black px-5 py-3 text-white disabled:opacity-50" onClick={()=>perform(async()=>{
      if(invitation.current) { await action("/candidate/exchange",{token:invitation.current}); invitation.current=""; }
      await refresh();
    })}>Continue</button>}
    <p role="status" aria-live="polite">{busy?"Please wait…":message}</p>
  </main>;
}
