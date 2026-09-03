// WELLFIT TM treadmill control over FTMS.
// Device specifics confirmed by discover.html on this unit:
//   - Speed range 0.96-6.11 km/h. 0x2AD4 advertises a 0.32 km/h increment but
//     the unit accepts finer targets; see STEP_DISPLAY.
//   - Incline is a manual mechanical adjustment on this treadmill: the feature
//     bitfield claims inclination support, 0x2AD5 reads all zeros, and there is
//     no motor. No incline control here by design. Same story for resistance.
//   - Treadmill Data sets reserved flag bit 13 and appends 3 trailing bytes;
//     we decode the spec fields and ignore the tail.
//   - Idle packets repeat a stale speed (1.01 km/h), so running state comes
//     from Fitness Machine Status / Training Status, never from speed.

// BLE lives in ble.js (TM): native btleplug under Tauri, Web Bluetooth in a
// browser. Everything below is transport-agnostic decoding and UI.

const OP = {
  requestControl: 0x00,
  reset:          0x01,
  setSpeed:       0x02,
  start:          0x07,
  stopPause:      0x08,
};

const RESULT = {
  0x01: 'Success', 0x02: 'Op code not supported', 0x03: 'Invalid parameter',
  0x04: 'Operation failed', 0x05: 'Control not permitted',
};

const KMH_PER_MPH = 1.609344;

const $ = id => document.getElementById(id);

let connected = false;
let speedRange = null;   // { min, max, step } in km/h
let target = null;       // current target speed, km/h, snapped to grid
let useMph = false;
let pending = null;      // { opcode, resolve } for the in-flight command
let lastSpeed = null;    // most recent reported speed, km/h
let isRunning = false;   // from Fitness Machine Status, never inferred from speed
let deviceElapsed = null; // treadmill's own elapsed seconds
let lastPayload = null;   // last telemetry packet, to detect a frozen (idle) feed
let lastPayloadAt = 0;

// --- logging / status -----------------------------------------------------

