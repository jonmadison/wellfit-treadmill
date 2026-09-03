//! FTMS treadmill transport over CoreBluetooth via btleplug.
//!
//! Replaces the Web Bluetooth layer the browser build used, since WKWebView
//! (and therefore Tauri on macOS) has no Web Bluetooth API.
//!
//! Notifications are forwarded to the webview as Tauri events rather than
//! being interpreted here: the decoding logic already lives in app.js and is
//! tuned to this specific treadmill's quirks.

use std::time::Duration;

use btleplug::api::{
    Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

// Built with Uuid::from_u128 rather than btleplug's uuid_from_u16 helper so
// these stay usable in const position regardless of that helper's signature.
const fn ble_uuid(short: u16) -> Uuid {
    Uuid::from_u128(0x0000_0000_0000_1000_8000_00805f9b34fb | ((short as u128) << 96))
}

pub const SERVICE_FTMS: Uuid = ble_uuid(0x1826);
pub const CHAR_DATA: Uuid = ble_uuid(0x2acd);
pub const CHAR_SPEED_RANGE: Uuid = ble_uuid(0x2ad4);
pub const CHAR_CONTROL: Uuid = ble_uuid(0x2ad9);
pub const CHAR_STATUS: Uuid = ble_uuid(0x2ada);

const SCAN_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Default)]
pub struct BleState {
    inner: Mutex<Option<Connected>>,
}

struct Connected {
    peripheral: Peripheral,
    control: Characteristic,
}

#[derive(Serialize, Clone)]
pub struct ConnectInfo {
    pub id: String,
    pub name: String,
    pub speed_min: f64,
    pub speed_max: f64,
    pub speed_step: f64,
}

/// One scan result, for the device picker.
#[derive(Serialize, Clone)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
    /// Whether the advertisement itself claims FTMS. Many treadmills expose it
    /// only after connecting, so a false here is not disqualifying.
    pub ftms: bool,
}

/// Stable key for a peripheral across scans. Debug formatting is used because
/// PeripheralId's Display impl isn't guaranteed across btleplug versions; it
/// only has to be self-consistent.
fn peripheral_key(p: &Peripheral) -> String {
    format!("{:?}", p.id())
}

/// Payload for every forwarded notification: raw bytes, decoded in the webview.
#[derive(Serialize, Clone)]
struct Packet {
    data: Vec<u8>,
}

impl BleState {
    pub async fn is_connected(&self) -> bool {
        match &*self.inner.lock().await {
            Some(c) => c.peripheral.is_connected().await.unwrap_or(false),
            None => false,
        }
    }

    /// Lists everything advertising nearby so the user can choose, rather than
    /// us guessing from a hardcoded name prefix.
    pub async fn scan_devices(&self, secs: u64) -> Result<Vec<DeviceInfo>, String> {
        let adapter = adapter().await?;
        adapter
            .start_scan(ScanFilter::default())
            .await
            .map_err(|e| format!("scan failed: {e}"))?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        let mut out: Vec<DeviceInfo> = Vec::new();

        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(500)).await;
            for p in adapter.peripherals().await.unwrap_or_default() {
                let Some(props) = p.properties().await.ok().flatten() else {
                    continue;
                };
                // Unnamed peripherals are noise here — a treadmill you can
                // pick out of a list is one that advertises a name.
                let Some(name) = props.local_name.filter(|n| !n.trim().is_empty()) else {
                    continue;
                };
                let id = peripheral_key(&p);
                let info = DeviceInfo {
                    id: id.clone(),
                    name,
                    rssi: props.rssi,
                    ftms: props.services.contains(&SERVICE_FTMS),
                };
                match out.iter_mut().find(|d| d.id == id) {
                    // Refresh in place: RSSI and name can fill in over time.
                    Some(existing) => *existing = info,
                    None => out.push(info),
                }
            }
        }

        adapter.stop_scan().await.ok();

        // Likely FTMS and strongest signal first.
        out.sort_by(|a, b| {
            b.ftms
                .cmp(&a.ftms)
                .then(b.rssi.unwrap_or(-999).cmp(&a.rssi.unwrap_or(-999)))
        });
        Ok(out)
    }

    /// `target` is a device id from `scan_devices`. Always explicit: guessing
    /// by name is unreliable across treadmill models and firmware revisions.
    pub async fn connect(&self, app: AppHandle, target: String) -> Result<ConnectInfo, String> {
        // Drop any previous session so a reconnect can't leave two
        // notification pumps writing to the same window.
        self.disconnect().await.ok();

        let adapter = adapter().await?;
        let peripheral = find_treadmill(&adapter, target).await?;
        let id = peripheral_key(&peripheral);

        peripheral
            .connect()
            .await
            .map_err(|e| format!("connect failed: {e}"))?;
        peripheral
            .discover_services()
            .await
            .map_err(|e| format!("service discovery failed: {e}"))?;

        let name = peripheral
            .properties()
            .await
            .ok()
            .flatten()
            .and_then(|p| p.local_name)
            .unwrap_or_else(|| "treadmill".into());

        let chars = peripheral.characteristics();
        let find = |uuid: Uuid| chars.iter().find(|c| c.uuid == uuid).cloned();

        let control = find(CHAR_CONTROL)
            .ok_or("No Fitness Machine Control Point — this device can't be driven over FTMS")?;

        // The speed range defines the whole UI, so fail loudly if it's missing.
        let range_char = find(CHAR_SPEED_RANGE).ok_or("No Supported Speed Range characteristic")?;
        let raw = peripheral
            .read(&range_char)
            .await
            .map_err(|e| format!("reading speed range failed: {e}"))?;
        if raw.len() < 6 {
            return Err(format!("speed range too short: {raw:02x?}"));
        }
        let u16le = |i: usize| u16::from_le_bytes([raw[i], raw[i + 1]]) as f64 / 100.0;
        let info = ConnectInfo {
            id,
            name,
            speed_min: u16le(0),
            speed_max: u16le(2),
            speed_step: u16le(4),
        };

        for (uuid, label) in [
            (CHAR_CONTROL, "control point"),
            (CHAR_DATA, "treadmill data"),
            (CHAR_STATUS, "machine status"),
        ] {
            let Some(ch) = find(uuid) else { continue };
            if !ch
                .properties
                .intersects(CharPropFlags::NOTIFY | CharPropFlags::INDICATE)
            {
                continue;
            }
            peripheral
                .subscribe(&ch)
                .await
                .map_err(|e| format!("subscribing to {label} failed: {e}"))?;
        }

        spawn_pump(app, peripheral.clone());

        *self.inner.lock().await = Some(Connected {
            peripheral,
            control,
        });
        Ok(info)
    }

    /// Writes to the control point. The indication comes back as a
    /// `ble:control` event; app.js matches it to the pending command.
    pub async fn write_control(&self, data: Vec<u8>) -> Result<(), String> {
        let guard = self.inner.lock().await;
        let conn = guard.as_ref().ok_or("not connected")?;
        conn.peripheral
            .write(&conn.control, &data, WriteType::WithResponse)
            .await
            .map_err(|e| format!("control point write failed: {e}"))
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        if let Some(conn) = self.inner.lock().await.take() {
            conn.peripheral.disconnect().await.ok();
        }
        Ok(())
    }
}

