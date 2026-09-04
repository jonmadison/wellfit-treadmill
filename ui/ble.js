// Transport for the FTMS treadmill, backed by the Rust BLE layer (btleplug)
// over Tauri commands and events.
//
// This is desktop-only by design. WKWebView has no Web Bluetooth API, so there
// is no in-browser path; BLE lives in src-tauri/src/ble.rs.

const TM = (() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) {
    throw new Error('No Tauri runtime — this app must run as the desktop bundle.');
  }

  const { invoke } = tauri.core;
  const { listen } = tauri.event;

  // Handlers app.js registers: data / status / control / disconnected / error.
  const handlers = {};
  const fire = (name, arg) => handlers[name]?.(arg);

  let listening = false;

  async function connect(id = null) {
    // Registered once; Rust drops the old pump on reconnect so these stay valid.
    if (!listening) {
      listening = true;
      await listen('ble:data', e => fire('data', new DataView(new Uint8Array(e.payload.data).buffer)));
      await listen('ble:status', e => fire('status', new Uint8Array(e.payload.data)));
      await listen('ble:control', e => fire('control', new Uint8Array(e.payload.data)));
      await listen('ble:disconnected', () => fire('disconnected'));
      await listen('ble:error', e => fire('error', e.payload));
    }

    const info = await invoke('connect', { id });
    localStorage.setItem('tm-device-id', info.id);
    return {
      id: info.id,
      name: info.name,
      speedRange: { min: info.speed_min, max: info.speed_max, step: info.speed_step },
    };
  }

  return {
    connect,
    scan: (secs = 6) => invoke('scan_devices', { secs }),
    write: bytes => invoke('write_control', { data: [...bytes] }),
    disconnect: () => invoke('disconnect'),
    isConnected: () => invoke('is_connected'),

    // Reconnects straight to the remembered device — native BLE needs no chooser.
    autoConnect: () => {
      const saved = localStorage.getItem('tm-device-id');
      if (!saved) throw new Error('no-saved-device');
      return connect(saved);
    },

    on: (name, fn) => { handlers[name] = fn; },
  };
})();
