"use client";
import { useEffect, useRef, useState } from "react";
import styles from "@/components/candidate-interview.module.css";
import CandidateLiveRoom, {
  type CandidateSession,
} from "@/components/candidate-live-room";

type Session = CandidateSession;
export default function Join() {
  const invitation = useRef("");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState(
    "Open your invitation, then continue when you are ready."
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const fragment = window.location.hash.slice(1);
    if (fragment) invitation.current = fragment;
    // Invitation stays in memory, never in query strings, storage, analytics or referrers.
    if (invitation.current)
      window.history.replaceState(null, "", window.location.pathname);
  }, []);
  const pollStatus =
    session !== null && session.execution_status === "in_progress";
  useEffect(() => {
    if (!pollStatus) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/candidate/session", {
          cache: "no-store",
        });
        if (response.ok) setSession(await response.json());
        else if ([401,403].includes(response.status)) {
          setSession(current=>current ? {...current,execution_status:"ended"} : null);
          setMessage("This interview session has ended or is no longer available. Contact the recruiter if you need help.");
        }
      } catch {
        /* Keep the last known status; the worker owns completion. */
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pollStatus]);
  async function action(path: string, input: unknown) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? "Please try again.");
    return data;
  }
  async function refresh() {
    const res = await fetch("/candidate/session", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok)
      throw new Error(
        data.error?.message ??
          "Session unavailable. Ask the sender for a new link."
      );
    setSession(data);
    return data;
  }
  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.shell}>
      <p className={styles.eyebrow}>Your interview</p>
      <h1>Welcome</h1>
      {session?.transport === "sandbox" && (
        <p>
          This is a synthetic integration test. It does not record your
          microphone, assess you, or use paid credits.
        </p>
      )}
      {session?.transport === "webrtc" ? (
        <CandidateLiveRoom session={session} onStatus={setSession} />
      ) : session ? (
        <section className={styles.card}>
          <h2>{session.job_title}</h2>
          <p>
            Status:{" "}
            <strong>{session.execution_status.replaceAll("_", " ")}</strong>
          </p>
          <p>
            Configured duration: {session.duration_limit_seconds / 60} minutes
          </p>
          {session.execution_status === "ready" && (
            <button
              disabled={busy}
              className={`${styles.button} ${styles.primary}`}
              onClick={() =>
                perform(async () => {
                  setSession(await action("/candidate/start", {}));
                  setMessage(
                    "Test queued. Refresh status to check worker progress."
                  );
                })
              }
            >
              Run synthetic test
            </button>
          )}
          <button
            disabled={busy}
            className={styles.button}
            onClick={() =>
              perform(async () => {
                await refresh();
              })
            }
          >
            Refresh status
          </button>
        </section>
      ) : (
        <button
          disabled={busy}
          className={`${styles.button} ${styles.primary}`}
          onClick={() =>
            perform(async () => {
              if (invitation.current) {
                await action("/candidate/exchange", {
                  token: invitation.current,
                });
                invitation.current = "";
              }
              await refresh();
            })
          }
        >
          Continue
        </button>
      )}
      <p className={styles.message} role="status" aria-live="polite">
        {busy ? "Please wait…" : message}
      </p>
    </main>
  );
}
