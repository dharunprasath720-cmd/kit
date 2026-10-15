'use strict';

const {
  app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, systemPreferences, globalShortcut
} = require('electron');
const path = require('path');
const fs = require('fs');

// ------------------------------------------------------------------ constants
const LOGICAL = 60;        // the cat is drawn on a 60x60 pixel grid
const GROUND_ROW = 51;     // grid row of the floor
const CENTER_ROW = 41;     // grid row used as the cat's centre when following
const COATS = {
  indie:   { fur: '#c48a4e', markings: '#6b4423', belly: '#f6ecd9', eyes: '#e3b82c', outline: '#3a2415', pink: '#f08a9a' },
  persian: { fur: '#f3ead9', markings: '#d3c4a8', belly: '#ffffff', eyes: '#f0d56a', outline: '#5a4a3a', pink: '#ffb0c0' },
  black:   { fur: '#34343f', markings: '#1f1f27', belly: '#464653', eyes: '#f5c518', outline: '#0b0b10', pink: '#ff7f9a' }
};
const NAME_OK = /[^A-Z0-9 !?.,'\-:]/g;
const cleanName = (v) => String(v == null ? '' : v).toUpperCase().replace(NAME_OK, '').trim().slice(0, 14);
const SIZE_PRESETS = { small: 2.6, medium: 3.4, large: 4.4 };
const STRETCH_ANIM_MS = 7000;
const DEFAULT_TIPS = [
  'Stand up and reach high',
  'Roll your shoulders',
  'Look away from the screen',
  'Shake out your hands',
  'Take a deep breath',
  'Rotate your wrists',
  'Twist gently side to side'
];
const DEFAULTS = {
  scale: 3.4,               // screen px per grid px (4 x 0.85)
  follow: true,
  followDistance: 26,       // grid units kept between cat and cursor
  followSpeed: 700,         // max px/s while chasing
  reactToTyping: true,
  petReactions: true,
  sleepAfter: 45,           // seconds idle before it naps
  alwaysOnTop: true,
  stretchMinutes: 30,       // 0 = off
  tips: DEFAULT_TIPS,
  coat: 'indie',            // indie | persian | black
  name: null,               // null = not asked yet (first-run prompt); '' = no name
  lock: {
    enabled: false,
    spot: 'bottom-right',   // bottom-right | bottom-left | top-right | top-left | custom
    custom: null,           // { x, y } cat centre in screen coordinates
    walkSpeed: 90           // px/s: the slow stroll to the spot
  },
  hotkey: 'CommandOrControl+Alt+L',
  timerPresets: [{ label: 'Focus', minutes: 25 }, { label: 'Break', minutes: 5 }]
};

// ------------------------------------------------------------------ settings
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const num = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? clamp(Number(v), lo, hi) : fallback);

function sanitize(s) {
  s.scale = num(s.scale, 2, 6, DEFAULTS.scale);
  if (!COATS[s.coat]) s.coat = 'indie';
  s.name = s.name === null || s.name === undefined ? null : cleanName(s.name);
  s.followDistance = num(s.followDistance, 20, 60, DEFAULTS.followDistance);
  s.followSpeed = num(s.followSpeed, 100, 1500, DEFAULTS.followSpeed);
  s.sleepAfter = num(s.sleepAfter, 10, 3600, DEFAULTS.sleepAfter);
  s.stretchMinutes = Math.round(num(s.stretchMinutes, 0, 480, DEFAULTS.stretchMinutes));
  s.lock.walkSpeed = num(s.lock.walkSpeed, 30, 400, DEFAULTS.lock.walkSpeed);
  if (!['bottom-right', 'bottom-left', 'top-right', 'top-left', 'custom'].includes(s.lock.spot)) {
    s.lock.spot = 'bottom-right';
  }
  if (s.lock.spot === 'custom' && !s.lock.custom) s.lock.spot = 'bottom-right';
  s.timerPresets = (Array.isArray(s.timerPresets) ? s.timerPresets : [])
    .map((p) => ({ label: cleanName(p && p.label), minutes: num(p && p.minutes, 0.1, 600, 25) }))
    .slice(0, 8);
  s.tips = (Array.isArray(s.tips) ? s.tips : [])
    .map((t) => String(t).trim()).filter(Boolean).slice(0, 50);
  if (!s.tips.length) s.tips = DEFAULT_TIPS.slice();
  return s;
}

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch { /* first run */ }
  if (raw.size && !raw.scale) raw.scale = SIZE_PRESETS[raw.size] || DEFAULTS.scale; // v1 migration
  delete raw.size;
  delete raw.colors;
  delete raw.collar;
  return sanitize(deepMerge(DEFAULTS, raw));
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.warn('Could not save settings:', err.message);
  }
}

