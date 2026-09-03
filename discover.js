// FTMS discovery: enumerate services, decode the feature bitfield and supported
// ranges, and sample Treadmill Data notifications. Read-only except the probes.

const u16 = n => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

const FTMS = u16(0x1826);
const C = {
  feature:      u16(0x2acc),
  treadmillData:u16(0x2acd),
  trainingStat: u16(0x2ad3),
  speedRange:   u16(0x2ad4),
  inclRange:    u16(0x2ad5),
  resRange:     u16(0x2ad6),
  hrRange:      u16(0x2ad7),
  powerRange:   u16(0x2ad8),
  controlPoint: u16(0x2ad9),
  status:       u16(0x2ada),
};

// Everything the nRF scan saw, so getPrimaryServices() can return it all.
const OPTIONAL_SERVICES = [
  FTMS, u16(0x180a), u16(0xf8c0), u16(0xfff0), u16(0xae00),
  '59554c55-8000-6666-8888-4d4552414348',
  '00010203-0405-0607-0809-0a0b0c0d1912',
];

const MACHINE_FEATURES = [
  'Average Speed', 'Cadence', 'Total Distance', 'Inclination', 'Elevation Gain',
  'Pace', 'Step Count', 'Resistance Level', 'Stride Count', 'Expended Energy',
  'Heart Rate Measurement', 'Metabolic Equivalent', 'Elapsed Time', 'Remaining Time',
  'Power Measurement', 'Force on Belt and Power Output', 'User Data Retention',
];

const TARGET_FEATURES = [
  'Speed Target Setting', 'Inclination Target Setting', 'Resistance Target Setting',
  'Power Target Setting', 'Heart Rate Target Setting', 'Targeted Expended Energy',
  'Targeted Step Number', 'Targeted Stride Number', 'Targeted Distance',
  'Targeted Training Time', 'Targeted Time in Two HR Zones',
  'Targeted Time in Three HR Zones', 'Targeted Time in Five HR Zones',
  'Indoor Bike Simulation Parameters', 'Wheel Circumference Configuration',
  'Spin Down Control', 'Targeted Cadence Configuration',
];

const RESULT_CODES = {
  0x01: 'Success', 0x02: 'Op Code not supported', 0x03: 'Invalid Parameter',
  0x04: 'Operation Failed', 0x05: 'Control Not Permitted',
};

const lines = [];
const logEl = document.getElementById('log');

