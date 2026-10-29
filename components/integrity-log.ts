// Reports tab, focus and camera signals during a live interview so a reviewer knows where to look in the recording.
// Offsets are measured from the attempt start with the page's monotonic clock, not the candidate's wall clock.

export type IntegrityEventType =
  | "tab_hidden"
  | "tab_visible"
  | "window_blur"
  | "window_focus"
  | "camera_lost"
  | "recording_unavailable";
type IntegrityEvent = { type: IntegrityEventType; offset_ms: number };

const flushMilliseconds = 5000;
const maxBatch = 50;

export class IntegrityLog {
  private startedAt = performance.now();
  private queue: IntegrityEvent[] = [];
  private timer: number;
  private sending = false;
  private stopped = false;
  private onVisibility = () =>
    this.add(document.visibilityState === "hidden" ? "tab_hidden" : "tab_visible");
  private onBlur = () => this.add("window_blur");
  private onFocus = () => this.add("window_focus");

  constructor() {
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("focus", this.onFocus);
    this.timer = window.setInterval(() => void this.flush(), flushMilliseconds);
    // Starting while already hidden or unfocused is itself a signal.
    if (document.visibilityState === "hidden") this.add("tab_hidden");
    else if (!document.hasFocus()) this.add("window_blur");
  }
  add(type: IntegrityEventType) {
    if (this.stopped) return;
    this.queue.push({
      type,
      offset_ms: Math.max(0, Math.round(performance.now() - this.startedAt)),
    });
    // A hidden tab may be frozen or closed before the next timer tick.
    if (type === "tab_hidden") void this.flush(true);
  }
  /** Sends queued events; keepalive lets the final batch survive the page closing. */
  async flush(keepalive = false) {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    const batch = this.queue.splice(0, maxBatch);
    try {
      const response = await fetch("/candidate/integrity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: batch }),
        keepalive,
      });
      // The session or window has closed; these events cannot be stored any more.
      if (!response.ok && response.status >= 500) this.queue.unshift(...batch);
    } catch {
      this.queue.unshift(...batch);
    } finally {
      this.sending = false;
    }
  }
  /** Stops listening and sends what is left. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    window.clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("focus", this.onFocus);
    void this.flush(true);
  }
}