function log(s) {
  const el = $('log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${s}\n`;
  el.scrollTop = el.scrollHeight;
}

function say(text, kind = '') {
  $('msg').textContent = text;
  $('msg').className = `msg ${kind}`;
}

function setState(text, kind = '') {
  $('state').textContent = text;
  $('state').className = `pill ${kind}`;
}

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ');

// Tauri commands reject with a plain string, DOM APIs with an Error. Without
// this, Rust-side failures surfaced as "undefined".
const errText = e =>
  typeof e === 'string' ? e : e?.message || JSON.stringify(e) || 'unknown error';

// --- control point --------------------------------------------------------

// One command at a time: the control point only tracks a single outstanding
// request, and firing a second write before the indication lands loses it.
async function command(opcode, params = [], label = null) {
  const name = label || `0x${opcode.toString(16).padStart(2, '0')}`;
  if (!connected) { say('Not connected.', 'err'); return false; }
  if (pending) { say(`Busy: ${pending.name} still pending.`, 'err'); return false; }

  const bytes = new Uint8Array([opcode, ...params]);
  log(`-> ${name}: ${hex(bytes)}`);

  const wait = new Promise(resolve => { pending = { opcode, name, resolve }; });
  const timer = setTimeout(() => {
    if (pending?.opcode === opcode) { pending.resolve({ ok: false, reason: 'timeout' }); pending = null; }
  }, 4000);

  try {
    await TM.write(bytes);
  } catch (e) {
    clearTimeout(timer);
    pending = null;
    log(`   write failed: ${e.message}`);
    say(`${name} failed: ${e.message}`, 'err');
    return false;
  }

  const res = await wait;
  clearTimeout(timer);

  if (res.ok) { say(`${name} ok`, 'ok'); return true; }

  if (res.reason === 'timeout') {
    say(`${name}: no response from treadmill.`, 'err');
    log(`   no indication within 4s`);
  } else if (res.code === 0x05) {
    // Lost control (idle timeout or the panel took over). Re-acquire once.
    say(`${name}: control not permitted — re-requesting control.`, 'err');
    log(`   control lost, re-requesting`);
    if (opcode !== OP.requestControl && await command(OP.requestControl, [], 'Request control'))
      say(`Control re-acquired. Try ${name} again.`, '');
  } else {
    say(`${name}: ${res.text}`, 'err');
  }
  return false;
}

function onControlResponse(b) {
  log(`<- ${hex(b)}`);
  if (b[0] !== 0x80) return;                    // not a response packet

  const code = b[2];
  const text = RESULT[code] ?? `unknown result 0x${code.toString(16)}`;
  log(`   response to 0x${b[1].toString(16).padStart(2, '0')}: ${text}`);

  if (!pending) return;
  if (pending.opcode !== b[1]) { log(`   (ignored: expected 0x${pending.opcode.toString(16)})`); return; }
  pending.resolve({ ok: code === 0x01, code, text });
  pending = null;
}

// --- telemetry ------------------------------------------------------------

// Coerces to whole seconds: walkedSec accumulates as a float, so callers
// would otherwise leak values like "12:26.000999999999976".
function fmtTime(seconds) {
  const t = Math.max(0, Math.round(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

// Treadmill Data (0x2ACD). Fields appear in flag order; bit 0 is inverted
// (0 means Instantaneous Speed is present).
function onData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const u8 = () => dv.getUint8(o++);
  const u16le = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const s16le = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const u24le = () => {
    const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    o += 3; return v;
  };

  let speed = null, dist = null, hr = null, kcal = null, elapsed = null;

  try {
    if (!(flags & 1))      speed = u16le() / 100;
    if (flags & (1 << 1))  u16le();                       // average speed
    if (flags & (1 << 2))  dist = u24le();
    if (flags & (1 << 3)) { s16le(); s16le(); }            // incline + ramp angle
    if (flags & (1 << 4)) { u16le(); u16le(); }           // elevation gain
    if (flags & (1 << 5))  u8();                          // pace
    if (flags & (1 << 6))  u8();                          // average pace
    if (flags & (1 << 7)) { kcal = u16le(); u16le(); u8(); }
    if (flags & (1 << 8))  hr = u8();
    if (flags & (1 << 9))  u8();                          // METs
    if (flags & (1 << 10)) elapsed = u16le();
  } catch {
    log(`data packet short: ${hex(new Uint8Array(dv.buffer))}`);
    return;
  }

  if (speed !== null) {
    lastSpeed = speed;
    $('m-speed').textContent = toDisplay(speed).toFixed(1);
  }
  if (dist !== null) $('m-dist').textContent = dist;
  // The Time metric shows our own walk timer (see tick()), so the device's
  // elapsed field is kept for reference only.
  if (elapsed !== null) deviceElapsed = elapsed;
  if (hr !== null && hr > 0) { $('m-hr-wrap').hidden = false; $('m-hr').textContent = hr; }
  if (kcal !== null && kcal > 0) { $('m-kcal-wrap').hidden = false; $('m-kcal').textContent = kcal; }

  // 0x2ADA only fires on transitions, so after a reload we'd have no idea
  // whether the belt is moving. Idle packets are byte-identical repeats, so a
  // changing payload means it's running. tick() clears this when it goes stale.
  const raw = hex(new Uint8Array(dv.buffer));
  if (raw !== lastPayload) {
    lastPayload = raw;
    lastPayloadAt = Date.now();
    if (!isRunning) {
      isRunning = true;
      setState('running', 'on');
      log('running (inferred from changing telemetry)');
    }
    syncFromDevice();
  }
}

// Fitness Machine Status (0x2ADA) is the trustworthy source of run state.
// Op codes per FTMS 4.17 - note 0x02 carries a parameter distinguishing
// stop (0x01) from pause (0x02), and these are NOT the control point opcodes.
const STATUS = {
  0x01: 'reset',
  0x02: 'stopped/paused by user',
  0x03: 'stopped by safety key',
  0x04: 'started or resumed by user',
  0x05: 'target speed changed',
  0x06: 'target incline changed',
  0xff: 'control permission lost',
};

function onStatus(b) {
  const op = b[0];
  log(`status: ${STATUS[op] ?? `0x${op.toString(16)}`} (${hex(b)})`);

  switch (op) {
    case 0x01:
      isRunning = false;
      setState('reset', 'on');
      resetWalk();
      break;
    case 0x02: {
      // Parameter: 0x01 = stopped, 0x02 = paused.
      const paused = b[1] === 0x02;
      isRunning = false;
      setState(paused ? 'paused' : 'stopped', 'on');
      // A pause keeps the accumulated time; a full stop ends the session.
      if (!paused) resetWalk();
      break;
    }
    case 0x03:
      isRunning = false;
      setState('safety key', 'err');
      say('Stopped by safety key.', 'err');
      break;
    case 0x04:
      isRunning = true;
      setState('running', 'on');
      break;
    case 0xff:
      setState('control lost', 'err');
      say('Treadmill took back control — re-requesting.', 'err');
      command(OP.requestControl, [], 'Request control');
      break;
  }
}

// --- speed grid -----------------------------------------------------------

// 0x2AD4 advertises a 0.32 km/h minimum increment (0.2 mph), but the wire
// format is 0.01 km/h and this board accepts finer targets, quantizing
// internally. So we step 0.1 in whichever unit is on screen and let the
// treadmill round; checkQuantization() reports it when it does.
const STEP_DISPLAY = 0.1;

const toDisplay = kmh => useMph ? kmh / KMH_PER_MPH : kmh;
const toKmh = shown => useMph ? shown * KMH_PER_MPH : shown;
const digits = () => useMph ? 1 : 2;

// Snap to the 0.1 grid of the displayed unit, clamped to the device's limits.
function snap(kmh) {
  const { min, max } = speedRange;
  const shown = Math.round(toDisplay(kmh) / STEP_DISPLAY) * STEP_DISPLAY;
  return +Math.min(max, Math.max(min, toKmh(shown))).toFixed(2);
}

function renderTarget() {
  const unit = useMph ? 'mph' : 'km/h';
  $('target-val').textContent = toDisplay(target).toFixed(digits());
  $('target-unit').textContent = unit;
  $('m-speed-unit').textContent = unit;
  $('speed-down').disabled = target <= speedRange.min + 1e-9;
  $('speed-up').disabled = target >= speedRange.max - 1e-9;

  const f = v => toDisplay(v).toFixed(digits());
  $('range-hint').textContent =
    `${f(speedRange.min)} – ${f(speedRange.max)} ${unit}, ` +
    `${STEP_DISPLAY.toFixed(1)} ${unit} per press`;
}

// Step from the on-screen value so repeated presses can't accumulate
// float drift, and so a press always moves by exactly one display step.
function nudge(direction) {
  const shown = Math.round(toDisplay(target) / STEP_DISPLAY) * STEP_DISPLAY;
  return setSpeed(toKmh(shown + direction * STEP_DISPLAY));
}

async function setSpeed(kmh) {
  const next = snap(kmh);
  if (Math.abs(next - target) < 1e-9) return;   // already there, don't spend a command
  const raw = Math.round(next * 100);
  const ok = await command(OP.setSpeed, [raw & 0xff, (raw >> 8) & 0xff],
                           `Set speed ${toDisplay(next).toFixed(digits())} ${useMph ? 'mph' : 'km/h'}`);
  if (ok) {
    target = next;
    renderTarget();
    checkQuantization(next);
  }
}

// The treadmill can accept a target and then run at its own nearest step.
// Compare once the belt has had time to settle, and only while it's moving.
let quantizeTimer = null;
function checkQuantization(requested) {
  clearTimeout(quantizeTimer);
  quantizeTimer = setTimeout(() => {
    if (lastSpeed === null || !isRunning) return;
    const off = Math.abs(lastSpeed - requested);
    if (off > 0.05) {
      const u = useMph ? 'mph' : 'km/h';
      say(`Treadmill rounded ${toDisplay(requested).toFixed(digits())} to ` +
          `${toDisplay(lastSpeed).toFixed(digits())} ${u}.`, '');
      log(`quantized: asked ${requested.toFixed(2)} km/h, running ${lastSpeed.toFixed(2)} km/h`);
    }
  }, 3000);
}

// --- walk goal ------------------------------------------------------------

// The goal counts our own accumulated running time rather than the treadmill's
// 0x2ACD elapsed field, because that field doesn't reliably reset between
// sessions and holds a stale value while idle. Accumulating only while the
// status says "running" also means a pause correctly stops the clock.
const GOAL_STEP_MIN = 5;
const GOAL_MAX_MIN = 120;

let goalMin = 30;        // 0 = off
let walkedSec = 0;
let goalHit = false;
let walkStarted = false; // the goal stays unarmed until the belt actually moves
let lastTick = null;     // ms timestamp of the previous tick while running

function renderGoal() {
  $('goal-val').textContent = goalMin || '–';
  $('goal-down').disabled = goalMin <= 0;
  $('goal-up').disabled = goalMin >= GOAL_MAX_MIN;
  $('goal-off').textContent = goalMin ? 'turn off' : 'off';
  $('goal-ctl').classList.toggle('done', goalHit);

  if (!goalMin) {
    $('goal-hint').textContent = 'No goal — walk as long as you like.';
    return;
  }
  if (!walkStarted) {
    $('goal-hint').textContent = `counts down once you press Start`;
    return;
  }
  const remaining = goalMin * 60 - walkedSec;
  $('goal-hint').textContent = remaining > 0
    ? `${fmtTime(remaining)} remaining`
    : `goal reached, ${fmtTime(-remaining)} over`;
}

// Wall-clock delta rather than a fixed +1, so a throttled background tab
// still accumulates the right amount of time.
function tick() {
  const now = Date.now();

  // Telemetry frozen for several seconds means the belt isn't moving, whatever
  // the last status event claimed.
  if (isRunning && lastPayloadAt && now - lastPayloadAt > 4000) {
    isRunning = false;
    setState('idle', 'on');
    log('idle (telemetry stopped changing)');
  }

  if (isRunning) {
    walkStarted = true;
    if (lastTick !== null) walkedSec += (now - lastTick) / 1000;
    $('m-time').textContent = fmtTime(Math.floor(walkedSec));
    if (goalMin && !goalHit && walkedSec >= goalMin * 60) reachGoal();
  }
  lastTick = isRunning ? now : null;
  if (goalMin) renderGoal();
  saveSession();
}

// Alert only. Stopping stays a deliberate manual action so an unattended
// timer can never yank the belt out from under you.
function reachGoal() {
  goalHit = true;
  $('goal-alert-text').textContent = `${goalMin} min done — press STOP when you're ready.`;
  $('goal-alert').hidden = false;
  $('goal-ctl').classList.add('done');
  document.title = '✅ goal reached — WELLFIT TM';
  log(`goal reached at ${fmtTime(Math.floor(walkedSec))}`);
  beep();
}

let audioCtx = null;
function beep() {
  if (!audioCtx) return;
  // Three short chirps, audible over a running belt without being startling.
  for (let i = 0; i < 3; i++) {
    const t = audioCtx.currentTime + i * 0.45;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.30);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
  }
}

function resetWalk() {
  walkedSec = 0;
  goalHit = false;
  walkStarted = false;
  lastTick = null;
  syncedFromDevice = false;
  localStorage.removeItem(SAVE_KEY);
  $('m-time').textContent = '0:00';
  $('goal-alert').hidden = true;
  $('goal-ctl').classList.remove('done');
  document.title = 'WELLFIT TM Control';
  renderGoal();
}

// --- connect --------------------------------------------------------------

// --- session persistence --------------------------------------------------

// A reload shouldn't lose the walk in progress, so the timer state is mirrored
// to localStorage. The treadmill keeps running through a page reload, so if it
// was running when we went away we credit the wall-clock gap; the device's own
// session clock then corrects us on reconnect (see syncFromDevice).
const SAVE_KEY = 'tm-session';
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function saveSession() {
  localStorage.setItem(SAVE_KEY, JSON.stringify({
    goalMin, walkedSec, goalHit, isRunning, savedAt: Date.now(),
  }));
}

function restoreSession() {
  let s;
  try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return; }
  if (!s || Date.now() - s.savedAt > STALE_AFTER_MS) return;

  // The goal setting is always worth keeping. The walk itself is only
  // resumed if the belt was actually moving when we went away — otherwise a
  // finished session would come back glowing "goal reached" before you'd
  // taken a step.
  goalMin = s.goalMin ?? goalMin;

  if (!s.isRunning) {
    renderGoal();
    return;
  }

  walkedSec = s.walkedSec ?? 0;
  goalHit = !!s.goalHit;
  walkStarted = true;

  // Assume the belt kept moving while the page was gone.
  const gapSec = (Date.now() - s.savedAt) / 1000;
  walkedSec += gapSec;
  log(`restored mid-walk, credited ${Math.round(gapSec)}s gap`);

  if (goalHit) reachGoal();
  $('m-time').textContent = fmtTime(Math.floor(walkedSec));
  renderGoal();
}

// The treadmill's elapsed field is the real session clock, so once we can see
// it advancing we trust it over our reconstruction.
let syncedFromDevice = false;
function syncFromDevice() {
  if (syncedFromDevice || deviceElapsed === null || !isRunning) return;
  syncedFromDevice = true;
  const drift = deviceElapsed - walkedSec;
  if (Math.abs(drift) > 5) {
    log(`walk time ${fmtTime(Math.floor(walkedSec))} -> treadmill says ${fmtTime(deviceElapsed)}`);
    walkedSec = deviceElapsed;
    $('m-time').textContent = fmtTime(Math.floor(walkedSec));
    if (goalMin && !goalHit && walkedSec >= goalMin * 60) reachGoal();
    renderGoal();
  }
}

// --- connect --------------------------------------------------------------

let tickTimer = null;

// Under Tauri this is a plain native connect — no chooser, no permission
// backend. In a browser it needs getDevices(), which is flag-gated.
async function autoConnect() {
  setState(TM.isTauri ? 'scanning…' : 'reconnecting…');
  say(TM.isTauri ? 'Looking for the treadmill…' : '', '');
  try { audioCtx ??= new AudioContext(); } catch { /* needs a gesture, fine */ }
  try {
    await setUp(await TM.autoConnect());
  } catch (e) {
    const msg = errText(e);
    setState('disconnected', 'err');
    log(`auto-connect failed: ${msg}`);

    // No remembered device yet (or it's gone): look for it by name, and fall
    // back to the full list if that's not conclusive.
    if (TM.canScan) return findOrPick();

    say(msg === 'no-getdevices'
      ? 'Press Connect. (Silent reconnect needs chrome://flags/#enable-web-bluetooth-new-permissions-backend)'
      : `${msg} — press Connect to retry.`, 'err');
  }
}

// --- device picker --------------------------------------------------------

// Native BLE has no OS-provided chooser, so we supply one: scan, list, let the
// user pick, remember the choice.
const NAME_HINTS = /wellfit|tm/i;
const isLikely = d => d.ftms || NAME_HINTS.test(d.name);

// Auto-connect only on an unambiguous hint match. Zero or several candidates
// means we can't know, so the list goes up instead of us picking for you.
async function findOrPick() {
  say('Looking for your treadmill…', '');
  setState('scanning…');
  let devices;
  try {
    devices = await TM.scan(6);
  } catch (e) {
    setState('disconnected', 'err');
    say(`Scan failed: ${errText(e)}`, 'err');
    return;
  }

  const likely = devices.filter(isLikely);
  log(`scan: ${devices.length} named device(s), ${likely.length} likely`);

  if (likely.length === 1) {
    log(`auto-selected ${likely[0].name}`);
    return choose(likely[0]);
  }

  openPicker(devices, likely.length
    ? `${likely.length} possible matches — pick yours.`
    : 'No obvious treadmill. Pick from everything nearby.');
}

async function showPicker() {
  $('picker').hidden = false;
  await rescan();
}

async function rescan() {
  const list = $('picker-list');
  list.innerHTML = '<div class="picker-empty">Scanning…</div>';
  $('picker-rescan').disabled = true;
  try {
    openPicker(await TM.scan(6));
  } catch (e) {
    list.innerHTML = `<div class="picker-empty">Scan failed: ${escapeHtml(errText(e))}</div>`;
  } finally {
    $('picker-rescan').disabled = false;
  }
}

function openPicker(devices, note = '') {
  $('picker').hidden = false;
  setState('disconnected');
  if (note) say(note, '');

  const list = $('picker-list');
  list.innerHTML = '';
  if (!devices.length) {
    list.innerHTML = '<div class="picker-empty">Nothing found. Wake the treadmill and scan again.</div>';
    return;
  }

  // Likely candidates first, then strongest signal.
  const sorted = [...devices].sort((a, b) =>
    (isLikely(b) - isLikely(a)) || ((b.rssi ?? -999) - (a.rssi ?? -999)));

  for (const d of sorted) {
    const btn = document.createElement('button');
    const meta = [d.ftms ? 'FTMS' : null, d.rssi != null ? `${d.rssi} dBm` : null]
      .filter(Boolean).join(' · ');
    btn.innerHTML =
      `<span class="dev-name">${escapeHtml(d.name)}</span>` +
      `<span class="dev-meta ${isLikely(d) ? 'ftms' : ''}">${escapeHtml(meta)}</span>`;
    btn.addEventListener('click', () => choose(d));
    list.appendChild(btn);
  }
}

const escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function choose(dev) {
  $('picker').hidden = true;
  setState('connecting…');
  say(`Connecting to ${dev.name}…`, '');
  try {
    await setUp(await TM.connect(dev.id));
  } catch (e) {
    const msg = errText(e);
    setState('disconnected', 'err');
    say(msg, 'err');
    log(`connect to ${dev.name} failed: ${msg}`);
  }
}

async function connect() {
  // Built here because the click is a user gesture; audio started later
  // without one gets blocked by autoplay policy.
  try { audioCtx ??= new AudioContext(); } catch { /* no audio, banner only */ }

  // With native BLE, Connect means "show me what's out there".
  if (TM.canScan) return showPicker();

  $('connect').disabled = true;
  setState('connecting…');
  try {
    await setUp(await TM.connect());
  } catch (e) {
    const msg = errText(e);
    setState('disconnected', 'err');
    say(e.name === 'NotFoundError' ? 'No device selected.' : msg, 'err');
    log(`connect failed: ${msg}`);
  } finally {
    $('connect').disabled = false;
  }
}

async function setUp(info) {
  connected = true;
  speedRange = info.speedRange;
  log(`${info.name}: speed ${speedRange.min}–${speedRange.max} km/h step ${speedRange.step}`);

  target = speedRange.min;

  setState('connected', 'on');
  $('speed-ctl').hidden = false;
  $('goal-ctl').hidden = false;
  renderTarget();
  if (!tickTimer) tickTimer = setInterval(tick, 1000);
  renderGoal();

  if (await command(OP.requestControl, [], 'Request control')) {
    for (const id of ['start', 'pause', 'stop']) $(id).disabled = false;
    say(walkedSec > 0
      ? `Reconnected mid-walk at ${fmtTime(Math.floor(walkedSec))}.`
      : 'Ready. Get on the belt before pressing Start.', '');
  } else {
    $('stop').disabled = false;   // keep Stop reachable regardless
    say('Connected, but the treadmill refused control. Stop is still available.', 'err');
  }
}

function onDisconnected() {
  connected = false;
  isRunning = false;
  lastTick = null;
  pending?.resolve({ ok: false, reason: 'timeout' });
  pending = null;
  setState('disconnected', 'err');
  say('Treadmill disconnected. It keeps running — use its own panel to stop.', 'err');
  for (const id of ['start', 'pause', 'stop']) $(id).disabled = true;
  $('speed-ctl').hidden = true;
  log('disconnected');
}

// --- wiring ---------------------------------------------------------------

$('connect').addEventListener('click', connect);
$('pick').addEventListener('click', showPicker);
$('pick').hidden = !TM.canScan;
$('picker-rescan').addEventListener('click', rescan);
$('picker-close').addEventListener('click', () => { $('picker').hidden = true; });
$('start').addEventListener('click', () => command(OP.start, [], 'Start'));
$('pause').addEventListener('click', () => command(OP.stopPause, [0x02], 'Pause'));
$('stop').addEventListener('click', () => command(OP.stopPause, [0x01], 'Stop'));

$('speed-up').addEventListener('click', () => nudge(+1));
$('speed-down').addEventListener('click', () => nudge(-1));

// Extending the goal past the current walk time re-arms the alert, so
// "give me 5 more minutes" works without reconnecting.
function setGoal(minutes) {
  goalMin = Math.min(GOAL_MAX_MIN, Math.max(0, minutes));
  if (goalMin && walkedSec < goalMin * 60) {
    goalHit = false;
    $('goal-alert').hidden = true;
    document.title = 'WELLFIT TM Control';
  }
  renderGoal();
}

$('goal-up').addEventListener('click', () => setGoal(goalMin + GOAL_STEP_MIN));
$('goal-down').addEventListener('click', () => setGoal(goalMin - GOAL_STEP_MIN));

$('goal-off').addEventListener('click', () => {
  goalMin = 0;
  $('goal-alert').hidden = true;
  document.title = 'WELLFIT TM Control';
  renderGoal();
});

$('goal-dismiss').addEventListener('click', () => {
  $('goal-alert').hidden = true;
  document.title = 'WELLFIT TM Control';
});

$('unit-toggle').addEventListener('click', () => {
  useMph = !useMph;
  $('unit-toggle').textContent = useMph ? 'show km/h' : 'show mph';
  renderTarget();
});

// Save on the way out too — tick() only fires once a second.
addEventListener('pagehide', saveSession);
document.addEventListener('visibilitychange', saveSession);

log(TM.isTauri ? 'transport: native BLE (btleplug)' : 'transport: Web Bluetooth');

TM.on('data', onData);
TM.on('status', onStatus);
TM.on('control', onControlResponse);
TM.on('disconnected', onDisconnected);
TM.on('error', m => { log(`ble error: ${m}`); say(m, 'err'); });

if (!TM.isTauri && !navigator.bluetooth) {
  say('Web Bluetooth unavailable. Use desktop Chrome or Edge over http://localhost.', 'err');
  $('connect').disabled = true;
} else {
  restoreSession();
  autoConnect();
}