let settings = sanitize(deepMerge(DEFAULTS, {}));

// ------------------------------------------------------------------ state
let win = null;
let panel = null;
let tray = null;
let uIOhook = null;
let hookRunning = false;

const cat = { x: 0, y: 0, vx: 0, vy: 0 };      // window top-left (float) and velocity
const drag = { active: false, dx: 0, dy: 0 };
let lastCursor = { x: -1, y: -1 };
let lastMoveAt = Date.now();
let lastKeyAt = 0;
let stretchUntil = 0;
let ignoring = true;
let lastTick = Date.now();
let lastBoundsKey = '';
let frameCount = 0;
let stretchTimer = null;
let size = 204;

const gridPx = () => size / LOGICAL;
const computeSize = () => Math.round(LOGICAL * settings.scale);

// ------------------------------------------------------------------ window
function createWindow() {
  size = computeSize();
  const k = gridPx();
  const wa = screen.getPrimaryDisplay().workArea;
  cat.x = wa.x + wa.width - size - 120;
  cat.y = wa.y + wa.height - GROUND_ROW * k - 4;

  win = new BrowserWindow({
    width: size,
    height: size,
    x: Math.round(cat.x),
    y: Math.round(cat.y),
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,       // clicking the cat never steals focus from what you're typing in
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  applyAlwaysOnTop();
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoring = true;

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.warn('[cat]', message);
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { win = null; });
}

function applyAlwaysOnTop() {
  if (!win) return;
  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

function send(channel, payload, force = false) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  if (win.webContents.isLoading() && !force) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    // renderer is going away (quit or reload); nothing to deliver to
  }
}

function sendConfig(force = false) {
  send('config', {
    size,
    colors: COATS[settings.coat],
    name: settings.name || '',
    sleepAfter: settings.sleepAfter,
    pet: settings.petReactions
  }, force);
}

function applyScale() {
  if (!win) return;
  const oldSize = size;
  const oldK = oldSize / LOGICAL;
  const cx = cat.x + oldSize / 2;
  const cy = cat.y + CENTER_ROW * oldK;
  size = computeSize();
  const k = gridPx();
  cat.x = cx - size / 2;     // keep the cat's centre where it was
  cat.y = cy - CENTER_ROW * k;
  lastBoundsKey = '';
  sendConfig();
}

// ------------------------------------------------------------------ lock target
function lockTarget(k) {
  const L = settings.lock;
  const cx = cat.x + size / 2;
  const cy = cat.y + CENTER_ROW * k;
  const wa = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) }).workArea;
  const left = wa.x + 20 * k;
  const right = wa.x + wa.width - 20 * k;
  const top = wa.y + 14 * k + 2;
  const bottom = wa.y + wa.height - (GROUND_ROW - CENTER_ROW) * k - 2;
  switch (L.spot) {
    case 'bottom-left': return { x: left, y: bottom };
    case 'top-right': return { x: right, y: top };
    case 'top-left': return { x: left, y: top };
    case 'custom': return { x: clamp(L.custom.x, left, right), y: clamp(L.custom.y, top, bottom) };
    default: return { x: right, y: bottom };
  }
}

