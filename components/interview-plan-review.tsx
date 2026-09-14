"use client";

import type { FormEvent } from "react";

import type {
  InterviewConfig,
  InterviewPlan,
  InterviewQuestion,
} from "@/lib/types";

interface InterviewPlanReviewProps {
  config: InterviewConfig;
  plan: InterviewPlan;
  isGenerating: boolean;
  error: string | null;
  onChange: (plan: InterviewPlan) => void;
  onRegenerate: () => void;
  onStart: () => void;
  onBack: () => void;
}

export function InterviewPlanReview({
  config,
  plan,
  isGenerating,
  error,
  onChange,
  onRegenerate,
  onStart,
  onBack,
}: InterviewPlanReviewProps) {
  const followUpCount = plan.questions.filter(
    (question) => question.followUps.length > 0,
  ).length;

  const updateQuestion = (
    questionIndex: number,
    change: (question: InterviewQuestion) => InterviewQuestion,
  ) => {
    onChange({
      ...plan,
      questions: plan.questions.map((question, index) =>
        index === questionIndex ? change(question) : question,
      ),
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onStart();
  };

  return (
    <main className="review-shell">
      <header className="site-header review-header">
        <button className="brand brand-button" type="button" onClick={onBack}>
          <span className="brand-mark" aria-hidden="true">
            <span /><span /><span />
          </span>
          <span>Live Interview</span>
        </button>
        <span className="prototype-label">Plan review</span>
      </header>

      <form className="review-layout" onSubmit={submit}>
        <aside className="review-sidebar">
          <p className="eyebrow">Luna-generated draft</p>
          <h1>Review the interview plan.</h1>
          <p>
            Edit the topics, questions, signals, or follow-ups before the Live
            interviewer starts. The plan stays visible here for fast MVP tuning.
          </p>

          <dl className="plan-stats">
            <div><dt>Role</dt><dd>{config.role}</dd></div>
            <div><dt>Duration</dt><dd>{config.durationMinutes} minutes</dd></div>
            <div><dt>Core questions</dt><dd>{plan.questions.length}</dd></div>
            <div>
              <dt>Questions with follow-ups</dt>
              <dd>{config.followUpsEnabled ? followUpCount : "Off"}</dd>
            </div>
          </dl>

          <div className="generation-meta">
            <span>Generated with GPT-5.6 Luna</span>
            <small>
              {plan.generation.inputTokens.toLocaleString()} input ·{" "}
              {plan.generation.outputTokens.toLocaleString()} output tokens
            </small>
          </div>
        </aside>

        <section className="plan-editor" aria-labelledby="plan-editor-title">
          <div className="plan-editor-heading">
            <div>
              <p className="form-kicker">Editable draft</p>
              <h2 id="plan-editor-title">Question plan</h2>
            </div>
            <span className="sample-badge">Review before starting</span>
          </div>

          {error && <p className="review-error" role="alert">{error}</p>}

          <label className="plan-summary-field">
            <span>Interview focus</span>
            <textarea
              value={plan.summary}
              onChange={(event) => onChange({ ...plan, summary: event.target.value })}
              rows={2}
              maxLength={600}
              required
            />
          </label>

          <div className="question-list">
            {plan.questions.map((question, questionIndex) => (
              <article className="question-editor" key={question.id}>
                <div className="question-number" aria-hidden="true">
                  {(questionIndex + 1).toString().padStart(2, "0")}
                </div>
                <div className="question-fields">
                  <label className="topic-field">
                    <span>Topic</span>
                    <input
                      value={question.topic}
                      onChange={(event) =>
                        updateQuestion(questionIndex, (current) => ({
                          ...current,
                          topic: event.target.value,
                        }))
                      }
                      maxLength={120}
                      required
                    />
                  </label>

                  <label>
                    <span>Main question</span>
                    <textarea
                      value={question.question}
                      onChange={(event) =>
                        updateQuestion(questionIndex, (current) => ({
                          ...current,
                          question: event.target.value,
                        }))
                      }
                      rows={2}
                      maxLength={700}
                      required
                    />
                  </label>

                  <label>
                    <span>What this explores</span>
                    <textarea
                      value={question.intent}
                      onChange={(event) =>
                        updateQuestion(questionIndex, (current) => ({
                          ...current,
                          intent: event.target.value,
                        }))
                      }
                      rows={2}
                      maxLength={400}
                      required
                    />
                  </label>

                  {config.followUpsEnabled && (
                    <div className="followup-editor">
                      <div className="followup-editor-heading">
                        <span>Adaptive follow-ups</span>
                        {question.followUps.length < 2 && (
                          <button
                            type="button"
                            onClick={() =>
                              updateQuestion(questionIndex, (current) => ({
                                ...current,
                                followUps: [
                                  ...current.followUps,
                                  "Can you give a concrete example?",
                                ],
                              }))
                            }
                          >
                            + Add
                          </button>
                        )}
                      </div>

                      {question.followUps.length === 0 ? (
                        <p>No follow-up planned for this question.</p>
                      ) : (
                        question.followUps.map((followUp, followUpIndex) => (
                          <div className="followup-row" key={`${question.id}_${followUpIndex}`}>
                            <label>
                              <span>Follow-up {followUpIndex + 1}</span>
                              <input
                                value={followUp}
                                onChange={(event) =>
                                  updateQuestion(questionIndex, (current) => ({
                                    ...current,
                                    followUps: current.followUps.map((item, index) =>
                                      index === followUpIndex ? event.target.value : item,
                                    ),
                                  }))
                                }
                                maxLength={500}
                                required
                              />
                            </label>
                            <button
                              type="button"
                              aria-label={`Remove follow-up ${followUpIndex + 1} from question ${questionIndex + 1}`}
                              onClick={() =>
                                updateQuestion(questionIndex, (current) => ({
                                  ...current,
                                  followUps: current.followUps.filter(
                                    (_, index) => index !== followUpIndex,
                                  ),
                                }))
                              }
                            >
                              Remove
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>

          <footer className="review-actions">
            <button className="secondary-button" type="button" onClick={onBack}>
              Back to setup
            </button>
            <div>
              <button
                className="secondary-button"
                type="button"
                onClick={onRegenerate}
                disabled={isGenerating}
              >
                {isGenerating ? "Regenerating…" : "Regenerate"}
              </button>
              <button className="primary-button" type="submit" disabled={isGenerating}>
                Start interview <ArrowIcon />
              </button>
            </div>
          </footer>
        </section>
      </form>
    </main>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14M14 7l5 5-5 5" />
    </svg>
  );
}
