// Records the candidate's camera with both voices and uploads ~10-second chunks straight to S3 through
// the service's presigned links. Uploads run one at a time so they do not compete with the live audio.

export const recordingConsentVersion = "video_v1";
const chunkMilliseconds = 10_000;
const maxAttempts = 8;
// Preferred first. Chrome, Edge and Firefox record WebM; Safari records MP4.
const mimeTypes = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a",
  "video/mp4",
];

export type RecorderState = {
  status: "idle" | "recording" | "stopped" | "failed";
  pending: number;
  uploaded: number;
  lost: number;
};
type UploadForm = { url: string; fields: Record<string, string> };

class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
async function post(path: string, input: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new RequestError(
      response.status,
      result.error?.code ?? "request_failed",
      result.error?.message ?? "Recording request failed"
    );
  return result;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function supportedRecordingType() {
  if (typeof MediaRecorder === "undefined") return null;
  return mimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export class InterviewRecorder {
  private context: AudioContext;
  private mix: MediaStreamAudioDestinationNode;
  private recorder: MediaRecorder | null = null;
  private queue: { sequence: number; blob: Blob }[] = [];
  private sequence = 0;
  private uploading: Promise<void> | null = null;
  private stopped: Promise<void> | null = null;
  private closed = false;
  state: RecorderState = { status: "idle", pending: 0, uploaded: 0, lost: 0 };

  private camera: MediaStreamTrack;
  private onState: (state: RecorderState) => void;

  constructor(
    camera: MediaStreamTrack,
    microphone: MediaStream,
    onState: (state: RecorderState) => void
  ) {
    this.camera = camera;
    this.onState = onState;
    this.context = new AudioContext();
    this.mix = this.context.createMediaStreamDestination();
    this.context.createMediaStreamSource(microphone).connect(this.mix);
  }
  private update(change: Partial<RecorderState>) {
    this.state = { ...this.state, ...change, pending: this.queue.length };
    this.onState(this.state);
  }
  /** Adds the interviewer's voice; it arrives once the live connection is answered. */
  addRemoteAudio(stream: MediaStream) {
    if (!stream.getAudioTracks().length || this.context.state === "closed")
      return;
    this.context.createMediaStreamSource(stream).connect(this.mix);
  }
  /** Opens the recording on the service, then records. Throws when the service refuses or the browser cannot record. */
  async start() {
    const type = supportedRecordingType();
    if (!type) throw new Error("This browser cannot record video.");
    await this.context.resume().catch(() => {});
    await post("/candidate/recording/start", {
      type,
      consent_version: recordingConsentVersion,
    });
    const stream = new MediaStream([
      this.camera,
      ...this.mix.stream.getAudioTracks(),
    ]);
    const recorder = new MediaRecorder(stream, {
      mimeType: type,
      videoBitsPerSecond: 500_000,
      audioBitsPerSecond: 64_000,
    });
    this.recorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data.size) return;
      this.queue.push({ sequence: this.sequence++, blob: event.data });
      this.update({});
      this.drain();
    });
    recorder.addEventListener("error", () => {
      this.update({ status: "failed" });
    });
    this.stopped = new Promise((resolve) =>
      recorder.addEventListener("stop", () => resolve(), { once: true })
    );
    recorder.start(chunkMilliseconds);
    this.update({ status: "recording" });
  }
  /** Stops recording; the final chunk is queued before this resolves. Uploads continue afterwards. */
  async stop() {
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop();
      await this.stopped;
    }
    if (this.state.status === "recording") this.update({ status: "stopped" });
    void this.context.close().catch(() => {});
  }
  /** Resolves once every queued chunk is uploaded or given up, or after the timeout. */
  async flush(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length || this.uploading) && Date.now() < deadline)
      await sleep(250);
    return this.queue.length === 0 && !this.uploading;
  }
  /** Gives up on queued uploads, for example when the page is closing. */
  abandon() {
    this.closed = true;
  }
  private drain() {
    if (this.uploading) return;
    this.uploading = (async () => {
      while (this.queue.length && !this.closed) {
        const chunk = this.queue[0];
        const saved = await this.upload(chunk.sequence, chunk.blob);
        this.queue.shift();
        this.update(
          saved
            ? { uploaded: this.state.uploaded + 1 }
            : { lost: this.state.lost + 1 }
        );
      }
    })().finally(() => {
      this.uploading = null;
      if (this.queue.length && !this.closed) this.drain();
    });
  }
  private async upload(sequence: number, blob: Blob) {
    for (let attempt = 0; attempt < maxAttempts && !this.closed; attempt++) {
      try {
        try {
          const { upload } = (await post("/candidate/recording/chunks", {
            sequence,
          })) as { upload: UploadForm };
          const form = new FormData();
          for (const [name, value] of Object.entries(upload.fields))
            form.append(name, value);
          form.append("file", blob);
          const stored = await fetch(upload.url, { method: "POST", body: form });
          if (!stored.ok)
            throw new RequestError(stored.status, "upload_failed", "Upload failed");
        } catch (error) {
          // A previous attempt reached S3 but its confirmation was lost.
          if (!(error instanceof RequestError && error.code === "chunk_already_uploaded"))
            throw error;
        }
        await post("/candidate/recording/chunks/confirm", { sequence });
        return true;
      } catch (error) {
        // The session or upload window is gone; retrying cannot succeed.
        if (
          error instanceof RequestError &&
          (error.status === 401 ||
            ["recording_closed", "recording_disabled", "recording_not_started", "validation_failed"].includes(error.code))
        )
          return false;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
    return false;
  }
}
