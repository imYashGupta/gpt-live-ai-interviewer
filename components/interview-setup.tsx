"use client";

import { FormEvent, useState } from "react";

import { LIVE_VOICES } from "@/lib/types";
import type { Difficulty, InterviewConfig, LiveVoice } from "@/lib/types";

const sampleConfig: InterviewConfig = {
  candidateName: "Test Candidate",
  role: "Senior Laravel Developer",
  durationMinutes: 10,
  difficulty: "senior",
  voice: "willow",
  jobDescription:
    "Lead backend development with PHP and Laravel. Design reliable APIs and relational data models, operate queue-based workloads, debug production issues, and communicate architecture trade-offs clearly.",
  candidateNotes:
    "Focus areas: PHP / Laravel, SQL and database design, queues, APIs, debugging, architecture, and communication.",
};

interface InterviewSetupProps {
  initialConfig?: InterviewConfig;
  onStart: (config: InterviewConfig) => void;
}

export function InterviewSetup({ initialConfig, onStart }: InterviewSetupProps) {
  const [config, setConfig] = useState<InterviewConfig>(
    initialConfig ?? sampleConfig,
  );

  const update = <Key extends keyof InterviewConfig>(
    key: Key,
    value: InterviewConfig[Key],
  ) => setConfig((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onStart(config);
  };

  return (
    <main className="setup-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Live Interview Studio home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>Live Interview</span>
        </a>
        <div className="prototype-label">GPT-Live prototype</div>
      </header>

      <section className="setup-hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Structured conversations, naturally spoken</p>
          <h1>Run a focused technical interview.</h1>
          <p className="hero-description">
            Set the role and level, then speak with an AI interviewer that listens,
            follows up, and leaves room to think.
          </p>

          <div className="expectation-list" aria-label="What to expect">
            <div>
              <span className="step-number">01</span>
              <p><strong>Set the context</strong><small>Role, level, and focus areas</small></p>
            </div>
            <div>
              <span className="step-number">02</span>
              <p><strong>Talk naturally</strong><small>Use your mic, pause, and interrupt</small></p>
            </div>
            <div>
              <span className="step-number">03</span>
              <p><strong>Inspect the session</strong><small>Follow captions and Live events</small></p>
            </div>
          </div>

          <div className="privacy-note">
            <LockIcon />
            <p>
              Your OpenAI key remains on the server. Browser audio connects over
              WebRTC.
            </p>
          </div>
        </div>

        <form className="setup-card" onSubmit={submit}>
          <div className="form-heading">
            <div>
              <p className="form-kicker">Interview setup</p>
              <h2>Candidate brief</h2>
            </div>
            <span className="sample-badge">Sample ready</span>
          </div>

          <div className="form-grid two-columns">
            <label>
              <span>Candidate name</span>
              <input
                value={config.candidateName}
                onChange={(event) => update("candidateName", event.target.value)}
                maxLength={120}
                required
              />
            </label>
            <label>
              <span>Role / job title</span>
              <input
                value={config.role}
                onChange={(event) => update("role", event.target.value)}
                maxLength={180}
                required
              />
            </label>
          </div>

          <label>
            <span>Job description</span>
            <textarea
              value={config.jobDescription}
              onChange={(event) => update("jobDescription", event.target.value)}
              rows={4}
              maxLength={6_000}
              required
            />
          </label>

          <div className="form-grid two-columns">
            <label>
              <span>Duration</span>
              <span className="select-wrap">
                <select
                  value={config.durationMinutes}
                  onChange={(event) =>
                    update("durationMinutes", Number(event.target.value))
                  }
                >
                  {[5, 10, 15, 20, 30].map((minutes) => (
                    <option value={minutes} key={minutes}>{minutes} minutes</option>
                  ))}
                </select>
              </span>
            </label>

            <label>
              <span>Interviewer voice</span>
              <span className="select-wrap">
                <select
                  value={config.voice}
                  onChange={(event) =>
                    update("voice", event.target.value as LiveVoice)
                  }
                >
                  {LIVE_VOICES.map((voice) => (
                    <option value={voice} key={voice}>{capitalize(voice)}</option>
                  ))}
                </select>
              </span>
            </label>
          </div>

          <fieldset className="difficulty-field standalone-field">
            <legend>Difficulty</legend>
            <div className="segmented-control">
              {(["junior", "mid", "senior"] as Difficulty[]).map((level) => (
                <label key={level}>
                  <input
                    type="radio"
                    name="difficulty"
                    value={level}
                    checked={config.difficulty === level}
                    onChange={() => update("difficulty", level)}
                  />
                  <span>{capitalize(level)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label>
            <span>Candidate or résumé notes <em>Optional</em></span>
            <textarea
              value={config.candidateNotes}
              onChange={(event) => update("candidateNotes", event.target.value)}
              rows={3}
              maxLength={3_000}
            />
          </label>

          <div className="start-row">
            <p><MicIcon /> You’ll be asked for microphone access</p>
            <button className="primary-button" type="submit">
              Start interview <ArrowIcon />
            </button>
          </div>
        </form>
      </section>

      <footer className="setup-footer">
        <span>Experimental voice experience</span>
        <span>Headphones recommended</span>
      </footer>
    </main>
  );
}

const capitalize = (value: string) => value[0].toUpperCase() + value.slice(1);

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 10V8a5 5 0 0 1 10 0v2M6 10h12v10H6z" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}