// ------------------------------------------------------------------ main loop
function tick() {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - lastTick) / 1000));
  lastTick = now;

  const k = gridPx();
  const cur = screen.getCursorScreenPoint();
  if (cur.x !== lastCursor.x || cur.y !== lastCursor.y) {
    lastMoveAt = now;
    lastCursor = cur;
  }

  const cx = cat.x + size / 2;
  const cy = cat.y + CENTER_ROW * k;

  if (drag.active) {
    cat.x = cur.x - drag.dx;
    cat.y = cur.y - drag.dy;
    cat.vx = 0;
    cat.vy = 0;
  } else {
    const typing = now - lastKeyAt < 900;
    const dist = Math.hypot(cur.x - cx, cur.y - cy) || 0.0001;
    const resting = now < stretchUntil || (typing && (settings.lock.enabled || dist < 360));
    let tvx = 0;
    let tvy = 0;
    let settled = false;

    if (settings.lock.enabled) {
      // Walk (never teleport) to the chosen spot at a slow stroll.
      const t = lockTarget(k);
      const ddx = t.x - cx;
      const ddy = t.y - cy;
      const dd = Math.hypot(ddx, ddy);
      if (dd < 2.5) {
        cat.x += ddx;
        cat.y += ddy;
        settled = true;
      } else if (!resting) {
        const sp = Math.min(settings.lock.walkSpeed, Math.max(45, dd * 3));
        tvx = (ddx / dd) * sp;
        tvy = (ddy / dd) * sp;
      }
    } else if (settings.follow && !resting) {
      const stand = settings.followDistance * k;
      if (dist > stand + 14) {
        const sp = Math.min(settings.followSpeed, Math.max(80, (dist - stand) * 4));
        tvx = ((cur.x - cx) / dist) * sp;
        tvy = ((cur.y - cy) / dist) * sp;
      }
    }

    if (settled) {
      cat.vx = 0;
      cat.vy = 0;
    } else {
      const a = 1 - Math.exp(-dt * 12);
      cat.vx += (tvx - cat.vx) * a;
      cat.vy += (tvy - cat.vy) * a;
      if (tvx === 0 && tvy === 0 && Math.hypot(cat.vx, cat.vy) < 6) {
        cat.vx = 0;
        cat.vy = 0;
      }
      cat.x += cat.vx * dt;
      cat.y += cat.vy * dt;
    }
  }

  // keep the cat itself on screen (the transparent window may overhang)
  const ncx = cat.x + size / 2;
  const ncy = cat.y + CENTER_ROW * k;
  const wa = screen.getDisplayNearestPoint({ x: Math.round(ncx), y: Math.round(ncy) }).workArea;
  cat.x = clamp(ncx, wa.x + 18 * k, wa.x + wa.width - 18 * k) - size / 2;
  cat.y = clamp(ncy, wa.y + 14 * k, wa.y + wa.height - (GROUND_ROW - CENTER_ROW) * k) - CENTER_ROW * k;

  const rx = Math.round(cat.x);
  const ry = Math.round(cat.y);
  const key = `${rx},${ry},${size}`;
  if (key !== lastBoundsKey) {
    lastBoundsKey = key;
    win.setBounds({ x: rx, y: ry, width: size, height: size });
  }

  // Only the cat itself catches the mouse; the rest of the window is click-through.
  const wx = cur.x - rx;
  const wy = cur.y - ry;
  const over = wx >= size / 2 - 18 * k && wx <= size / 2 + 18 * k &&
               wy >= (GROUND_ROW - 26) * k && wy <= (GROUND_ROW + 2) * k;
  const wantIgnore = !(over || drag.active);
  if (wantIgnore !== ignoring) {
    ignoring = wantIgnore;
    win.setIgnoreMouseEvents(wantIgnore, { forward: true });
  }

  if (process.env.PIXELCAT_DEBUG && frameCount % 60 === 0) {
    console.log(JSON.stringify({ x: rx, y: ry, size, vx: Math.round(cat.vx), vy: Math.round(cat.vy), vis: win.isVisible(), lock: settings.lock.enabled }));
  }

  if ((frameCount++ & 1) === 0) {
    send('state', {
      vx: cat.vx,
      vy: cat.vy,
      dx: cur.x - (cat.x + size / 2),
      dy: cur.y - (cat.y + CENTER_ROW * k),
      idle: now - Math.max(lastMoveAt, lastKeyAt),
      over
    });
  }
}

// ------------------------------------------------------------------ stretch reminders
function fireStretch() {
  if (!win || !win.isVisible()) return;
  const tips = settings.tips.length ? settings.tips : DEFAULT_TIPS;
  const tip = tips[Math.floor(Math.random() * tips.length)];
  stretchUntil = Date.now() + STRETCH_ANIM_MS;
  send('stretch', { tip, ms: STRETCH_ANIM_MS });
}

function scheduleStretch() {
  clearTimeout(stretchTimer);
  stretchTimer = null;
  if (!settings.stretchMinutes) return;
  // PIXELCAT_STRETCH_SECONDS lets you preview the reminder without waiting.
  const override = Number(process.env.PIXELCAT_STRETCH_SECONDS);
  const delayMs = override > 0 ? override * 1000 : settings.stretchMinutes * 60 * 1000;
  stretchTimer = setTimeout(() => {
    fireStretch();
    scheduleStretch();
  }, delayMs);
}

// ------------------------------------------------------------------ keyboard / mouse hook
function setupHook() {
  try {
    if (process.platform === 'darwin') {
      // Prompts for Accessibility access the first time.
      systemPreferences.isTrustedAccessibilityClient(true);
    }
    ({ uIOhook } = require('uiohook-napi'));
    uIOhook.on('keydown', () => {
      lastKeyAt = Date.now();
      send('key');
    });
    uIOhook.on('mouseup', () => {
      if (drag.active) drag.active = false;
    });
  } catch (err) {
    uIOhook = null;
    console.warn('Global input hook unavailable; typing reactions disabled:', err.message);
  }
}

