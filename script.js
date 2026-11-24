(() => {
  'use strict';

  /* ===== Alamat tetap kamera =====
     Harus sama dengan AP_IP di firmware (ESP32CAM_firmware.ino). */
  const HOST = '192.168.77.1';
  const BASE = 'http://' + HOST;

  const STORE_KEY = 'pantau-kamera:v2';
  const DEFAULTS = {
    rot: 90,          // putar 90 derajat ke kanan
    zoom: 100,        // 100 = video memenuhi layar, 0 = tampil utuh
    wake: 1,
    framesize: 8,     // VGA 640x480
    quality: 12,
    brightness: 1,
    contrast: 0,
    saturation: -2,
    vflip: 1,
    hmirror: 0
  };
  const SENSOR_KEYS = ['framesize', 'quality', 'brightness', 'contrast', 'saturation', 'vflip', 'hmirror'];
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'), canvas: $('camCanvas'), img: $('camImg'),
    chip: $('chip'), chipText: $('chipText'), chipSub: $('chipSub'),
    offlineTitle: $('offlineTitle'), offlineHint: $('offlineHint'),
    btnFlash: $('btnFlash'),
    btnRotate: $('btnRotate'), btnFit: $('btnFit'),
    btnSettings: $('btnSettings'), btnClose: $('btnClose'),
    dock: $('dock'), btnTab: $('btnTab'),
    zoom: $('zoom'), zoomOut: $('zoomOut'),
    sheet: $('sheet'), backdrop: $('backdrop'),
    rot: $('rot'), wake: $('wake'), hostText: $('hostText'),
    btnReload: $('btnReload'), btnReset: $('btnReset'),
    toast: $('toast')
  };
  const resBtns = Array.from(document.querySelectorAll('.res-btn'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ===== State ===== */
  let state = load();
  let online = false;
  let flashOn = false;
  let flashBusy = false;
  let resBusy = false;
  let failCount = 0;
  let pingTimer = null;
  let toastTimer = null;
  let wakeLock = null;

  function load() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* abaikan */ }
  }

  /* ===== Perintah ke ESP32-CAM ===== */
  // mode "no-cors": perintah tetap terkirim walau halaman dibuka dari asal lain
  async function call(path, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 3500);
    try {
      await fetch(BASE + path, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
      return true;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  const sendVar = (name, val) => call('/control?var=' + name + '&val=' + val);

  async function applyAll() {
    for (const key of SENSOR_KEYS) await sendVar(key, state[key]);
    await sleep(300); // beri waktu sensor menyesuaikan resolusi
  }

  /* ===== Tampilan ===== */
  function setChip(kind, text) {
    el.chip.dataset.state = kind;
    el.chipText.textContent = text;
    el.chipSub.textContent = '';
    el.chipSub.classList.remove('slow');
  }
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }
  function zoomLabel() {
    const z = Number(state.zoom);
    return z >= 100 ? 'Penuh' : z <= 0 ? 'Utuh' : z + '%';
  }
  // Atur ukuran dan putaran video agar sebesar mungkin di layar
  function layoutView() {
    const r = ((Number(state.rot) % 360) + 360) % 360;
    const turn = r % 180 !== 0;
    const rw = (imgMode ? el.img.naturalWidth : el.canvas.width) || 640;
    const rh = (imgMode ? el.img.naturalHeight : el.canvas.height) || 480;
    const iw = turn ? rh : rw;   // ukuran gambar setelah diputar
    const ih = turn ? rw : rh;
    const W = el.stage.clientWidth || window.innerWidth;
    const H = el.stage.clientHeight || window.innerHeight;
    const contain = Math.min(W / iw, H / ih);
    const cover = Math.max(W / iw, H / ih);
    const z = Math.max(0, Math.min(100, Number(state.zoom))) / 100;
    const s = contain + (cover - contain) * z;
    [el.canvas, el.img].forEach((v) => {
      v.style.width = rw * s + 'px';
      v.style.height = rh * s + 'px';
      v.style.transform = 'translate(-50%, -50%) rotate(' + r + 'deg)';
    });
  }
  function applyRot() {
    el.rot.value = String(((Number(state.rot) % 360) + 360) % 360);
    layoutView();
  }
  let layoutQueued = false;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layoutView(); });
  }
  window.addEventListener('resize', queueLayout);
  window.addEventListener('orientationchange', queueLayout);
  function updateFlashUI() {
    document.body.classList.toggle('flash-on', flashOn);
    el.btnFlash.setAttribute('aria-pressed', String(flashOn));
  }
  function syncResUI() {
    resBtns.forEach((b) => {
      const on = Number(b.dataset.res) === Number(state.framesize);
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    $('framesize').value = String(state.framesize);
  }
  function syncForm() {
    el.hostText.textContent = HOST;
    el.wake.checked = !!Number(state.wake);
    el.zoom.value = String(state.zoom);
    el.zoomOut.textContent = zoomLabel();
    document.querySelectorAll('[data-sensor]').forEach((input) => {
      const key = input.dataset.sensor;
      if (input.type === 'checkbox') input.checked = !!Number(state[key]);
      else input.value = String(state[key]);
      const out = input.closest('.cell').querySelector('output');
      if (out) out.textContent = state[key];
    });
    syncResUI();
  }

  /* ===== Pemutar video =====
     Frame dibaca langsung dari stream, hanya frame terbaru yang digambar
     (frame lama dibuang), jadi video tidak menumpuk dan tidak tertinggal. */
  const canFetchStream = typeof createImageBitmap === 'function' && !!window.ReadableStream && typeof TextDecoder === 'function';
  const ctx = el.canvas.getContext('2d', { alpha: false });

  let imgMode = !canFetchStream;   // cadangan: pakai <img> biasa
  let streaming = false;
  let gotFirst = false;
  let streamGen = 0;
  let streamCtl = null;
  let retryTimer = null;
  let streamFails = 0;
  let streamStartedAt = 0;
  let lastFrameAt = 0;
  let frames = 0;
  let fps = 0;

  // <parser>
  let buf = new Uint8Array(256 * 1024);
  let len = 0;
  const dec = new TextDecoder();

  function resetParser() { len = 0; }

  function headerEnd(from) {
    for (let i = from; i <= len - 4; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
    }
    return -1;
  }

  function feed(chunk) {
    if (len + chunk.length > buf.length) {
      let n = buf.length;
      while (n < len + chunk.length) n *= 2;
      if (n > 8 * 1024 * 1024) { len = 0; return; }
      const nb = new Uint8Array(n);
      nb.set(buf.subarray(0, len));
      buf = nb;
    }
    buf.set(chunk, len);
    len += chunk.length;

    let latest = null;
    let pos = 0;
    for (;;) {
      const he = headerEnd(pos);
      if (he < 0) {
        if (len - pos > 512) pos = len - 3;  // sampah, sinkron ulang
        break;
      }
      const m = /content-length:\s*(\d+)/i.exec(dec.decode(buf.subarray(pos, he)));
      const start = he + 4;
      if (!m) { pos = start; continue; }
      const size = parseInt(m[1], 10);
      if (!(size > 0) || size > 4 * 1024 * 1024) { pos = start; continue; }
      if (start + size > len) break;          // frame belum lengkap
      latest = buf.slice(start, start + size); // simpan yang terbaru saja
      pos = start + size;
    }
    if (pos > 0) { buf.copyWithin(0, pos, len); len -= pos; }
    if (latest) submitFrame(latest);
  }
  // </parser>

  let decoding = false;
  let pending = null;
  function submitFrame(bytes) {
    pending = bytes;
    if (!decoding) pump();
  }
  async function pump() {
    decoding = true;
    while (pending) {
      const data = pending;
      pending = null;
      try {
        const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
        if (el.canvas.width !== bmp.width || el.canvas.height !== bmp.height) {
          el.canvas.width = bmp.width;
          el.canvas.height = bmp.height;
          layoutView();
        }
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        onFrame();
      } catch (e) { /* frame rusak dilewati */ }
    }
    decoding = false;
  }

  function onFrame() {
    lastFrameAt = performance.now();
    frames++;
    if (!gotFirst) {
      gotFirst = true;
      streamFails = 0;
      setLive();
    }
  }
  function setLive() {
    setChip('live', 'Langsung');
    renderLive();
  }
  function renderLive() {
    if (el.chip.dataset.state !== 'live') return;
    if (imgMode) { el.chipSub.textContent = ''; return; }
    el.chipSub.textContent = fps + ' fps';
    el.chipSub.classList.toggle('slow', fps < 8);
  }

  function startStream() {
    stopStream();
    streaming = true;
    gotFirst = false;
    frames = 0;
    streamStartedAt = lastFrameAt = performance.now();
    if (imgMode) {
      el.canvas.hidden = true;
      el.img.hidden = false;
      el.img.src = BASE + ':81/stream?t=' + Date.now();
      return;
    }
    el.img.hidden = true;
    el.canvas.hidden = false;
    runStream(streamGen);
  }

  function stopStream() {
    streaming = false;
    streamGen++;
    clearTimeout(retryTimer);
    if (streamCtl) { try { streamCtl.abort(); } catch (e) { /* abaikan */ } streamCtl = null; }
    resetParser();
    pending = null;
    if (imgMode) el.img.src = BLANK; // putuskan koneksi agar ESP32-CAM bebas
  }

  async function runStream(gen) {
    const ctl = new AbortController();
    streamCtl = ctl;
    try {
      const res = await fetch(BASE + ':81/stream', { cache: 'no-store', signal: ctl.signal });
      if (!res.ok || !res.body) throw new Error('stream');
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (gen !== streamGen) { try { reader.cancel(); } catch (e) { /* abaikan */ } return; }
        if (done) break;
        feed(value);
      }
    } catch (e) { /* ditangani di bawah */ }
    if (gen === streamGen) handleStreamEnd();
  }

  function handleStreamEnd() {
    if (!streaming) return;
    if (!gotFirst) {
      streamFails++;
      if (streamFails >= 4 && online && !imgMode) {
        imgMode = true;                  // cadangan: mode video sederhana
        streamFails = 0;
        toast('Memakai mode video sederhana');
      }
    }
    setChip('connecting', 'Memulihkan…');
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (streaming && online) startStream(); }, 1200);
  }

  el.img.addEventListener('load', () => {
    if (streaming && imgMode && el.img.src !== BLANK) { gotFirst = true; setLive(); layoutView(); }
  });
  el.img.addEventListener('error', () => { if (streaming && imgMode) handleStreamEnd(); });

  // Pengawas: hitung fps dan sambung ulang bila video macet
  setInterval(() => {
    fps = frames;
    frames = 0;
    renderLive();
    if (!streaming || !online || imgMode) return;
    const now = performance.now();
    if (gotFirst && now - lastFrameAt > 4000) startStream();
    else if (!gotFirst && now - streamStartedAt > 8000) handleStreamEnd();
  }, 1000);

  /* ===== Resolusi ===== */
  async function changeResolution(v) {
    state.framesize = v;
    save();
    syncResUI();
    if (!online || resBusy) return;
    resBusy = true;
    stopStream();
    setChip('connecting', 'Ganti resolusi…');
    await sendVar('framesize', v);
    await sleep(500);
    resBusy = false;
    if (online && !document.hidden) startStream();
    if (v >= 10) toast('Resolusi tinggi lebih berat. Jika patah-patah, turunkan ke VGA.');
  }

  /* ===== Pemantau koneksi ===== */
  async function onConnected() {
    online = true;
    streamFails = 0;
    document.body.classList.remove('offline');
    setChip('connecting', 'Menghubungkan…');
    flashOn = false;              // ESP32-CAM selalu mulai dengan flash mati
    updateFlashUI();
    await applyAll();             // kirim ulang pengaturan tersimpan
    if (!document.hidden) startStream();
  }
  function onDisconnected() {
    online = false;
    document.body.classList.add('offline');
    stopStream();
    flashOn = false;
    updateFlashUI();
    setChip('offline', 'Terputus');
    el.offlineTitle.textContent = 'Kamera tidak terhubung';
    el.offlineHint.textContent = (location.protocol === 'https:')
      ? 'Halaman ini dibuka lewat HTTPS sehingga browser memblokir kamera (HTTP). Pakai versi aplikasi atau buka dari file lokal.'
      : 'Sambungkan HP ke Wi-Fi kamera. Aplikasi mencoba lagi otomatis.';
  }
  async function tick() {
    clearTimeout(pingTimer);
    const ok = await call('/status', 2500);
    if (ok) {
      failCount = 0;
      if (!online) await onConnected();
    } else {
      failCount++;
      // butuh 2 kali gagal berturut-turut agar tampilan tidak berkedip
      if ((online && failCount >= 2) || (!online && failCount === 1)) onDisconnected();
    }
    pingTimer = setTimeout(tick, ok ? 4000 : 2000);
  }

  /* ===== Flash ===== */
  async function toggleFlash() {
    if (flashBusy) return;
    if (!online) { toast('Kamera belum terhubung'); return; }
    flashBusy = true;
    const next = !flashOn;
    const ok = await sendVar('flash', next ? 1 : 0);
    flashBusy = false;
    if (ok) { flashOn = next; updateFlashUI(); }
    else toast('Perintah flash gagal terkirim');
  }

  /* ===== Layar tetap menyala ===== */
  async function syncWake() {
    try {
      if (Number(state.wake) && 'wakeLock' in navigator && !document.hidden && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!Number(state.wake) && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* tidak didukung */ }
  }

  /* ===== Dock (tersembunyi, muncul lewat panah) ===== */
  let dockTimer = null;
  function bumpDock() {
    clearTimeout(dockTimer);
    if (el.dock.classList.contains('open')) dockTimer = setTimeout(hideDock, 6000);
  }
  function showDock() {
    el.dock.classList.add('open');
    el.btnTab.setAttribute('aria-expanded', 'true');
    bumpDock();
  }
  function hideDock() {
    clearTimeout(dockTimer);
    el.dock.classList.remove('open');
    el.btnTab.setAttribute('aria-expanded', 'false');
  }

  /* ===== Lembar pengaturan ===== */
  function openSheet() {
    hideDock();
    el.sheet.classList.add('open');
    el.backdrop.classList.add('open');
    el.sheet.setAttribute('aria-hidden', 'false');
  }
  function closeSheet() {
    el.sheet.classList.remove('open');
    el.backdrop.classList.remove('open');
    el.sheet.setAttribute('aria-hidden', 'true');
  }

  /* ===== Event ===== */
  el.btnFlash.addEventListener('click', toggleFlash);

  el.btnTab.addEventListener('click', () => {
    if (el.dock.classList.contains('open')) hideDock(); else showDock();
  });
  el.dock.addEventListener('pointerdown', bumpDock);
  el.stage.addEventListener('click', hideDock);

  el.btnRotate.addEventListener('click', () => {
    state.rot = (Number(state.rot) + 90) % 360;
    save(); applyRot();
  });

  function setZoom(z) {
    state.zoom = z;
    el.zoom.value = String(z);
    el.zoomOut.textContent = zoomLabel();
    layoutView();
  }
  el.btnFit.addEventListener('click', () => {
    setZoom(Number(state.zoom) >= 50 ? 0 : 100);
    save();
    toast(Number(state.zoom) >= 100 ? 'Video memenuhi layar' : 'Video tampil utuh');
  });
  el.zoom.addEventListener('input', () => setZoom(Number(el.zoom.value)));
  el.zoom.addEventListener('change', save);
  el.rot.addEventListener('change', () => {
    state.rot = Number(el.rot.value);
    save(); applyRot();
  });

  resBtns.forEach((b) => b.addEventListener('click', () => changeResolution(Number(b.dataset.res))));

  el.btnSettings.addEventListener('click', openSheet);
  el.btnClose.addEventListener('click', closeSheet);
  el.backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  document.querySelectorAll('[data-sensor]').forEach((input) => {
    const key = input.dataset.sensor;
    const out = input.closest('.cell').querySelector('output');
    if (input.type === 'range' && out) {
      input.addEventListener('input', () => { out.textContent = input.value; });
    }
    input.addEventListener('change', () => {
      if (key === 'framesize') { changeResolution(Number(input.value)); return; }
      state[key] = input.type === 'checkbox' ? (input.checked ? 1 : 0) : Number(input.value);
      save();
      if (online) sendVar(key, state[key]);
    });
  });

  el.wake.addEventListener('change', () => {
    state.wake = el.wake.checked ? 1 : 0;
    save(); syncWake();
  });

  el.btnReload.addEventListener('click', () => {
    closeSheet();
    if (online) { setChip('connecting', 'Memuat ulang…'); startStream(); }
    else tick();
  });

  el.btnReset.addEventListener('click', async () => {
    state = Object.assign({}, DEFAULTS);
    save(); syncForm(); applyRot(); syncWake();
    if (online) {
      stopStream();
      await applyAll();
      startStream();
    }
    toast('Pengaturan dikembalikan ke bawaan');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopStream();            // hemat daya dan koneksi saat di latar belakang
    } else {
      syncWake();
      if (online) startStream();
      tick();
    }
  });

  // Coba kunci landscape (jalan di aplikasi/layar penuh; diabaikan bila tidak didukung)
  try {
    if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  } catch (e) { /* abaikan */ }

  /* ===== Mulai ===== */
  syncForm();
  applyRot();
  updateFlashUI();
  syncWake();
  showDock();   // tampil sebentar agar kelihatan, lalu sembunyi sendiri
  tick();

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }
})();