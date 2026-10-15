(() => {
  'use strict';

  const COAT_INFO = {
    indie: { label: 'Indie', fur: '#c48a4e', outline: '#3a2415' },
    persian: { label: 'Persian', fur: '#f3ead9', outline: '#5a4a3a' },
    black: { label: 'Black', fur: '#34343f', outline: '#0b0b10' }
  };

  const $ = (sel) => document.querySelector(sel);
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  const patchFor = (path, value) => path.split('.').reduceRight((acc, k) => ({ [k]: acc }), value);
  const fmt = (key, v) => (key === 'scale' ? Number(v).toFixed(1) + 'x' : String(Math.round(v)));

  let timer = null;

  function render(s) {
    const cfg = s.settings;
    document.querySelectorAll('[data-key]').forEach((el) => {
      if (document.activeElement === el && el.type !== 'checkbox' && el.tagName !== 'SELECT') return;
      const key = el.dataset.key;
      const v = key === 'login' ? s.runtime.login : key === 'tips' ? cfg.tips.join('\n') : get(cfg, key);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v == null ? '' : v;
    });
    document.querySelectorAll('[data-out]').forEach((o) => {
      o.textContent = fmt(o.dataset.out, get(cfg, o.dataset.out));
    });
    $('#hide').textContent = s.runtime.visible ? 'Hide cat' : 'Show cat';
    const mod = s.runtime.platform === 'darwin' ? 'Cmd' : 'Ctrl';
    $('#hotkey-hint').textContent = cfg.hotkey
      ? 'Hotkey: ' + cfg.hotkey.replace('CommandOrControl', mod)
      : 'Hotkey is disabled.';
    $('#typing').disabled = !s.runtime.hook;
    document.querySelectorAll('.coat').forEach((b) => b.classList.toggle('on', b.dataset.coat === cfg.coat));
    $('#welcome').classList.toggle('show', s.firstRun);
    timerState = { timers: s.timers || [], offset: (s.now || Date.now()) - Date.now(), presets: cfg.timerPresets || [] };
    renderActive();
    renderPresets();
  }

  // ---- focus timers
  let timerState = { timers: [], offset: 0, presets: [] };

  const fmtLeft = (ms) => {
    const sec = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  function renderActive() {
    const box = $('#t-active');
    box.textContent = '';
    timerState.timers.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'timer-row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = t.label || 'Timer';
      const left = document.createElement('span');
      left.className = 'left';
      left.textContent = fmtLeft(t.endsAt - (Date.now() + timerState.offset));
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => window.panel.timerCancel(t.id).then(render));
      row.append(name, left, cancel);
      box.appendChild(row);
    });
  }

  function renderPresets() {
    const box = $('#t-presets');
    box.textContent = '';
    timerState.presets.forEach((p, i) => {
      const chip = document.createElement('button');
      chip.className = 'preset chip';
      chip.textContent = (p.label || 'Timer') + ' · ' + p.minutes + 'm';
      chip.addEventListener('click', () => window.panel.timerStart(p.label, p.minutes).then(render));
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Remove preset';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = timerState.presets.filter((_, k) => k !== i);
        window.panel.set({ timerPresets: next }).then(render);
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  $('#t-start').addEventListener('click', () => {
    const mins = Number($('#t-min').value);
    if (!(mins > 0)) return;
    window.panel.timerStart($('#t-label').value, mins).then(render);
  });
  $('#t-save').addEventListener('click', () => {
    const mins = Number($('#t-min').value);
    if (!(mins > 0)) return;
    const next = timerState.presets.concat([{ label: $('#t-label').value, minutes: mins }]).slice(0, 8);
    window.panel.set({ timerPresets: next }).then(render);
  });
  setInterval(renderActive, 1000);

  function send(key, value) {
    const patch = key === 'login' ? { login: value } : patchFor(key, value);
    window.panel.set(patch).then(render);
  }

  function onInput(el) {
    const key = el.dataset.key;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'range' || el.type === 'number') v = Number(el.value);
    else if (key === 'tips') v = el.value.split('\n');
    else v = el.value;
    if (typeof v === 'number' && Number.isNaN(v)) return;
    const out = document.querySelector('[data-out="' + key + '"]');
    if (out) out.textContent = fmt(key, v);
    clearTimeout(timer);
    const instant = el.type === 'checkbox' || el.tagName === 'SELECT';
    timer = setTimeout(() => send(key, v), instant ? 0 : 60);
  }

  document.querySelectorAll('[data-key]').forEach((el) => {
    const evt = el.tagName === 'TEXTAREA' || el.type === 'text' ? 'change' : 'input';
    el.addEventListener(evt, () => onInput(el));
  });

  document.querySelectorAll('[data-action]').forEach((b) => {
    b.addEventListener('click', () => window.panel.action(b.dataset.action).then(render));
  });

  const coats = $('#coats');
  Object.entries(COAT_INFO).forEach(([id, c]) => {
    const b = document.createElement('button');
    b.className = 'coat';
    b.dataset.coat = id;
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = c.fur;
    sw.style.borderColor = c.outline;
    b.appendChild(sw);
    b.appendChild(document.createTextNode(c.label));
    b.addEventListener('click', () => window.panel.set({ coat: id }).then(render));
    coats.appendChild(b);
  });

  function startNamed() {
    const v = $('#welcome-name').value;
    window.panel.set({ name: v }).then(render);
  }
  $('#welcome-go').addEventListener('click', startNamed);
  $('#welcome-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') startNamed(); });

  $('#reset').addEventListener('click', () => {
    window.panel.reset().then(render);
  });

  window.panel.onChange(render);
  window.panel.get().then(render);
})();