function syncHook() {
  if (!uIOhook) return;
  try {
    if (settings.reactToTyping && !hookRunning) {
      uIOhook.start();
      hookRunning = true;
    } else if (!settings.reactToTyping && hookRunning) {
      uIOhook.stop();
      hookRunning = false;
    }
  } catch (err) {
    console.warn('Could not toggle input hook:', err.message);
  }
}

// ------------------------------------------------------------------ settings changes
function loginArgs() {
  // When running unpackaged (`npm start`) the login item has to launch electron with our folder.
  return app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
}

function loginEnabled() {
  try {
    return app.getLoginItemSettings(loginArgs()).openAtLogin;
  } catch {
    return false;
  }
}

function setLogin(on) {
  try {
    app.setLoginItemSettings(Object.assign({ openAtLogin: !!on }, loginArgs()));
  } catch (err) {
    console.warn('Could not change login item:', err.message);
  }
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.hotkey) return;
  try {
    globalShortcut.register(settings.hotkey, () => setLock(!settings.lock.enabled));
  } catch (err) {
    console.warn('Could not register hotkey:', err.message);
  }
}

function panelState() {
  return {
    settings,
    defaults: DEFAULTS,
    coats: Object.keys(COATS),
    firstRun: settings.name === null,
    timers: timers.map((t) => ({ id: t.id, label: t.label, endsAt: t.endsAt, total: t.total })),
    now: Date.now(),
    runtime: { login: loginEnabled(), visible: !!(win && win.isVisible()), hook: !!uIOhook, platform: process.platform }
  };
}

function notifyPanel() {
  if (panel && !panel.isDestroyed()) panel.webContents.send('settings:changed', panelState());
}

// Merge a patch, persist it and push the result to the cat.
function update(patch) {
  const prev = settings;
  settings = sanitize(deepMerge(settings, patch));
  saveSettings();
  if (settings.scale !== prev.scale) applyScale(); else sendConfig();
  if (settings.stretchMinutes !== prev.stretchMinutes) scheduleStretch();
  if (settings.reactToTyping !== prev.reactToTyping) syncHook();
  if (settings.alwaysOnTop !== prev.alwaysOnTop) applyAlwaysOnTop();
  if (settings.hotkey !== prev.hotkey) registerHotkey();
  notifyPanel();
}

function setLock(on, announce = true) {
  update({ lock: { enabled: !!on } });
  if (announce) send('say', { text: on ? 'Staying put!' : 'Free to roam!', ms: 2200 });
}

function setSpotHere() {
  const k = gridPx();
  update({
    lock: { spot: 'custom', custom: { x: Math.round(cat.x + size / 2), y: Math.round(cat.y + CENTER_ROW * k) } }
  });
  send('say', { text: 'Spot saved!', ms: 2000 });
}

// ------------------------------------------------------------------ focus timers
const timers = [];
let timerSeq = 0;

function startTimer(label, minutes) {
  const mins = num(minutes, 0.1, 600, 25);
  const t = { id: ++timerSeq, label: cleanName(label), total: mins * 60000, endsAt: Date.now() + mins * 60000 };
  t.handle = setTimeout(() => {
    const i = timers.indexOf(t);
    if (i >= 0) timers.splice(i, 1);
    if (win && !win.isVisible()) win.showInactive();
    stretchUntil = Date.now() + 12000;   // stay put while it celebrates
    send('timer-end', { label: t.label });
    notifyPanel();
  }, mins * 60000);
  timers.push(t);
  send('timer-start', { label: t.label, minutes: mins });
  notifyPanel();
}

function cancelTimer(id) {
  const i = timers.findIndex((t) => t.id === id);
  if (i < 0) return;
  clearTimeout(timers[i].handle);
  timers.splice(i, 1);
  notifyPanel();
}

ipcMain.handle('timer:start', (_e, label, minutes) => { startTimer(label, minutes); return panelState(); });
ipcMain.handle('timer:cancel', (_e, id) => { cancelTimer(id); return panelState(); });