async fn adapter() -> Result<Adapter, String> {
    let manager = Manager::new()
        .await
        .map_err(|e| format!("bluetooth unavailable: {e}"))?;
    manager
        .adapters()
        .await
        .map_err(|e| format!("no bluetooth adapter: {e}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "no bluetooth adapter found".into())
}

/// Waits for the chosen device id to appear in a scan.
///
/// Deliberately does NOT pass a ScanFilter: on macOS CoreBluetooth only
/// matches service UUIDs that appear in the advertisement packet, and this
/// treadmill exposes 0x1826 only after connecting. Filtering on it made the
/// device invisible to the scan entirely.
async fn find_treadmill(adapter: &Adapter, target: String) -> Result<Peripheral, String> {
    adapter
        .start_scan(ScanFilter::default())
        .await
        .map_err(|e| format!("scan failed: {e}"))?;

    let deadline = tokio::time::Instant::now() + SCAN_TIMEOUT;
    let mut found = None;
    let mut seen: Vec<String> = Vec::new();

    'scan: loop {
        for p in adapter.peripherals().await.unwrap_or_default() {
            let Some(props) = p.properties().await.ok().flatten() else {
                continue;
            };
            let name = props.local_name.clone().unwrap_or_default();

            if !name.is_empty() && !seen.contains(&name) {
                seen.push(name.clone());
            }

            if peripheral_key(&p) == target {
                found = Some(p);
                break 'scan;
            }
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    adapter.stop_scan().await.ok();

    // Naming what we did see turns "not found" into something diagnosable.
    found.ok_or_else(|| {
        if seen.is_empty() {
            format!(
                "no BLE devices at all in {}s — is Bluetooth permission granted?",
                SCAN_TIMEOUT.as_secs()
            )
        } else {
            format!("chosen device not nearby; saw: {}", seen.join(", "))
        }
    })
}

/// Forwards every notification to the webview, tagged by characteristic.
fn spawn_pump(app: AppHandle, peripheral: Peripheral) {
    tokio::spawn(async move {
        let mut stream = match peripheral.notifications().await {
            Ok(s) => s,
            Err(e) => {
                let _ = app.emit("ble:error", format!("notification stream failed: {e}"));
                return;
            }
        };

        while let Some(n) = stream.next().await {
            // if/else rather than a match: const Uuid patterns are brittle.
            let event = if n.uuid == CHAR_DATA {
                "ble:data"
            } else if n.uuid == CHAR_STATUS {
                "ble:status"
            } else if n.uuid == CHAR_CONTROL {
                "ble:control"
            } else {
                continue;
            };
            let _ = app.emit(event, Packet { data: n.value });
        }

        // The stream ends when the link drops.
        let _ = app.emit("ble:disconnected", ());
    });
}
