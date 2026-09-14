"use client";

import { useEffect, useRef } from "react";

import type { TranscriptEntry } from "@/lib/types";

interface TranscriptPanelProps {
  entries: TranscriptEntry[];
  isLive: boolean;
}

export function TranscriptPanel({ entries, isLive }: TranscriptPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [entries]);

  return (
    <section className="transcript-card" aria-label="Live transcript">
      <div className="panel-heading">
        <div>
          <p className="panel-kicker">Conversation</p>
          <h2>Live transcript</h2>
        </div>
        {isLive && <span className="live-caption"><i /> Live</span>}
      </div>

      <div className="transcript-scroll" aria-live="polite">
        {entries.length === 0 ? (
          <div className="transcript-empty">
            <QuoteIcon />
            <p>Captions will appear here once the conversation begins.</p>
            <small>Transcript timing follows the Live session timeline.</small>
          </div>
        ) : (
          entries.map((entry) => (
            <article className={`transcript-entry ${entry.speaker}`} key={entry.id}>
              <div className="speaker-avatar" aria-hidden="true">
                {entry.speaker === "interviewer" ? "AI" : "TC"}
              </div>
              <div>
                <p className="speaker-name">
                  {entry.speaker === "interviewer" ? "Interviewer" : "Candidate"}
                  <time>{formatTimestamp(entry.startMs)}</time>
                </p>
                <p className="transcript-text">{entry.text}</p>
              </div>
            </article>
          ))
        )}
        <div ref={endRef} />
      </div>
    </section>
  );
}

const formatTimestamp = (milliseconds: number) => {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
};

function QuoteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.2 11H4.5A5.5 5.5 0 0 1 10 5.5V8a3 3 0 0 0-3 3h1.2v5H3.5v-5M19.2 11h-3.7A5.5 5.5 0 0 1 21 5.5V8a3 3 0 0 0-3 3h1.2v5h-4.7v-5" />
    </svg>
  );
}