// ------------------------------------------------------------------ settings window
function openPanel() {
  if (panel && !panel.isDestroyed()) {
    panel.show();
    panel.focus();
    return;
  }
  panel = new BrowserWindow({
    width: 460,
    height: 700,
    minWidth: 400,
    minHeight: 480,
    title: 'Pixel Cat Settings',
    autoHideMenuBar: true,
    backgroundColor: '#1b1b22',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'settings', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  panel.setMenuBarVisibility(false);
  panel.loadFile(path.join(__dirname, 'settings', 'settings.html'));
  // first run: ask for the cat's name straight away
  panel.once('ready-to-show', () => {
    // pop to the front even when launched from the background
    panel.setAlwaysOnTop(true);
    panel.show();
    panel.focus();
    setTimeout(() => { if (panel && !panel.isDestroyed()) panel.setAlwaysOnTop(false); }, 1000);
  });
  panel.on('closed', () => { panel = null; });
}

ipcMain.handle('settings:get', () => panelState());
ipcMain.handle('settings:set', (_e, patch) => {
  if (isObj(patch)) {
    const { login, ...rest } = patch;
    if (typeof login === 'boolean') setLogin(login);
    update(rest);
  }
  return panelState();
});
ipcMain.handle('settings:reset', () => {
  settings = sanitize(deepMerge(DEFAULTS, {}));
  saveSettings();
  applyScale();
  scheduleStretch();
  syncHook();
  applyAlwaysOnTop();
  registerHotkey();
  notifyPanel();
  return panelState();
});
ipcMain.handle('settings:action', (_e, name) => {
  switch (name) {
    case 'spot-here': setSpotHere(); break;
    case 'stretch-now': fireStretch(); break;
    case 'toggle-hide':
      if (win) { if (win.isVisible()) win.hide(); else win.showInactive(); }
      notifyPanel();
      break;
    case 'quit': app.quit(); break;
    default: break;
  }
  return panelState();
});

// ------------------------------------------------------------------ tray + menu
function buildMenu() {
  const visible = !!(win && win.isVisible());
  return Menu.buildFromTemplate([
    { label: 'Settings…', click: () => openPanel() },
    { type: 'separator' },
    {
      label: 'Lock in corner',
      type: 'checkbox',
      checked: settings.lock.enabled,
      accelerator: settings.hotkey || undefined,
      click: (item) => setLock(item.checked)
    },
    { label: 'Use current position as lock spot', click: () => setSpotHere() },
    {
      label: 'Follow my cursor',
      type: 'checkbox',
      checked: settings.follow,
      click: (item) => update({ follow: item.checked })
    },
    { type: 'separator' },
    {
      label: 'Size',
      submenu: Object.entries(SIZE_PRESETS).map(([name, value]) => ({
        label: name[0].toUpperCase() + name.slice(1),
        type: 'radio',
        checked: Math.abs(settings.scale - value) < 0.05,
        click: () => update({ scale: value })
      }))
    },
    {
      label: 'Start a timer',
      submenu: settings.timerPresets.length
        ? settings.timerPresets.map((p) => ({
          label: (p.label || 'Timer') + ' (' + p.minutes + ' min)',
          click: () => startTimer(p.label, p.minutes)
        }))
        : [{ label: 'Add presets in Settings', enabled: false }]
    },
    { label: 'Stretch now', enabled: visible, click: () => fireStretch() },
    {
      label: visible ? 'Hide cat (pauses reminders)' : 'Show cat',
      click: () => {
        if (!win) return;
        if (win.isVisible()) win.hide(); else win.showInactive();
        notifyPanel();
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Pixel Cat (click for settings)');
  tray.on('click', () => openPanel());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

// ------------------------------------------------------------------ cat IPC
ipcMain.on('ready', () => sendConfig(true));

ipcMain.on('drag-start', () => {
  const cur = screen.getCursorScreenPoint();
  drag.active = true;
  drag.dx = cur.x - cat.x;
  drag.dy = cur.y - cat.y;
});

ipcMain.on('drag-end', () => { drag.active = false; });
ipcMain.on('stretch-done', () => { stretchUntil = 0; });
ipcMain.on('show-menu', () => {
  if (win) buildMenu().popup({ window: win });
});

// ------------------------------------------------------------------ lifecycle
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isVisible()) win.showInactive();
    openPanel();
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    app.setAppUserModelId('com.pixelcat.companion');
    settings = loadSettings();
    createWindow();
    createTray();
    setupHook();
    syncHook();
    scheduleStretch();
    registerHotkey();
    if (settings.name === null) openPanel();
    // dev/test hook: PIXELCAT_TEST_TIMER=<seconds> starts a timer shortly after launch
    const testTimer = Number(process.env.PIXELCAT_TEST_TIMER);
    if (testTimer > 0) setTimeout(() => startTimer('Focus', testTimer / 60), 3500);
    setInterval(tick, 1000 / 60);
  });

  // The cat lives in the tray; closing windows must not quit the app.
  app.on('window-all-closed', (e) => e.preventDefault());

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    try { if (uIOhook && hookRunning) uIOhook.stop(); } catch { /* ignore */ }
  });
}
