"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { LIVE_VOICES } from "@/lib/types";
import { questionCountForDuration } from "@/lib/question-plan";
import {
  DEFAULT_JOB_PRESET,
  JOB_PRESETS,
  findMatchingPreset,
} from "@/lib/job-presets";
import type { JobPreset } from "@/lib/job-presets";
import type {
  Difficulty,
  InterviewConfig,
  InterviewMode,
  LiveVoice,
} from "@/lib/types";

const sampleConfig: InterviewConfig = {
  mode: "ai-led",
  candidateName: "Test Candidate",
  role: DEFAULT_JOB_PRESET.role,
  durationMinutes: 5,
  difficulty: "mid",
  voice: "willow",
  followUpsEnabled: true,
  jobDescription: DEFAULT_JOB_PRESET.jobDescription,
  candidateNotes: DEFAULT_JOB_PRESET.candidateNotes,
};

type SetupStep = 1 | 2;

const STEPS = [
  { id: 1, title: "Format" },
  { id: 2, title: "Brief" },
] as const satisfies ReadonlyArray<{ id: SetupStep; title: string }>;

/**
 * Planned interviews hand off to the plan review screen after setup, so the
 * rail shows it as a third stage even though it lives in another component.
 */
const REVIEW_STEP = { id: 3, title: "Review" } as const;

const MODES = [
  {
    value: "ai-led",
    title: "AI-led",
    description: "GPT-Live chooses questions and adapts the flow in real time.",
    badge: "Fast demo",
  },
  {
    value: "planned",
    title: "Plan & review",
    description: "Luna drafts questions you can edit before the interview.",
    badge: "Customizable",
  },
] as const satisfies ReadonlyArray<{
  value: InterviewMode;
  title: string;
  description: string;
  badge: string;
}>;

interface InterviewSetupProps {
  initialConfig?: InterviewConfig;
  isGenerating: boolean;
  error: string | null;
  onContinue: (config: InterviewConfig) => void;
}

