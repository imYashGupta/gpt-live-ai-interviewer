"use client";
import { useEffect, useRef, useState } from "react";
import styles from "@/components/candidate-room.module.css";
import CandidateLiveRoom, {
  type CandidateSession,
} from "@/components/candidate-live-room";
import { CandidateTopBar } from "@/components/candidate-presentation";

type Session = CandidateSession;
export default function Join() {
  const invitation = useRef("");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState("");
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
        else if ([401, 403].includes(response.status)) {
          setSession((current) =>
            current ? { ...current, execution_status: "ended" } : null
          );
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
    if (!res.ok) throw new Error(data.error?.message ?? "Try again.");
    return data;
  }
  async function refresh() {
    const res = await fetch("/candidate/session", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok)
      throw new Error(
        data.error?.message ??
          "This link no longer works. Ask the recruiter for a new one."
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
      setMessage(error instanceof Error ? error.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }
  if (session?.transport === "webrtc")
    return <CandidateLiveRoom session={session} onStatus={setSession} />;
  return (
    <main className={styles.page}>
      <CandidateTopBar />
      <div className={styles.center}>
        {session ? (
          <section className={`${styles.card} ${styles.narrow}`}>
            <h1 className={styles.title}>{session.job_title}</h1>
            <p className={styles.sub}>
              Synthetic integration test. It doesn’t use your microphone or
              assess you. Status:{" "}
              {session.execution_status.replaceAll("_", " ")}.
            </p>
            <div className={styles.actions}>
              {session.execution_status === "ready" && (
                <button
                  disabled={busy}
                  className={`${styles.button} ${styles.primary}`}
                  onClick={() =>
                    perform(async () => {
                      setSession(await action("/candidate/start", {}));
                    })
                  }
                >
                  Run synthetic test
                </button>
              )}
              <button
                disabled={busy}
                className={styles.button}
                onClick={() => perform(async () => void (await refresh()))}
              >
                Refresh status
              </button>
            </div>
          </section>
        ) : (
          <section
            className={`${styles.card} ${styles.narrow}`}
            aria-labelledby="welcome-title"
          >
            <span className={styles.badge}>AI interview</span>
            <h1 id="welcome-title" className={styles.title}>
              You’ll be interviewed by AI
            </h1>
            <p className={styles.sub}>
              An AI interviewer, not a person, asks you questions out loud and
              listens to your answers. A recruiter reviews your interview
              afterwards.
            </p>
            <p className={styles.sub}>
              Setup takes about two minutes. You’ll check your camera and
              microphone first.
            </p>
            <div className={styles.actions}>
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
                {busy ? "Opening…" : "Continue"}
              </button>
            </div>
          </section>
        )}
        {message && (
          <p className={styles.error} role="alert">
            {message}
          </p>
        )}
      </div>
    </main>
  );
}
