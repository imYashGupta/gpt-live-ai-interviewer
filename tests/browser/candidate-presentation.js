// Run against a running dev server using Playwright CLI:
// playwright-cli --session candidate-presentation run-code --filename tests/browser/candidate-presentation.js
// Set globalThis.CANDIDATE_TEST_ORIGIN first to test another origin than the local HTTPS proxy.
// Every candidate request, S3 upload, camera, microphone and WebRTC API is mocked. No provider is contacted.
// Playwright CLI evaluates this file as a function expression.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async (page) => {
  const origin = globalThis.CANDIDATE_TEST_ORIGIN ?? "https://ai-interviewer.test";
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const visible = async (text) => page.getByText(text, { exact: true }).first().waitFor();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const fixture = {
    job_title: "Social Media Intern", execution_status: "ready", duration_limit_seconds: 900,
    opens_at: "2026-01-01T00:00:00Z", last_start_at: "2027-01-01T00:00:00Z", transport: "webrtc", recording_required: true,
  };
  let session = { ...fixture };
  let deadline = Date.now() + 900000;
  let stopFails = false;
  let holdStop = false;
  let unauthorized = false;
  const calls = [];
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on("pageerror", onError);
  await page.route(`${origin}/candidate/**`, async route => {
    const req = route.request();
    const path = req.url().slice(origin.length).split("?")[0];
    calls.push({ path, method: req.method(), body: req.postDataJSON() });
    let body = session;
    let status = 200;
    if (path === "/candidate/start") session = body = { ...session, execution_status: "in_progress" };
    else if (path === "/candidate/connection") body = { ...session, answer: "v=0\r\nsynthetic-answer", deadline_at: new Date(deadline).toISOString() };
    else if (path === "/candidate/stop") {
      status = stopFails ? 503 : 200;
      body = stopFails ? { error: { message: "Synthetic outage" } } : { status: "ending" };
      if (!stopFails && !holdStop) session = { ...session, execution_status: "completed" };
    } else if (path === "/candidate/exchange") body = {};
    else if (path === "/candidate/recording/start") body = { status: "recording", content_type: "video/webm", max_chunk_bytes: 8388608, max_sequence: 900 };
    else if (path === "/candidate/recording/chunks") body = { sequence: req.postDataJSON().sequence, upload: { url: "https://storage.test/upload", fields: { key: "chunk" }, expires_at: new Date(Date.now() + 300000).toISOString() } };
    else if (path === "/candidate/recording/chunks/confirm") body = { sequence: req.postDataJSON().sequence, bytes: 1 };
    else if (path === "/candidate/integrity") body = { accepted: req.postDataJSON().events.length };
    else if (path === "/candidate/session" && unauthorized) { status = 401; body = { error: { message: "Session unavailable" } }; }
    else if (path !== "/candidate/session") throw new Error(`Unexpected candidate request: ${path}`);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("https://storage.test/**", route => route.fulfill({ status: 204 }));
  // Catch accidental restoration of any of the MVP's browser-authoritative routes.
  await page.route(`${origin}/api/**`, route => { errors.push(`Unexpected API request: ${route.request().url()}`); return route.abort(); });
  await page.addInitScript(() => {
    if (!navigator.mediaDevices || window.__candidateTest) return;
    const state = window.__candidateTest = { stream: null, peer: null, sends: 0, mediaCalls: 0, constraints: null, denyMedia: false, blockPlayback: false };
    const context = new AudioContext();
    // A real stream: a drawn camera and a tone as the voice, so previews, meters and the recorder all work.
    const tone = (frequency) => {
      const oscillator = context.createOscillator(); oscillator.frequency.value = frequency;
      const destination = context.createMediaStreamDestination(); oscillator.connect(destination); oscillator.start();
      return destination.stream;
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async (constraints) => {
      state.mediaCalls++;
      state.constraints = constraints;
      if (state.denyMedia) throw new DOMException("Permission denied", "NotAllowedError");
      await context.resume();
      const tracks = [...tone(300).getAudioTracks()];
      if (constraints.video) {
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
        const draw = canvas.getContext("2d"); let frame = 0;
        setInterval(() => { draw.fillStyle = `hsl(${frame++ % 360} 40% 45%)`; draw.fillRect(0, 0, 640, 480); }, 66);
        tracks.push(...canvas.captureStream(15).getVideoTracks());
      }
      state.stream = new MediaStream(tracks);
      return state.stream;
    } });
    window.confirm = () => true;
    window.RTCPeerConnection = class {
      constructor() { state.peer = this; this.connectionState = "new"; this.iceGatheringState = "complete"; }
      createDataChannel() { return { send() { state.sends++; throw new Error("Browser provider commands are forbidden"); } }; }
      addTrack(track) { (this.kinds ??= []).push(track.kind); }
      async createOffer() { return { type: "offer", sdp: "v=0\r\nsynthetic-offer" }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async setRemoteDescription() {
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
        this.ontrack?.({ streams: [tone(600)] });
      }
      close() { this.connectionState = "closed"; this.closed = true; }
    };
    HTMLAudioElement.prototype.play = async function() { if (state.blockPlayback) throw new DOMException("Playback blocked", "NotAllowedError"); };
  });
  const tracksStopped = () => page.evaluate(() => window.__candidateTest.stream.getTracks().every(track => track.readyState === "ended"));
  const open = async () => {
    await page.goto(`${origin}/join`);
    await button("Continue").click();
  };
  // Walks the wizard to the ready screen.
  const setup = async () => {
    await button("Next").click();
    for (const box of await page.getByRole("checkbox").all()) await box.check();
    await button("Next").click();
    await visible("We can hear you");
    await button("Next").click();
    await button("Play test sound").click();
    await button("I heard it").click();
    await visible("Ready to start?");
  };
  const start = async () => {
    await button("Start interview").click();
    await page.getByRole("navigation", { name: "Call controls" }).waitFor();
  };
  const end = async () => { await button("End interview").click(); };
  // Scoped to the page content: Next.js adds its own role="alert" route announcer.
  const alerts = () => page.locator("main").getByRole("alert");
  const notice = () => alerts().first().innerText();
  const screenshot = async name => page.screenshot({ path: `output/playwright/candidate-${name}.png`, fullPage: true });
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Horizontal overflow");
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("about:blank");
    await page.goto(`${origin}/join#synthetic-invitation`);
    await button("Continue").waitFor();
    await page.waitForFunction(() => window.location.hash === "");
    assert(!page.url().includes("#"), "Invitation fragment must be removed");
    assert(!calls.some(c => c.path.endsWith("exchange")), "Invitation must not exchange until Continue");
    await screenshot("welcome");
    await button("Continue").click();
    await visible("Step 1 of 4 · What to expect");
    await screenshot("expect");
    await button("Next").click();
    assert(await button("Next").isDisabled(), "Consent must gate the device check");
    await page.getByRole("checkbox").first().check();
    assert(await button("Next").isDisabled(), "Recorded interviews need both consents");
    await page.getByRole("checkbox").nth(1).check();
    assert(await page.evaluate(() => window.__candidateTest.mediaCalls) === 0, "No camera or microphone before consent");
    await screenshot("consent");

    // A refused permission explains what to do and offers a retry.
    await page.evaluate(() => window.__candidateTest.denyMedia = true);
    await button("Next").click();
    await visible("Allow camera and microphone access in your browser’s address bar, then try again.");
    await page.evaluate(() => window.__candidateTest.denyMedia = false);
    await button("Try again").click();
    await visible("Camera working");
    await visible("We can hear you");
    const constraints = await page.evaluate(() => window.__candidateTest.constraints);
    assert(constraints.video && constraints.audio, "Recorded interviews open camera and microphone together");
    await screenshot("devices-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("devices-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await button("Next").click();
    assert(await button("I heard it").isDisabled(), "The speaker check needs the test sound first");
    await button("Play test sound").click();
    await button("I heard it").click();
    await visible("Ready to start?");
    await screenshot("ready");

    await page.evaluate(() => window.__candidateTest.blockPlayback = true);
    await start();
    const startCall = calls.find(c => c.path === "/candidate/start");
    assert(JSON.stringify(Object.keys(startCall.body).sort()) === JSON.stringify(["consent_version", "sdp"]), "Start may submit only consent and media offer");
    assert(startCall.body.consent_version === "transcript_v1", "Consent version retained");
    assert(calls.find(c => c.path === "/candidate/recording/start")?.body.consent_version === "video_v1", "Recording consent version sent");
    assert(await page.evaluate(() => window.__candidateTest.mediaCalls) === 2, "The checked devices are reused at start");
    assert(JSON.stringify(await page.evaluate(() => window.__candidateTest.peer.kinds)) === JSON.stringify(["audio"]), "The interviewer receives audio only");
    await button("Turn on sound").waitFor();
    await page.evaluate(() => window.__candidateTest.blockPlayback = false);
    await button("Turn on sound").click();
    await button("Turn on sound").waitFor({ state: "hidden" });
    await page.getByLabel("Time remaining", { exact: true }).waitFor();
    await visible("Recording");
    assert(await alerts().count() === 0, "The call screen shows no text while everything works");
    await button("Mute microphone").click();
    assert(await page.evaluate(() => window.__candidateTest.stream.getAudioTracks().every(track => !track.enabled)), "Mute must disable capture");
    await button("Unmute microphone").click();
    assert(await page.evaluate(() => window.__candidateTest.stream.getAudioTracks().every(track => track.enabled)), "Unmute must enable capture");
    await screenshot("call-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("call-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { const peer = window.__candidateTest.peer; peer.connectionState = "disconnected"; peer.onconnectionstatechange(); });
    assert((await notice()).includes("Connection lost"), "Lost connection is announced");
    assert(await button("Mute microphone").isEnabled(), "Muting stays available while reconnecting");
    await page.evaluate(() => { const peer = window.__candidateTest.peer; peer.connectionState = "connected"; peer.onconnectionstatechange(); });
    await alerts().waitFor({ state: "detached" });
    await page.evaluate(() => window.__candidateTest.stream.getVideoTracks()[0].dispatchEvent(new Event("ended")));
    assert((await notice()).includes("Your camera stopped"), "Camera loss is announced");
    stopFails = true;
    await end();
    await visible("We couldn’t confirm the interview ended. Your microphone is off.");
    assert(await tracksStopped(), "Unconfirmed stop must release capture");
    stopFails = false;
    await alerts().getByRole("button", { name: "End interview" }).click();
    await page.getByRole("heading", { name: "Thanks, you’re all done" }).waitFor();
    assert(await button("Start interview").count() === 0, "Completed interview cannot restart");
    await screenshot("done");

    // Stop must await authoritative terminal state before releasing the peer.
    session = { ...fixture };
    holdStop = true;
    await open();
    await setup();
    await start();
    await end();
    await visible("Ending…");
    assert(await page.evaluate(() => window.__candidateTest.stream.getAudioTracks().every(track => !track.enabled) && !window.__candidateTest.peer.closed), "Keep transport alive but disable mic during stop confirmation");
    session = { ...session, execution_status: "completed" };
    await page.getByRole("heading", { name: "Thanks, you’re all done" }).waitFor();
    assert(await page.evaluate(() => window.__candidateTest.peer.closed), "Release transport after authoritative completion");
    holdStop = false;

    // Clock reaching zero is presentation only; the service decides completion.
    session = { ...fixture };
    deadline = Date.now() - 1000;
    await open();
    await setup();
    await start();
    await page.waitForFunction(() => document.querySelector('[aria-label="Time remaining"]')?.textContent === "0:00");
    assert(await page.getByRole("heading", { name: "Thanks, you’re all done" }).count() === 0, "Browser timer cannot mark completion");
    session = { ...session, execution_status: "completed" };
    await page.getByRole("heading", { name: "Thanks, you’re all done" }).waitFor({ timeout: 8000 });
    assert(await tracksStopped(), "Server completion must release camera and microphone");
    deadline = Date.now() + 900000;

    // Audio-only interviews skip the camera and its consent.
    session = { ...fixture, recording_required: false };
    await open();
    await button("Next").click();
    assert(await page.getByRole("checkbox").count() === 1, "Audio-only interviews ask for one consent");
    await page.getByRole("checkbox").check();
    await button("Next").click();
    await visible("Can we hear you?");
    assert(!(await page.evaluate(() => window.__candidateTest.constraints.video)), "Audio-only interviews never open the camera");
    await button("Next").click();
    await button("Play test sound").click();
    await button("I heard it").click();
    await start();
    assert(await page.getByText("Recording", { exact: true }).count() === 0, "Audio-only interviews show no recording indicator");
    await end();
    await page.getByRole("heading", { name: "Thanks, you’re all done" }).waitFor();

    // Reloaded active attempts have no reconnect/start action.
    session = { ...fixture, execution_status: "in_progress" };
    await open();
    assert((await notice()).includes("open in another tab"), "Reload explains the lost connection");
    assert(await button("Start interview").count() === 0, "Active attempt cannot restart on reload");
    assert(await page.evaluate(() => window.__candidateTest.mediaCalls) === 0, "Reload cannot capture media automatically");
    unauthorized = true;
    await page.getByRole("heading", { name: "This interview has closed" }).waitFor({ timeout: 8000 });
    unauthorized = false;

    for (const status of ["interrupted", "failed", "cancelled", "expired"]) {
      session = { ...fixture, execution_status: status };
      await open();
      await page.getByRole("heading", { name: "This interview has closed" }).waitFor();
      assert(await page.getByText("Thanks, you’re all done", { exact: true }).count() === 0, `${status} must not look successful`);
    }
    await screenshot("closed");
    assert(await page.evaluate(() => window.__candidateTest.sends) === 0, "No browser provider commands");
    assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
    return "PASS: wizard order and consent gating, permission retry, device reuse, audio-only interviewer, playback recovery, mute, connection and camera notices, stop retry/order, server clock/completion, audio-only interviews, reload, revocation, terminal outcomes, desktop/mobile layout; no provider calls.";
  } catch (error) {
    console.log(await page.locator("body").innerText());
    await screenshot("failure");
    throw error;
  } finally {
    page.off("pageerror", onError);
    await page.unroute(`${origin}/candidate/**`);
    await page.unroute("https://storage.test/**");
    await page.unroute(`${origin}/api/**`);
    await page.goto("about:blank");
  }
}
