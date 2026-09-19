// Run against the existing HTTPS dev server using Playwright CLI:
// playwright-cli --session candidate-presentation run-code --filename tests/browser/candidate-presentation.js
// All candidate requests and microphone/WebRTC APIs are mocked. No provider is contacted.
// Playwright CLI evaluates this file as a function expression.
// eslint-disable-next-line @typescript-eslint/no-unused-expressions
async (page) => {
  const origin = "https://interview-bot.test:3000";
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const visible = async (text) => page.getByText(text, { exact: true }).waitFor();
  const fixture = {
    job_title: "Social Media Intern", execution_status: "ready", duration_limit_seconds: 120,
    opens_at: "2026-01-01T00:00:00Z", last_start_at: "2027-01-01T00:00:00Z", transport: "webrtc",
  };
  let session = { ...fixture };
  let deadline = Date.now() + 120000;
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
    else if (path === "/candidate/session" && unauthorized) { status = 401; body = { error: { message: "Session unavailable" } }; }
    else if (path !== "/candidate/session") throw new Error(`Unexpected candidate request: ${path}`);
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  // Catch accidental restoration of any of the MVP's browser-authoritative routes.
  await page.route(`${origin}/api/**`, route => { errors.push(`Unexpected API request: ${route.request().url()}`); return route.abort(); });
  await page.addInitScript(() => {
    if (!navigator.mediaDevices || window.__candidateTest) return;
    const state = window.__candidateTest = { track: null, peer: null, sends: 0, mediaCalls: 0, denyMedia: false, blockPlayback: false };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      state.mediaCalls++;
      if (state.denyMedia) throw new DOMException("Microphone permission denied", "NotAllowedError");
      state.track = { enabled: true, stopped: false, stop() { this.stopped = true; } };
      return { getTracks: () => [state.track], getAudioTracks: () => [state.track] };
    } });
    window.confirm = () => true;
    window.RTCPeerConnection = class {
      constructor() { state.peer = this; this.connectionState = "new"; this.iceGatheringState = "complete"; }
      createDataChannel() { return { send() { state.sends++; throw new Error("Browser provider commands are forbidden"); } }; }
      addTrack() {}
      async createOffer() { return { type: "offer", sdp: "v=0\r\nsynthetic-offer" }; }
      async setLocalDescription(description) { this.localDescription = description; }
      async setRemoteDescription() {
        this.connectionState = "connected";
        this.onconnectionstatechange?.();
        this.ontrack?.({ streams: [new MediaStream()] });
      }
      close() { this.connectionState = "closed"; this.closed = true; }
    };
    HTMLMediaElement.prototype.play = async function() { if (state.blockPlayback) throw new DOMException("Playback blocked", "NotAllowedError"); };
    HTMLMediaElement.prototype.pause = function() {};
  });
  const open = async () => {
    await page.goto(`${origin}/join`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  };
  const start = async () => {
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Start interview", exact: true }).click();
    await visible("Connected");
  };
  const end = async () => {
    await page.getByRole("button", { name: "End interview", exact: true }).click();
  };
  const screenshot = async name => page.screenshot({ path: `output/playwright/candidate-${name}.png`, fullPage: true });
  const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Horizontal overflow");
  try {
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto("about:blank");
    await page.goto(`${origin}/join#synthetic-invitation`);
    await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
    await page.waitForFunction(() => window.location.hash === "");
    assert(!page.url().includes("#"), "Invitation fragment must be removed");
    assert(!calls.some(c => c.path.endsWith("exchange")), "Invitation must not exchange until Continue");
    await screenshot("welcome");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await visible("Before we begin");
    assert(await page.getByRole("button", { name: "Start interview", exact: true }).isDisabled(), "Consent must gate start");
    assert(await page.evaluate(() => window.__candidateTest.mediaCalls) === 0, "No microphone before consent/start");
    await screenshot("ready-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("ready-mobile");
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.evaluate(() => window.__candidateTest.denyMedia = true);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Start interview", exact: true }).click();
    await visible("Microphone permission denied");
    assert(!calls.some(c => c.path.endsWith("/start")), "Denied microphone cannot create an attempt");
    await page.evaluate(() => { window.__candidateTest.denyMedia = false; window.__candidateTest.blockPlayback = true; });
    await start();
    await page.getByRole("button", { name: "Enable sound", exact: true }).waitFor();
    await page.evaluate(() => window.__candidateTest.blockPlayback = false);
    await page.getByRole("button", { name: "Enable sound", exact: true }).click();
    await page.getByRole("button", { name: "Enable sound", exact: true }).waitFor({ state: "hidden" });
    const startCall = calls.find(c => c.path === "/candidate/start");
    assert(JSON.stringify(Object.keys(startCall.body).sort()) === JSON.stringify(["consent_version", "sdp"]), "Start may submit only consent and media offer");
    assert(startCall.body.consent_version === "transcript_v1", "Consent version retained");
    await page.getByRole("button", { name: "Mute microphone", exact: true }).click();
    assert(await page.evaluate(() => !window.__candidateTest.track.enabled), "Mute must disable capture");
    await visible("Microphone muted");
    await page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
    assert(await page.evaluate(() => window.__candidateTest.track.enabled), "Unmute must enable capture");
    await page.getByLabel("Time remaining", { exact: true }).waitFor();
    await screenshot("active-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await screenshot("active-mobile");
    await page.evaluate(() => { const peer = window.__candidateTest.peer; peer.connectionState = "disconnected"; peer.onconnectionstatechange(); });
    await visible("Connection needed");
    assert(await page.getByRole("button", { name: "Mute microphone", exact: true }).isDisabled(), "Lost connection cannot show active microphone controls");
    await page.evaluate(() => { const peer = window.__candidateTest.peer; peer.connectionState = "connected"; peer.onconnectionstatechange(); });
    await visible("Connected");
    stopFails = true;
    await end();
    await visible("Could not confirm the end request. Your microphone is off. Please retry ending the interview.");
    assert(await page.evaluate(() => !window.__candidateTest.track.enabled && window.__candidateTest.track.stopped), "Unconfirmed stop must release capture");
    assert(await page.getByLabel("Time remaining", { exact: true }).count() === 0, "No stale countdown after stop");
    stopFails = false;
    await end();
    await page.getByRole("heading", { name: "Thank you for your time." }).waitFor();
    assert(await page.getByRole("button", { name: "Start interview", exact: true }).count() === 0, "Completed interview cannot restart");
    await screenshot("completed-mobile");

    // Stop must await authoritative terminal state before releasing the peer.
    session = { ...fixture };
    holdStop = true;
    await open();
    await start();
    await end();
    await page.getByText("Ending your interview…", { exact: true }).first().waitFor();
    assert(await page.evaluate(() => !window.__candidateTest.track.enabled && !window.__candidateTest.peer.closed), "Keep transport alive but disable mic during stop confirmation");
    session = { ...session, execution_status: "completed" };
    await page.getByRole("heading", { name: "Thank you for your time." }).waitFor();
    assert(await page.evaluate(() => window.__candidateTest.peer.closed), "Release transport after authoritative completion");
    holdStop = false;

    // Clock reaching zero is presentation only; the service decides completion.
    session = { ...fixture };
    deadline = Date.now() - 1000;
    await open();
    await start();
    await visible("Time is up. Finishing…");
    assert(await page.getByRole("heading", { name: "Thank you for your time." }).count() === 0, "Browser timer cannot mark completion");
    session = { ...session, execution_status: "completed" };
    await page.getByRole("heading", { name: "Thank you for your time." }).waitFor({ timeout: 8000 });
    assert(await page.evaluate(() => window.__candidateTest.track.stopped), "Server completion must release microphone");

    // Reloaded active attempts have no reconnect/start action.
    session = { ...fixture, execution_status: "in_progress" };
    await open();
    await visible("Connection needed");
    assert(await page.getByRole("button", { name: "Start interview", exact: true }).count() === 0, "Active attempt cannot restart on reload");
    assert(await page.evaluate(() => window.__candidateTest.mediaCalls) === 0, "Reload cannot capture microphone automatically");
    unauthorized = true;
    await page.getByRole("heading", { name: "Your interview has closed." }).waitFor({ timeout: 8000 });
    unauthorized = false;

    for (const status of ["interrupted", "failed", "cancelled", "expired"]) {
      session = { ...fixture, execution_status: status };
      await open();
      await page.getByRole("heading", { name: "Your interview has closed." }).waitFor();
      assert(await page.getByText("Interview complete", { exact: true }).count() === 0, `${status} must not look successful`);
    }
    await screenshot("interrupted-mobile");
    assert(await page.evaluate(() => window.__candidateTest.sends) === 0, "No browser provider commands");
    assert(errors.length === 0, `Browser errors: ${errors.join("; ")}`);
    return "PASS: consent, microphone denial, playback recovery, mute, loss/recovery, stop retry/order, server clock/completion, reload, revocation, terminal outcomes, desktop/mobile layout; no provider calls.";
  } catch (error) {
    console.log(await page.locator("body").innerText());
    await screenshot("failure");
    throw error;
  } finally {
    page.off("pageerror", onError);
    await page.unroute(`${origin}/candidate/**`);
    await page.unroute(`${origin}/api/**`);
    await page.goto("about:blank");
  }
}
