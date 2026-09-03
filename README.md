# WELLFIT TM treadmill control

A small always-on-top desktop app to drive a WELLFIT TM walking pad over
Bluetooth using FTMS (Fitness Machine Service, `0x1826`). Personal tool: plain
JS frontend, Rust BLE, no framework, no bundler.

Also runs as a plain web page in Chrome/Edge — see [Browser mode](#browser-mode).

## Install (macOS)

Needs [Rust](https://rustup.rs). No Node, no `tauri-cli`.

```bash
git clone <this repo> && cd wellfit
./install.sh
```

That builds an optimized bundle and copies it to `/Applications`. Launch
**WELLFIT TM** from Spotlight. Grant Bluetooth access when macOS asks — without
it the scan silently finds nothing.

Install elsewhere with `./install.sh ~/Applications`.

The app is ad-hoc signed, not notarized. If Gatekeeper objects, right-click →
**Open** once, or `xattr -dr com.apple.quarantine "/Applications/WELLFIT TM.app"`.

## Use

1. **Connect.** First launch scans for 6 s and looks for a device advertising
   `WELLFIT`/`TM` or FTMS. One clear match connects automatically; anything
   ambiguous shows a list of everything nearby, likely candidates first. Your
   pick is remembered by device id, so later launches connect silently.
   The **device** button reopens the list to switch treadmills.
2. **Get on the belt**, then press **Start**.
3. **Adjust speed** with `+` / `–` (0.1 per press). Toggle km/h ↔ mph.
4. **Walk goal** (optional): set minutes before you start. When you hit it the
   app chirps and shows a banner — it never stops the belt for you.
5. **Stop** is always enabled, even if a command errors or control is refused.

Window is always-on-top so it stays visible over other apps while you walk.

## Development

```bash
./run-dev.sh     # debug build + launch
```

The frontend in `ui/` is **embedded into the binary at compile time**, so
editing HTML/CSS/JS does nothing until you rerun this. Incremental builds are
a few seconds. Webview devtools: right-click → Inspect Element.

### Layout

| Path | Purpose |
|---|---|
| `ui/index.html`, `app.js`, `app.css` | UI, FTMS decoding, walk timer |
| `ui/ble.js` | Transport shim: native BLE under Tauri, Web Bluetooth in a browser |
| `src-tauri/src/ble.rs` | BLE via btleplug: scan, connect, notification pump |
| `src-tauri/src/main.rs` | Tauri commands |
| `ui/discover.html`, `discover.js` | Standalone device prober (browser only) |
| `bundle.sh` | Builds the `.app`; used by both scripts |

### Browser mode

`ui/` works as a static page, using Web Bluetooth instead of the Rust layer:

```bash
cd ui && python3 -m http.server 8000
```

Then open <http://localhost:8000/>. Chrome or Edge on desktop only — Safari and
Firefox have no Web Bluetooth, and `file://` doesn't count as a secure context.
Silent reconnect needs
`chrome://flags/#enable-web-bluetooth-new-permissions-backend`.

`discover.html` is the device prober: it dumps every service and
characteristic, decodes the feature bitfield and supported ranges, and samples
telemetry. Use it to re-probe after a firmware change, or against a different
treadmill before trusting anything below.

## This treadmill's quirks

Everything here came from probing the actual unit, not from the spec. A
different treadmill will differ.

- **Speed grid is imperial.** `0x2AD4` reports 0.96–6.11 km/h with a 0.32 km/h
  minimum increment — that's 0.6–3.8 mph in 0.2 steps. Targets are sent at the
  0.01 km/h wire resolution and stepped 0.1 per press in whichever unit is
  displayed; if the treadmill quantizes to its own grid, the app says so.
- **Incline and resistance are fiction.** The feature bitfield claims both, but
  `0x2AD5` and `0x2AD6` read as zeros and incline is a manual mechanical
  adjustment. No incline control, deliberately.
- **Idle telemetry lies.** While stopped it repeats a byte-identical packet with
  a stale speed (~1.01 km/h) and frozen elapsed time. Run state therefore comes
  from Fitness Machine Status (`0x2ADA`) plus change-detection on the telemetry
  feed — never from reported speed.
- **Reserved flag bit.** Treadmill Data sets bit 13, which the spec reserves,
  and appends 3 unexplained trailing bytes. Spec fields are decoded, tail
  ignored.
- **Vendor services alongside FTMS:** `F8C0`, `FFF0`, `AE00`, a Telink OTA
  service, and `59554C55-…-4D4552414348` (ASCII `YULU`/`MERACH`). Unused — FTMS
  is sufficient here, but `FFF0` is where to look if FTMS writes ever stop
  working.
- **Control point** accepts Request Control (`0x00`) and replies `80 00 01`
  (Success). Commands are serialized one at a time and matched to their
  indication by opcode; losing control permission re-requests it automatically.

## Safety

The belt responds immediately. Be on it before pressing Start or changing
speed, and never send commands from across the room. Stop stays enabled at all
times, including when a command has failed. If the app disconnects, the
treadmill keeps running — use its own panel.
