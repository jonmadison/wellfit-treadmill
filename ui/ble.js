// Transport shim: presents the same shape app.js needs, backed either by
// Tauri's Rust BLE layer (desktop) or Web Bluetooth (browser).
//
// WKWebView has no Web Bluetooth, so the desktop build talks to btleplug
// through Tauri commands and receives notifications as Tauri events.

const TM = (() => {
  const tauri = window.__TAURI__;
  const isTauri = !!tauri?.core?.invoke;

  // Handlers app.js registers: data / status / control / disconnected.
  const handlers = {};
  const on = (name, fn) => { handlers[name] = fn; };
  const fire = (name, arg) => handlers[name]?.(arg);

  // --- Tauri (native BLE) -------------------------------------------------

  async function tauriConnect(id = null) {
    const { invoke } = tauri.core;
    const { listen } = tauri.event;

    // Registered once; Rust drops the old pump on reconnect so these stay valid.
    if (!tauriConnect.listening) {
      tauriConnect.listening = true;
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

  const tauriApi = {
    isTauri: true,
    canScan: true,
    connect: id => tauriConnect(id),
    scan: (secs = 6) => tauri.core.invoke('scan_devices', { secs }),
    write: bytes => tauri.core.invoke('write_control', { data: [...bytes] }),
    disconnect: () => tauri.core.invoke('disconnect'),
    // Reconnects straight to the remembered device; no chooser needed.
    autoConnect: () => {
      const saved = localStorage.getItem('tm-device-id');
      if (!saved) throw new Error('no-saved-device');
      return tauriConnect(saved);
    },
    on,
  };

  // --- Web Bluetooth (browser fallback) -----------------------------------

  const u16 = n => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
  const FTMS = u16(0x1826);
  const UUID = {
    data: u16(0x2acd), speedRange: u16(0x2ad4), control: u16(0x2ad9), status: u16(0x2ada),
  };

  let device = null;
  let control = null;

  async function attach(dev) {
    device = dev;
    localStorage.setItem('tm-device-id', dev.id);
    dev.addEventListener('gattserverdisconnected', () => fire('disconnected'));

    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(FTMS);
    const get = async key => { try { return await svc.getCharacteristic(UUID[key]); } catch { return null; } };

    control = await get('control');
    if (!control) throw new Error("No control point — this device can't be driven over FTMS.");

    const rangeChar = await get('speedRange');
    if (!rangeChar) throw new Error('No Supported Speed Range characteristic.');
    const sr = await rangeChar.readValue();

    await control.startNotifications();
    control.addEventListener('characteristicvaluechanged',
      e => fire('control', new Uint8Array(e.target.value.buffer)));

    const dataChar = await get('data');
    if (dataChar) {
      await dataChar.startNotifications();
      dataChar.addEventListener('characteristicvaluechanged', e => fire('data', e.target.value));
    }
    const statusChar = await get('status');
    if (statusChar) {
      await statusChar.startNotifications();
      statusChar.addEventListener('characteristicvaluechanged',
        e => fire('status', new Uint8Array(e.target.value.buffer)));
    }

    return {
      id: dev.id,
      name: dev.name || 'treadmill',
      speedRange: {
        min: sr.getUint16(0, true) / 100,
        max: sr.getUint16(2, true) / 100,
        step: sr.getUint16(4, true) / 100,
      },
    };
  }

  const webApi = {
    isTauri: false,
    // Chrome's own chooser covers device selection in the browser.
    canScan: false,
    scan: async () => [],
    // Filter on the service, not the name: Web Bluetooth only offers prefix
    // matching and this unit advertises as "WELLFIT TM Linker".
    connect: async () => attach(await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS] }],
      optionalServices: [FTMS],
    })),
    write: bytes => control.writeValue(new Uint8Array(bytes)),
    disconnect: async () => device?.gatt.disconnect(),
    // Needs chrome://flags/#enable-web-bluetooth-new-permissions-backend.
    autoConnect: async () => {
      if (!navigator.bluetooth?.getDevices) throw new Error('no-getdevices');
      const known = await navigator.bluetooth.getDevices();
      const savedId = localStorage.getItem('tm-device-id');
      const dev = known.find(d => d.id === savedId) || known.find(d => d.name?.includes('TM'));
      if (!dev) throw new Error('no-saved-device');
      return attach(dev);
    },
    on,
  };

  return isTauri ? tauriApi : webApi;
})();