export function InterviewSetup({
  initialConfig,
  isGenerating,
  error,
  onContinue,
}: InterviewSetupProps) {
  const [config, setConfig] = useState<InterviewConfig>(
    initialConfig ?? sampleConfig,
  );
  const [step, setStep] = useState<SetupStep>(1);

  const update = <Key extends keyof InterviewConfig>(
    key: Key,
    value: InterviewConfig[Key],
  ) => setConfig((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (step === 1) {
      setStep(2);
      return;
    }
    onContinue(config);
  };

  const applyPreset = (preset: JobPreset) =>
    setConfig((current) => ({
      ...current,
      role: preset.role,
      jobDescription: preset.jobDescription,
      candidateNotes: preset.candidateNotes,
    }));

  const questionCount = questionCountForDuration(config.durationMinutes);
  const modeLabel = config.mode === "ai-led" ? "AI-led" : "Plan & review";
  const activePreset = findMatchingPreset(config);
  const steps: ReadonlyArray<{ id: number; title: string }> =
    config.mode === "planned" ? [...STEPS, REVIEW_STEP] : STEPS;

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
              <p><strong>Review your report</strong><small>Scores, answer insights, and a practice plan</small></p>
            </div>
          </div>

          <div className="privacy-note">
            <LockIcon />
            <p>
              Your OpenAI key remains on the server. Browser audio connects over
              WebRTC. Your text transcript and assessment are saved after the interview.
            </p>
          </div>
        </div>

        <form className="setup-card" onSubmit={submit}>
          <div className="form-heading">
            <div>
              <p className="form-kicker">Interview setup</p>
              <h2>{step === 1 ? "Interview format" : "Candidate brief"}</h2>
            </div>
            <span className="sample-badge">Step {step} of {steps.length}</span>
          </div>

          <ol className="wizard-steps">
            {steps.map((wizardStep) => {
              const state =
                wizardStep.id === step
                  ? "current"
                  : wizardStep.id < step
                    ? "done"
                    : "upcoming";
              const navigable = wizardStep.id <= STEPS.length;

              return (
                <li key={wizardStep.id} data-state={state}>
                  <button
                    type="button"
                    className="wizard-step"
                    data-state={state}
                    aria-current={state === "current" ? "step" : undefined}
                    disabled={!navigable || state === "current" || isGenerating}
                    onClick={() => {
                      if (navigable) setStep(wizardStep.id as SetupStep);
                    }}
                  >
                    <span aria-hidden="true">
                      {state === "done" ? <CheckIcon /> : wizardStep.id}
                    </span>
                    {wizardStep.title}
                  </button>
                </li>
              );
            })}
          </ol>

          {step === 1 ? (
            <div className="wizard-panel">
              <fieldset className="mode-field">
                <legend>Interview mode</legend>
                <div className="mode-options">
                  {MODES.map((mode) => (
                    <label
                      className={`mode-option ${config.mode === mode.value ? "active" : ""}`}
                      key={mode.value}
                    >
                      <input
                        type="radio"
                        name="interviewMode"
                        value={mode.value}
                        checked={config.mode === mode.value}
                        onChange={() => update("mode", mode.value)}
                      />
                      <span>
                        <strong>{mode.title}</strong>
                        <small>{mode.description}</small>
                      </span>
                      <em>{mode.badge}</em>
                    </label>
                  ))}
                </div>
              </fieldset>

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
            </div>
          ) : (
            <div className="wizard-panel">
              <div className="preset-field" role="group" aria-labelledby="preset-title">
                <span id="preset-title">
                  Start from a profile <em>Optional</em>
                </span>
                <div className="preset-chips">
                  {JOB_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="preset-chip"
                      aria-pressed={activePreset?.id === preset.id}
                      onClick={() => applyPreset(preset)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <p>
                  Fills the role, description, and notes below. Edit anything
                  after picking one.
                </p>
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

              <label>
                <span>Candidate or résumé notes <em>Optional</em></span>
                <textarea
                  value={config.candidateNotes}
                  onChange={(event) => update("candidateNotes", event.target.value)}
                  rows={3}
                  maxLength={3_000}
                />
              </label>

              <div
                className="followup-field"
                role="group"
                aria-labelledby="followup-title"
              >
                <div>
                  <strong id="followup-title">Adaptive follow-ups</strong>
                  <p>
                    {config.mode === "planned"
                      ? `Add 1–2 deeper prompts to about 30–40% of the ${questionCount} core questions.`
                      : "Let GPT-Live explore about 30–40% of topics more deeply when useful."}
                  </p>
                </div>
                <label className="followup-switch">
                  <input
                    type="checkbox"
                    checked={config.followUpsEnabled}
                    onChange={(event) => update("followUpsEnabled", event.target.checked)}
                    aria-label="Generate adaptive follow-up questions"
                  />
                  <span aria-hidden="true" />
                  <strong>{config.followUpsEnabled ? "On" : "Off"}</strong>
                </label>
              </div>
            </div>
          )}

          <div className="start-row">
            <p>
              <SparkIcon />
              {step === 1
                ? `${modeLabel} · ${config.durationMinutes} min · ${capitalize(config.difficulty)} level · ${capitalize(config.voice)}`
                : config.mode === "planned"
                  ? `Luna will draft ${questionCount} questions for review`
                  : "GPT-Live will shape the interview in real time"}
            </p>
            <div className="wizard-actions">
              {step === 2 && (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setStep(1)}
                  disabled={isGenerating}
                >
                  Back
                </button>
              )}
              <button className="primary-button" type="submit" disabled={isGenerating}>
                {isGenerating
                  ? "Generating plan…"
                  : step === 1
                    ? "Continue"
                    : config.mode === "planned"
                      ? "Generate interview plan"
                      : "Start AI-led interview"}
                {!isGenerating && <ArrowIcon />}
              </button>
            </div>
          </div>

          {error && <p className="setup-error" role="alert">{error}</p>}
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 1.5 4.1L18 9l-4.5 1.9L12 15l-1.5-4.1L6 9l4.5-1.9L12 3Z" />
      <path d="m18.5 15 .7 1.8L21 17.5l-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
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
