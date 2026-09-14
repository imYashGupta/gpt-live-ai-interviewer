"use client";

import { useState } from "react";

import type { DebugEvent } from "@/lib/types";

export function DebugPanel({ events }: { events: DebugEvent[] }) {
  const [open, setOpen] = useState(false);

  return (
    <section className={`debug-panel ${open ? "open" : ""}`}>
      <button
        className="debug-toggle"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span><TerminalIcon /> Live event log</span>
        <span>{events.length} events <ChevronIcon /></span>
      </button>

      {open && (
        <div className="debug-events">
          {events.length === 0 ? (
            <p>No events received yet.</p>
          ) : (
            events.map((item) => (
              <details key={item.id}>
                <summary>
                  <span className={item.direction}>{item.direction === "in" ? "←" : "→"}</span>
                  <code>{String(item.event.type ?? "unknown")}</code>
                  <time>{item.receivedAt}</time>
                </summary>
                <pre>{JSON.stringify(item.event, null, 2)}</pre>
              </details>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 7 4 4-4 4M12 17h7" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m8 10 4 4 4-4" />
    </svg>
  );
}