function log(s = '') {
  lines.push(s);
  logEl.textContent = lines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

const hex = dv => [...new Uint8Array(dv.buffer ?? dv)]
  .map(b => b.toString(16).padStart(2, '0')).join(' ');

const bits = (v, names) =>
  names.map((n, i) => (v >>> i) & 1 ? `  [${i}] ${n}` : null).filter(Boolean);

// --- decoders -------------------------------------------------------------

function decodeFeature(dv) {
  const machine = dv.getUint32(0, true);
  const target = dv.byteLength >= 8 ? dv.getUint32(4, true) : 0;
  log(`  machine bitfield  0x${machine.toString(16).padStart(8, '0')}`);
  log(bits(machine, MACHINE_FEATURES).join('\n') || '  (none reported)');
  log(`  target bitfield   0x${target.toString(16).padStart(8, '0')}`);
  log(bits(target, TARGET_FEATURES).join('\n') || '  (none reported)');
  return { machine, target };
}

function decodeSpeedRange(dv) {
  const min = dv.getUint16(0, true) / 100;
  const max = dv.getUint16(2, true) / 100;
  const step = dv.getUint16(4, true) / 100;
  log(`  ${min} – ${max} km/h, step ${step} km/h`);
  return { min, max, step };
}

function decodeInclRange(dv) {
  const min = dv.getInt16(0, true) / 10;
  const max = dv.getInt16(2, true) / 10;
  const step = dv.getUint16(4, true) / 10;
  log(`  ${min} – ${max} %, step ${step} %`);
  if (min === 0 && max === 0) log('  NOTE: all zeros — incline almost certainly unsupported.');
  return { min, max, step };
}

// Treadmill Data (0x2ACD). Fields are optional and packed in flag order;
// bit 0 is inverted (0 = Instantaneous Speed present).
function decodeTreadmillData(dv) {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out = {};
  const u16le = () => { const v = dv.getUint16(o, true); o += 2; return v; };
  const s16le = () => { const v = dv.getInt16(o, true); o += 2; return v; };
  const u24le = () => {
    const v = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
    o += 3; return v;
  };

  if (!(flags & 1))       out.speed = u16le() / 100;          // km/h
  if (flags & (1 << 1))   out.avgSpeed = u16le() / 100;
  if (flags & (1 << 2))   out.distance = u24le();             // m
  if (flags & (1 << 3)) { out.incline = s16le() / 10; out.rampAngle = s16le() / 10; }
  if (flags & (1 << 4)) { out.posElevGain = u16le() / 10; out.negElevGain = u16le() / 10; }
  if (flags & (1 << 5))   out.pace = dv.getUint8(o++) / 10;
  if (flags & (1 << 6))   out.avgPace = dv.getUint8(o++) / 10;
  if (flags & (1 << 7)) { out.totalEnergy = u16le(); out.energyPerHour = u16le();
                          out.energyPerMin = dv.getUint8(o++); }
  if (flags & (1 << 8))   out.heartRate = dv.getUint8(o++);
  if (flags & (1 << 9))   out.mets = dv.getUint8(o++) / 10;
  if (flags & (1 << 10))  out.elapsedTime = u16le();           // s
  if (flags & (1 << 11))  out.remainingTime = u16le();         // s
  if (flags & (1 << 12)) { out.force = s16le(); out.power = s16le(); }

  return { flags, fields: out, consumed: o, total: dv.byteLength };
}

// --- connection -----------------------------------------------------------

let device = null;
let ftms = null;
let chars = {};          // short name -> BluetoothRemoteGATTCharacteristic
let cpWaiter = null;     // resolve fn for the pending control point indication

const $ = id => document.getElementById(id);
const setBusy = on => {
  $('connect').disabled = on || !!device?.gatt.connected;
  for (const id of ['disconnect', 'notify', 'reqctl', 'sendraw', 'copy'])
    $(id).disabled = on || !device?.gatt.connected;
  if (!on && lines.length) $('copy').disabled = false;
};

async function connect() {
  lines.length = 0;
  $('connect').disabled = true;
  try {
    const acceptAll = $('acceptAll').checked;
    const prefix = $('prefix').value.trim();
    device = await navigator.bluetooth.requestDevice(
      acceptAll
        ? { acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES }
        : { filters: [prefix ? { namePrefix: prefix } : { services: [FTMS] }],
            optionalServices: OPTIONAL_SERVICES });

    log(`Device: ${device.name || '(no name)'}   id=${device.id}`);
    device.addEventListener('gattserverdisconnected', () => {
      log('\n*** disconnected ***');
      setBusy(false);
    });

    const server = await device.gatt.connect();
    log('GATT connected.\n');

    await dumpServices(server);
    ftms = await server.getPrimaryService(FTMS).catch(() => null);
    if (!ftms) {
      log('\nNo Fitness Machine Service reachable — controls would have to go via a vendor service.');
      return;
    }
    await readFtms();
  } catch (e) {
    log(`\nERROR: ${e.message}`);
  } finally {
    setBusy(false);
  }
}

async function dumpServices(server) {
  log('--- services & characteristics ---');
  const services = await server.getPrimaryServices();
  for (const s of services) {
    log(`\n${s.uuid}`);
    let cs = [];
    try { cs = await s.getCharacteristics(); }
    catch (e) { log(`  (characteristics unreadable: ${e.message})`); continue; }
    for (const c of cs) {
      const p = Object.entries({
        read: 'read', write: 'write', writeWithoutResponse: 'writeNR',
        notify: 'notify', indicate: 'indicate',
      }).filter(([k]) => c.properties[k]).map(([, v]) => v).join(',');
      log(`  ${c.uuid}  [${p}]`);
    }
  }
  log('');
}

async function readFtms() {
  for (const [name, uuid] of Object.entries(C)) {
    try { chars[name] = await ftms.getCharacteristic(uuid); } catch { /* absent */ }
  }

  const reads = [
    ['feature', 'Fitness Machine Feature (0x2ACC)', decodeFeature],
    ['speedRange', 'Supported Speed Range (0x2AD4)', decodeSpeedRange],
    ['inclRange', 'Supported Inclination Range (0x2AD5)', decodeInclRange],
    ['resRange', 'Supported Resistance Range (0x2AD6)', null],
    ['hrRange', 'Supported Heart Rate Range (0x2AD7)', null],
    ['powerRange', 'Supported Power Range (0x2AD8)', null],
  ];

  log('--- FTMS values ---');
  for (const [key, label, decode] of reads) {
    if (!chars[key]) { log(`\n${label}: absent`); continue; }
    log(`\n${label}`);
    try {
      const dv = await chars[key].readValue();
      log(`  raw: ${hex(dv)}`);
      if (decode) decode(dv);
    } catch (e) {
      log(`  read failed: ${e.message}`);
    }
  }

  const cp = chars.controlPoint;
  log(`\nControl Point (0x2AD9): ${cp ? 'present' : 'ABSENT — no FTMS control possible'}`);
  if (cp) {
    if (cp.properties.indicate || cp.properties.notify) {
      await cp.startNotifications();
      cp.addEventListener('characteristicvaluechanged', onControlPointResponse);
      log('  indications enabled.');
    } else {
      log('  WARNING: no indicate property — responses cannot be confirmed.');
    }
  }
}

function onControlPointResponse(e) {
  const dv = e.target.value;
  const b = new Uint8Array(dv.buffer);
  log(`\n<- control point: ${hex(dv)}`);
  if (b[0] === 0x80) {
    const res = RESULT_CODES[b[2]] ?? `unknown (0x${b[2].toString(16)})`;
    log(`   response to opcode 0x${b[1].toString(16).padStart(2, '0')}: ${res}`);
  }
  cpWaiter?.(b);
  cpWaiter = null;
}

// --- probes ---------------------------------------------------------------

async function writeControlPoint(bytes) {
  const cp = chars.controlPoint;
  if (!cp) return log('No control point.');
  log(`\n-> control point: ${hex(new Uint8Array(bytes))}`);
  const response = new Promise(res => { cpWaiter = res; });
  const timeout = new Promise(res => setTimeout(() => res(null), 3000));
  try {
    await cp.writeValue(new Uint8Array(bytes));
  } catch (e) {
    cpWaiter = null;
    return log(`   write failed: ${e.message}`);
  }
  if (await Promise.race([response, timeout]) === null)
    log('   no indication within 3s — treadmill accepted the write but did not respond.');
}

async function listenTreadmillData() {
  const c = chars.treadmillData;
  if (!c) return log('\nTreadmill Data characteristic absent.');
  log('\n--- Treadmill Data (0x2ACD), 15s sample ---');

  let n = 0;
  const onData = e => {
    const dv = e.target.value;
    const d = decodeTreadmillData(dv);
    if (n === 0) {
      log(`flags 0x${d.flags.toString(16).padStart(4, '0')}  ` +
          `(${d.consumed}/${d.total} bytes consumed${d.consumed !== d.total ? ' — MISMATCH' : ''})`);
      log(`fields present: ${Object.keys(d.fields).join(', ') || 'none'}`);
    }
    if (n < 5) log(`${hex(dv)}\n  ${JSON.stringify(d.fields)}`);
    n++;
  };

  await c.startNotifications();
  c.addEventListener('characteristicvaluechanged', onData);
  $('notify').disabled = true;

  await new Promise(r => setTimeout(r, 15000));
  c.removeEventListener('characteristicvaluechanged', onData);
  await c.stopNotifications().catch(() => {});
  $('notify').disabled = false;
  log(n ? `\n${n} packets in 15s (~${(n / 15).toFixed(1)} Hz).`
        : '\nNo packets — treadmill may only stream while the belt is running.');
}

// --- wiring ---------------------------------------------------------------

$('connect').addEventListener('click', connect);

$('disconnect').addEventListener('click', () => {
  device?.gatt.disconnect();
  chars = {}; ftms = null;
});

$('notify').addEventListener('click', () => listenTreadmillData());

$('reqctl').addEventListener('click', () => writeControlPoint([0x00]));

$('sendraw').addEventListener('click', () => {
  const bytes = $('rawhex').value.trim().split(/[\s,]+/).filter(Boolean)
    .map(s => parseInt(s.replace(/^0x/i, ''), 16));
  if (!bytes.length || bytes.some(b => Number.isNaN(b) || b < 0 || b > 255))
    return log('\nInvalid hex input.');
  writeControlPoint(bytes);
});

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(lines.join('\n'));
  $('copy').textContent = 'Copied';
  setTimeout(() => { $('copy').textContent = 'Copy report'; }, 1500);
});

if (!navigator.bluetooth) {
  log('Web Bluetooth unavailable. Use desktop Chrome or Edge, served over http://localhost.');
  $('connect').disabled = true;
}
