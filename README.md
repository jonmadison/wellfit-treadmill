# WELLFIT TM treadmill control

A small always-on-top macOS app to drive a WELLFIT TM walking pad over
Bluetooth using FTMS (Fitness Machine Service, `0x1826`). Plain JS frontend,
native BLE through btleplug, Tauri for the window.

Start, pause and stop the belt, set target speed, track walk time against a
goal, and keep running totals.

## Install (macOS)

Download the `.dmg` from
[Releases](https://github.com/jonmadison/wellfit-treadmill/releases) and drag
**WELLFIT TM** to Applications. Apple Silicon.

The app is ad-hoc signed, so macOS quarantines it after download. The first
launch needs right-click → **Open**, or:

```bash
xattr -dr com.apple.quarantine "/Applications/WELLFIT TM.app"
```

Launch it from Spotlight and grant Bluetooth access when macOS asks; the scan
depends on it.

### Build from source

Needs [Rust](https://rustup.rs).

```bash
git clone https://github.com/jonmadison/wellfit-treadmill && cd wellfit-treadmill
./install.sh          # builds and installs to /Applications
./release.sh          # builds dist/WELLFIT-TM-<version>.dmg
```

`install.sh` takes an optional destination: `./install.sh ~/Applications`.

macOS re-asks for Bluetooth access after each rebuild, because the permission
is tied to the signed binary.

## Use

1. **Connect.** Scans for 6 s and looks for a device advertising `WELLFIT`/`TM`
   or FTMS. A single clear match connects automatically; anything ambiguous
   shows a list of everything nearby, likely candidates first. Your pick is
   remembered by device id, so later launches connect silently. The **device**
   button reopens the list to switch treadmills.
2. **Get on the belt**, then press **Start**.
3. **Adjust speed** with `+` / `–`, 0.1 per press. Toggle km/h ↔ mph.
4. **Walk goal** (optional): set minutes before you start. On reaching it the
   app chirps and shows a banner; stopping stays your call.
5. **Stop** ends the walk and clears the walk clock. **Pause** keeps it, so
   resuming continues the same walk.

Stop stays enabled whenever the app is connected, including after a failed
command.

### Two window modes

**compact** is a floating strip — walk clock, goal remaining, speed steppers,
transport buttons — that stays above other windows. Drag it by its background;
click the time or `↗` to expand. **expand** is the full window, which sits
behind whatever you're working in. The mode carries across launches.

### Odometers

Four tiers over the same walking time:

| | Resets on |
|---|---|
| This walk | Stop |
| Today | local midnight |
| Trip | the `↻` button |
| All time | a manual clear |

Totals live in the webview's localStorage, so they follow the install:
reinstalling to a different path or clearing app data starts them over.

### Light mode

**View → Light Mode** in the menu bar.

## Development

```bash
./run-dev.sh     # debug build + launch
```

`ui/` is embedded into the binary at compile time, so HTML/CSS/JS changes take
effect on the next `run-dev.sh`. Incremental builds take a few seconds. For
webview devtools, right-click → Inspect Element.

| Path | Purpose |
|---|---|
| `ui/index.html`, `app.js`, `app.css` | UI, FTMS decoding, walk timer |
| `ui/ble.js` | Transport: Tauri commands and events over the Rust BLE layer |
| `src-tauri/src/ble.rs` | BLE via btleplug: scan, connect, notification pump |
| `src-tauri/src/main.rs` | Tauri commands and menu |
| `bundle.sh` | Builds the `.app`; used by the scripts below |
| `run-dev.sh`, `install.sh`, `release.sh` | Debug launch, install, DMG |

## Device notes

How this unit behaves over FTMS. Another treadmill will differ.

- **Speed range is imperial underneath.** `0x2AD4` reports 0.96–6.11 km/h with
  a 0.32 km/h minimum increment: 0.6–3.8 mph in 0.2 steps. Targets go out at
  the 0.01 km/h wire resolution, stepped 0.1 per press in the displayed unit.
  The app reports it when the treadmill rounds a target to its own grid.
- **Incline and resistance are unavailable.** The feature bitfield advertises
  both, while `0x2AD5` and `0x2AD6` read as zeros; incline is a manual
  mechanical adjustment on this model.
- **Idle telemetry is stale.** While stopped, the unit repeats a
  byte-identical packet holding a speed of ~1.01 km/h and a frozen elapsed
  time. Run state comes from Fitness Machine Status (`0x2ADA`) together with
  change-detection on the telemetry feed. The belt also coasts for several
  seconds after a stop, during which telemetry keeps changing.
- **Treadmill Data sets reserved flag bit 13** and appends 3 undocumented
  trailing bytes. The app decodes the spec fields and ignores the tail.
- **Scanning matches the advertisement only.** `0x1826` appears after
  connecting, so CoreBluetooth service filters miss this device.
- **Control point** accepts Request Control (`0x00`) and replies `80 00 01`
  (Success). Commands are serialized one at a time and matched to their
  indication by opcode; lost control permission is re-requested automatically.
- **Vendor services alongside FTMS:** `F8C0`, `FFF0`, `AE00`, a Telink OTA
  service, and `59554C55-…-4D4552414348` (ASCII `YULU`/`MERACH`). FTMS covers
  everything the app needs; `FFF0` is where to look if FTMS writes stop
  working.

## Safety

The belt responds immediately. Be on it before pressing Start or changing
speed, and send commands only from on the belt. Stop stays enabled at all
times, including after a failed command. If the app disconnects the treadmill
keeps running — use its own panel.
