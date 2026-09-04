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

// Both layouts carry their own copies of these controls.
const CONTROL_IDS = ['start', 'pause', 'stop', 'p-start', 'p-pause', 'p-stop'];
const setControlsEnabled = on => CONTROL_IDS.forEach(id => { $(id).disabled = !on; });

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
// After a Stop the belt coasts, and that coasting still changes the telemetry.
// Ignore run-inference until it settles or we'd bank the deceleration.
let ignoreRunUntil = 0;
let sessionEnded = true;  // next Start begins a fresh walk
let connWatch = null;     // periodic connection check

// Connect is meaningless while a treadmill is attached, and leaving it live
// invites a second connection attempt. The device button still switches units.
function setConnected(on) {
  connected = on;
  $('connect').disabled = on;
  $('connect').title = on ? 'Already connected' : 'Find and connect to a treadmill';
}

// The disconnect event is the primary signal, but a link can drop without one
// (adapter reset, treadmill powered off mid-session). Polling the Rust side
// keeps the button and the status pill honest.
const CONN_POLL_MS = 15000;

function watchConnection() {
  clearInterval(connWatch);
  connWatch = setInterval(async () => {
    if (!connected) return;
    try {
      if (!await TM.isConnected()) {
        log('connection check: link is down');
        onDisconnected();
      }
    } catch (e) {
      log(`connection check failed: ${errText(e)}`);
    }
  }, CONN_POLL_MS);
}

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
    if (!isRunning && Date.now() >= ignoreRunUntil) {
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
  // The strip is too narrow for a unit label; it lives in the tooltip.
  $('p-speed').textContent = toDisplay(target).toFixed(digits());
  $('p-speed').title = `target speed in ${unit}`;
  $('p-down').disabled = target <= speedRange.min + 1e-9;
  $('p-up').disabled = target >= speedRange.max - 1e-9;
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

// Both layouts show the walk clock, so update them together.
function showTime() {
  const t = fmtTime(Math.floor(walkedSec));
  $('m-time').textContent = t;
  $('p-time').textContent = t;
  renderOdo();
}

function renderGoal() {
  $('goal-val').textContent = goalMin || '–';
  $('goal-down').disabled = goalMin <= 0;
  $('goal-up').disabled = goalMin >= GOAL_MAX_MIN;
  $('goal-off').textContent = goalMin ? 'turn off' : 'off';
  $('goal-ctl').classList.toggle('done', goalHit);

  if (!goalMin) {
    $('goal-hint').textContent = 'No goal — walk as long as you like.';
    $('p-goal').textContent = '';
    return;
  }
  if (!walkStarted) {
    $('goal-hint').textContent = 'counts down once you press Start';
    $('p-goal').textContent = `/ ${goalMin}m`;
    return;
  }
  const remaining = goalMin * 60 - walkedSec;
  $('goal-hint').textContent = remaining > 0
    ? `${fmtTime(remaining)} remaining`
    : `goal reached, ${fmtTime(-remaining)} over`;
  $('p-goal').textContent = remaining > 0
    ? `${fmtTime(remaining)} left`
    : `+${fmtTime(-remaining)}`;
}

// Wall-clock delta rather than a fixed +1, so a throttled background tab
// still accumulates the right amount of time.
function tick() {
  const now = Date.now();

  // Checked every tick, not just while walking: the window is often left open
  // overnight, and "Today" would otherwise show yesterday until the next walk.
  if (rollDay()) renderOdo();

  // Telemetry frozen for several seconds means the belt isn't moving, whatever
  // the last status event claimed.
  if (isRunning && lastPayloadAt && now - lastPayloadAt > 4000) {
    isRunning = false;
    setState('idle', 'on');
    log('idle (telemetry stopped changing)');
  }

  if (isRunning) {
    walkStarted = true;
    if (lastTick !== null) addWalkTime((now - lastTick) / 1000);
    showTime();
    if (goalMin && !goalHit && walkedSec >= goalMin * 60) reachGoal();
  }
  lastTick = isRunning ? now : null;
  if (goalMin) renderGoal();
  saveSession();
  saveOdo();
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
  allowDeviceSync = false;
  localStorage.removeItem(SAVE_KEY);
  showTime();
  $('goal-alert').hidden = true;
  $('goal-ctl').classList.remove('done');
  document.title = 'WELLFIT TM Control';
  renderGoal();
}

// --- connect --------------------------------------------------------------

// --- modes ----------------------------------------------------------------

// Two window sizes: a floating strip for while you're walking, and a tall
// window that fits every control without scrolling.
// Heights are window heights, which on macOS include the titlebar — hence the
// headroom over the strip's own ~46px. fitHeight() corrects any shortfall.
const SIZES = {
  player: { w: 430, h: 96 },
  full:   { w: 380, h: 900 },
};

let mode = localStorage.getItem('tm-mode') === 'player' ? 'player' : 'full';

async function applyMode(next, { persist = true } = {}) {
  mode = next;
  if (persist) localStorage.setItem('tm-mode', mode);

  document.body.classList.toggle('mode-player', mode === 'player');
  document.body.classList.toggle('mode-full', mode === 'full');
  $('mode-toggle').textContent = mode === 'player' ? 'expand' : 'compact';

  const w = window.__TAURI__?.window?.getCurrentWindow?.();
  if (!w) return;
  const { w: width, h: height } = SIZES[mode];
  try {
    const LogicalSize = window.__TAURI__.dpi?.LogicalSize
      ?? window.__TAURI__.window?.LogicalSize;
    await w.setSize(new LogicalSize(width, height));
    // The strip is meant to float over other apps; the full window isn't.
    await w.setAlwaysOnTop(mode === 'player');
    if (mode === 'player') await fitStrip(w, LogicalSize, width, height);
  } catch (e) {
    log(`window resize failed: ${errText(e)}`);
  }
}

// Whether setSize counts the titlebar varies by platform, so rather than
// guessing, measure what the content actually got and grow if it was clipped.
async function fitStrip(w, LogicalSize, width, height) {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const bar = $('player-bar');
  const shortH = Math.ceil(bar.getBoundingClientRect().height + 14 - window.innerHeight);
  const shortW = Math.ceil(bar.scrollWidth + 14 - window.innerWidth);
  if (shortH > 0 || shortW > 0) {
    log(`player strip clipped (${shortW}x${shortH}px), growing window`);
    await w.setSize(new LogicalSize(
      width + Math.max(0, shortW),
      height + Math.max(0, shortH)));
  }
}

// --- odometers ------------------------------------------------------------

// Three tiers over the same walking time:
//   walkedSec  this walk, cleared by Stop
//   tripSec    manual odometer, cleared only by the reset button
//   todaySec   rolls over at local midnight
//   totalSec   all time, never cleared automatically
const num = v => Number(v) || 0;
const dayKey = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local

let tripSec = num(localStorage.getItem('tm-trip-sec'));
let totalSec = num(localStorage.getItem('tm-total-sec'));
let todaySec = num(localStorage.getItem('tm-today-sec'));
let todayOn = localStorage.getItem('tm-today-date') || dayKey();

// Compact for long spans: "1h 20m" reads better than "80:12" on an odometer.
function fmtOdo(seconds) {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

function saveOdo() {
  localStorage.setItem('tm-trip-sec', String(Math.round(tripSec)));
  localStorage.setItem('tm-total-sec', String(Math.round(totalSec)));
  localStorage.setItem('tm-today-sec', String(Math.round(todaySec)));
  localStorage.setItem('tm-today-date', todayOn);
}

// Every counter advances from the same delta, so they can't drift apart.
function addWalkTime(deltaSec) {
  if (!(deltaSec > 0)) return;
  rollDay();
  walkedSec += deltaSec;
  tripSec += deltaSec;
  todaySec += deltaSec;
  totalSec += deltaSec;
}

// Returns true if the day actually rolled, so callers can re-render.
function rollDay() {
  const today = dayKey();
  if (todayOn === today) return false;
  log(`new day (${today}): today's total reset`);
  todayOn = today;
  todaySec = 0;
  return true;
}

function renderOdo() {
  $('m-today').textContent = fmtOdo(todaySec);
  $('m-trip').textContent = fmtOdo(tripSec);
  $('m-total').textContent = fmtOdo(totalSec);
}

// --- theme ----------------------------------------------------------------

// Toggled from the native View > Light Mode menu item, which emits
// `ui:toggle-light`. Nothing in the interface controls this.
let light = localStorage.getItem('tm-light') === '1';

function applyTheme() {
  document.body.classList.toggle('light', light);
  localStorage.setItem('tm-light', light ? '1' : '0');
  // Keep the menu checkmark in step with the restored preference.
  window.__TAURI__?.core?.invoke('set_light_checked', { checked: light })
    .catch(e => log(`menu sync failed: ${errText(e)}`));
}

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
  sessionEnded = false;
  allowDeviceSync = true;

  // Assume the belt kept moving while the page was gone.
  const gapSec = (Date.now() - s.savedAt) / 1000;
  addWalkTime(gapSec);
  log(`restored mid-walk, credited ${Math.round(gapSec)}s gap`);

  if (goalHit) reachGoal();
  showTime();
  renderGoal();
}

// The treadmill's elapsed field is the real session clock, so once we can see
// it advancing we trust it over our reconstruction.
let syncedFromDevice = false;
// Only trusted when recovering a walk that was already in progress. After a
// local Start the device's elapsed field may still hold its previous session,
// which would undo the reset.
let allowDeviceSync = false;
function syncFromDevice() {
  if (!allowDeviceSync || syncedFromDevice || deviceElapsed === null || !isRunning) return;
  syncedFromDevice = true;
  const drift = deviceElapsed - walkedSec;
  if (Math.abs(drift) > 5) {
    log(`walk time ${fmtTime(Math.floor(walkedSec))} -> treadmill says ${fmtTime(deviceElapsed)}`);
    // The session clock is set absolutely here, so credit the same correction
    // to the odometers by hand or they'd fall behind it.
    if (drift > 0) { tripSec += drift; todaySec += drift; totalSec += drift; }
    walkedSec = deviceElapsed;
    showTime();
    if (goalMin && !goalHit && walkedSec >= goalMin * 60) reachGoal();
    renderGoal();
  }
}

// --- connect --------------------------------------------------------------

let tickTimer = null;

// Under Tauri this is a plain native connect — no chooser, no permission
// backend. In a browser it needs getDevices(), which is flag-gated.
async function autoConnect() {
  setState('scanning…');
  say('Looking for the treadmill…', '');
  try { audioCtx ??= new AudioContext(); } catch { /* needs a gesture, fine */ }
  try {
    await setUp(await TM.autoConnect());
  } catch (e) {
    setState('disconnected', 'err');
    log(`auto-connect failed: ${errText(e)}`);

    // No remembered device yet (or it's gone): look for it by name, and fall
    // back to the full list if that's not conclusive.
    return findOrPick();
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
  // The picker only exists in the full layout.
  if (mode !== 'full') applyMode('full', { persist: false });
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
  return showPicker();
}

async function setUp(info) {
  setConnected(true);
  watchConnection();
  speedRange = info.speedRange;
  log(`${info.name}: speed ${speedRange.min}–${speedRange.max} km/h step ${speedRange.step}`);

  target = speedRange.min;

  setState('connected', 'on');
  $('speed-ctl').hidden = false;
  $('goal-ctl').hidden = false;
  renderTarget();
  renderGoal();

  if (await command(OP.requestControl, [], 'Request control')) {
    setControlsEnabled(true);
    say(walkedSec > 0
      ? `Reconnected mid-walk at ${fmtTime(Math.floor(walkedSec))}.`
      : 'Ready. Get on the belt before pressing Start.', '');
  } else {
    // Keep Stop reachable regardless, in both layouts.
    $('stop').disabled = false;
    $('p-stop').disabled = false;
    say('Connected, but the treadmill refused control. Stop is still available.', 'err');
  }
}

function onDisconnected() {
  setConnected(false);
  isRunning = false;
  lastTick = null;
  pending?.resolve({ ok: false, reason: 'timeout' });
  pending = null;
  setState('disconnected', 'err');
  say('Treadmill disconnected. It keeps running — use its own panel to stop.', 'err');
  setControlsEnabled(false);
  $('speed-ctl').hidden = true;
  log('disconnected');
}

// --- wiring ---------------------------------------------------------------

$('connect').addEventListener('click', connect);
$('pick').addEventListener('click', showPicker);
$('picker-rescan').addEventListener('click', rescan);
$('picker-close').addEventListener('click', () => { $('picker').hidden = true; });
// Stop ends the session, so clear the walk clock without waiting for the
// treadmill's status event — it doesn't always send one.
async function stopWalk() {
  if (!await command(OP.stopPause, [0x01], 'Stop')) return;
  isRunning = false;
  lastTick = null;
  ignoreRunUntil = Date.now() + 8000;   // ride out the coast-down
  sessionEnded = true;
  resetWalk();
}

// A Stop ends the walk, so the next Start is a new one. Checked here rather
// than trusting the earlier reset to have survived the coast-down.
async function startWalk() {
  if (sessionEnded) resetWalk();
  ignoreRunUntil = 0;
  if (await command(OP.start, [], 'Start')) sessionEnded = false;
}

async function pauseWalk() {
  // Pause keeps the session, so nothing is cleared here.
  if (await command(OP.stopPause, [0x02], 'Pause')) ignoreRunUntil = Date.now() + 8000;
}

$('start').addEventListener('click', startWalk);
$('pause').addEventListener('click', pauseWalk);
$('stop').addEventListener('click', stopWalk);

$('trip-reset').addEventListener('click', () => {
  tripSec = 0;
  saveOdo();
  renderOdo();
  log('trip odometer reset');
});

$('speed-up').addEventListener('click', () => nudge(+1));
$('speed-down').addEventListener('click', () => nudge(-1));

// Player strip: same handlers, smaller buttons.
$('p-start').addEventListener('click', startWalk);
$('p-pause').addEventListener('click', pauseWalk);
$('p-stop').addEventListener('click', stopWalk);
$('p-up').addEventListener('click', () => nudge(+1));
$('p-down').addEventListener('click', () => nudge(-1));

$('mode-toggle').addEventListener('click', () => applyMode(mode === 'full' ? 'player' : 'full'));
$('p-time').addEventListener('click', () => applyMode('full'));
$('p-expand').addEventListener('click', () => applyMode('full'));

// Dismissed for good once acknowledged — but it stays in the README.
$('safety-dismiss').addEventListener('click', () => {
  $('safety').hidden = true;
  localStorage.setItem('tm-safety-ack', '1');
});
if (localStorage.getItem('tm-safety-ack')) $('safety').hidden = true;

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

log('transport: native BLE (btleplug)');
applyMode(mode, { persist: false });
applyTheme();
setConnected(false);
rollDay();
renderOdo();

// Runs regardless of connection: it owns the midnight rollover, not just the
// walk clock.
tickTimer = setInterval(tick, 1000);

window.__TAURI__?.event?.listen('ui:toggle-light', () => {
  light = !light;
  applyTheme();
  log(`theme: ${light ? 'light' : 'dark'}`);
});

TM.on('data', onData);
TM.on('status', onStatus);
TM.on('control', onControlResponse);
TM.on('disconnected', onDisconnected);
TM.on('error', m => { log(`ble error: ${m}`); say(m, 'err'); });

restoreSession();
autoConnect();
