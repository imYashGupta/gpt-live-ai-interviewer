"use client";

import { useState } from "react";
import type { FormEvent } from "react";

interface PasscodeFormProps {
  nextPath: string;
  configurationMissing: boolean;
}

export function PasscodeForm({
  nextPath,
  configurationMissing,
}: PasscodeFormProps) {
  const [passcode, setPasscode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(
    configurationMissing
      ? "APP_PASSCODE is not configured on the server."
      : null,
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!passcode.trim() || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/access/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode, next: nextPath }),
      });
      const result = (await response.json().catch(() => null)) as
        | { error?: string; redirectTo?: string }
        | null;

      if (!response.ok) {
        throw new Error(result?.error || "Access could not be verified.");
      }

      window.location.assign(result?.redirectTo || "/");
    } catch (verificationError) {
      setError(
        verificationError instanceof Error
          ? verificationError.message
          : "Access could not be verified.",
      );
      setSubmitting(false);
    }
  };

  return (
    <main className="access-shell">
      <section className="access-card" aria-labelledby="access-title">
        <a className="brand" href="/access" aria-label="Live Interview access">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>Live Interview</span>
        </a>

        <div className="access-heading">
          <p className="form-kicker">Team access</p>
          <h1 id="access-title">Enter the shared passcode.</h1>
          <p>This prototype is restricted to people with the team passcode.</p>
        </div>

        <form onSubmit={submit}>
          <label htmlFor="access-passcode">Passcode</label>
          <input
            id="access-passcode"
            name="passcode"
            type="password"
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
            autoComplete="current-password"
            maxLength={256}
            autoFocus
            required
          />

          {error && (
            <p className="access-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="primary-button"
            type="submit"
            disabled={submitting || configurationMissing}
          >
            {submitting ? "Checking…" : "Continue"}
          </button>
        </form>
      </section>
    </main>
  );
}
