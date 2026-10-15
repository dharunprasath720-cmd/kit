// Pixel Cat renderer: draws the cat procedurally on a 60x60 pixel grid, adds an
// automatic outline, and scales it up with nearest-neighbour filtering.
(() => {
  'use strict';

  const api = window.catAPI || { on() {}, send() {} };
  const Font = window.PixelFont;

  const LOGICAL = 60;      // size of the pixel grid
  const GROUND = 51;       // grid row of the floor line (leaves room below for the name label)
  const CX = 30;           // grid column of the cat's centre line
  let SLEEP_AFTER = 45000;
  let SLEEPY_AFTER = 25000;
  let PET_REACTIONS = true;

  const PAL = {
    outline: '#3b2314',
    fur: '#f0983a',
    fur2: '#d9822b',
    furDark: '#b5601a',
    furFar: '#c9731f',
    cream: '#fff0d4',
    pink: '#ff8fa3',
    blush: '#ff9fb2',
    eye: '#1b120b',
    iris: '#8fbf3f',
    white: '#ffffff',
    zzz: '#9fb4ff',
    heart: '#ff5a7a',
    paper: '#fffdf4',
    tag: '#ffd23f'
  };
  const OUTLINE_RGB = [0x3b, 0x23, 0x14];

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // factor > 0 lightens towards white, < 0 darkens towards black
  function shade(hex, factor) {
    const c = hexToRgb(hex) || [128, 128, 128];
    const t = factor < 0 ? 0 : 255;
    const f = Math.abs(factor);
    return '#' + c.map((v) => Math.round(v + (t - v) * f).toString(16).padStart(2, '0')).join('');
  }

  function applyColors(c) {
    if (!c) return;
    if (hexToRgb(c.fur)) { PAL.fur = c.fur; PAL.fur2 = shade(c.fur, -0.12); PAL.furFar = shade(c.fur, -0.2); }
    if (hexToRgb(c.markings)) PAL.furDark = c.markings;
    if (hexToRgb(c.belly)) PAL.cream = c.belly;
    if (hexToRgb(c.eyes)) PAL.iris = c.eyes;
    if (hexToRgb(c.pink)) { PAL.pink = c.pink; PAL.blush = shade(c.pink, 0.2); }
    if (hexToRgb(c.outline)) {
      PAL.outline = c.outline;
      const rgb = hexToRgb(c.outline);
      OUTLINE_RGB[0] = rgb[0]; OUTLINE_RGB[1] = rgb[1]; OUTLINE_RGB[2] = rgb[2];
    }
  }

  const MEOWS = ['MEOW!', 'PURR...', 'MRRP?', 'MROW!', 'NYA!'];

  const HEART = ['.#.#.', '#####', '#####', '.###.', '..#..'];

  // ---------------------------------------------------------------- state
  const S = {
    scale: 3.4,            // css pixels per grid pixel
    size: 204,             // css size of the (square) window
    dpr: window.devicePixelRatio || 1,
    vx: 0, vy: 0,          // window velocity (px/s) from the main process
    dx: 0, dy: 0,          // cursor relative to the cat (px)
    idle: 0,               // ms since the last mouse/keyboard activity
    dragging: false,
    walking: false, facing: 1, walkPhase: 0,
    lastKey: -1e9, scratchSide: 1, scratchUntil: 0, nextScratch: 25000,
    nextYawn: 9000, yawnStart: 0, yawnUntil: 0, hover: false, hoverSince: 0, running: false, runPhase: 0,
    stretchUntil: 0, petUntil: 0, hopAt: -1e9,
    bubble: null,          // { lines, until, kind }
    hearts: [],
    nextBlink: 2000, blinkUntil: 0,
    nextTwitch: 5000, twitchUntil: 0, twitchSide: 1,
    topRow: 30,
    name: '', alertUntil: 0, nextAlertHeart: 0, speed: 0, dAng: 0, dVel: 0, dragV: 0, dragX: 0, dragT: 0
  };

  // ---------------------------------------------------------------- canvases
  const canvas = document.getElementById('cat');
  const view = canvas.getContext('2d');
  const off = document.createElement('canvas');
  off.width = off.height = LOGICAL;
  const g = off.getContext('2d', { willReadFrequently: true });
  const tmp = document.createElement('canvas');
  tmp.width = tmp.height = LOGICAL;
  const tg = tmp.getContext('2d');

  function resize() {
    S.dpr = window.devicePixelRatio || 1;
    const css = S.size;
    canvas.style.width = css + 'px';
    canvas.style.height = css + 'px';
    canvas.width = Math.round(css * S.dpr);
    canvas.height = Math.round(css * S.dpr);
  }

  // ---------------------------------------------------------------- drawing helpers
  let ox = 0;            // pose-local x offset
  let oy = 0;            // pose-local lift
  let post = [];         // drawn after the outline pass

  // Rect in cat space: x from the centre line, y up from the floor.
  function R(x, y, w, h, c) {
    g.fillStyle = c;
    g.fillRect(CX + ox + x, GROUND - oy - y - h, w, h);
  }

  function later(fn) {
    const px = ox, py = oy;
    post.push(() => {
      const a = ox, b = oy;
      ox = px; oy = py;
      fn();
      ox = a; oy = b;
    });
  }

  function sprite(rows, x, y, color) {
    g.fillStyle = color;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c] === '#') g.fillRect(x + c, y + r, 1, 1);
      }
    }
  }

  // ---------------------------------------------------------------- head
  // H(x, y, w, h, colour): head-space rect (x from head centre, y up from chin) that
  // follows the head's tilt, so eyes, ears and whiskers all lean together.
  function drawEyes(H, kind, lx, up) {
    const E = PAL.eye;
    for (const side of [-1, 1]) {
      const ex = side < 0 ? -6 : 3;               // 3 px wide eyes
      switch (kind) {
        case 'open':
        case 'half': {
          const h = kind === 'open' ? 3 : 2;
          H(ex, 5 + up, 3, h, PAL.iris);          // coloured iris
          H(ex + 1 + lx, 5 + up, 1, h, E);        // pupil slides inside it
          if (kind === 'open') H(lx < 0 ? ex + 2 : ex, 7 + up, 1, 1, PAL.white); // catch-light
          break;
        }
        case 'closed':
          H(ex, 6, 3, 1, E);
          break;
        case 'happy': // ^ ^
          H(ex, 5, 1, 1, E); H(ex + 1, 6, 1, 1, E); H(ex + 2, 5, 1, 1, E);
          break;
        case 'squeeze': // > <
          if (side < 0) { H(ex, 7, 1, 1, E); H(ex + 1, 6, 1, 1, E); H(ex, 5, 1, 1, E); }
          else { H(ex + 2, 7, 1, 1, E); H(ex + 1, 6, 1, 1, E); H(ex + 2, 5, 1, 1, E); }
          break;
        default:
          break;
      }
    }
  }

  function drawMouth(H, kind) {
    const yawn = kind && kind.yawn !== undefined ? kind.yawn : -1;
    H(-1, yawn > 0.5 ? 4 : 3, 2, 1, PAL.pink); // nose (rides up as the mouth opens)
    if (kind === 'open') {
      H(-1, 1, 2, 2, PAL.eye);
      H(-1, 1, 2, 1, PAL.pink);
    } else if (yawn >= 0) {
      const w = yawn > 0.75 ? 6 : yawn > 0.5 ? 4 : yawn > 0.2 ? 2 : 0;
      const h = yawn > 0.8 ? 4 : yawn > 0.55 ? 3 : yawn > 0.3 ? 2 : yawn > 0.1 ? 1 : 0;
      if (w && h) {
        H(-w / 2, 0, w, h, PAL.eye);
        if (h >= 2) H(-w / 2 + 1, 0, w - 2, 1, PAL.pink);      // tongue
        if (w >= 4) {                                           // little fangs
          H(-w / 2, h - 1, 1, 1, PAL.white);
          H(w / 2 - 1, h - 1, 1, 1, PAL.white);
        }
      }
    } else if (kind === 'w') {
      H(-2, 2, 1, 1, PAL.eye);
      H(1, 2, 1, 1, PAL.eye);
      H(-1, 1, 2, 1, PAL.eye);
    }
  }

  // Heads are drawn upright on a scratch canvas when they need rotating, then the
  // whole sprite is turned around the chin, so the shape never changes.
  const hc = document.createElement('canvas');
  hc.width = 48;
  hc.height = 48;
  const hctx = hc.getContext('2d');
  const HX = 24;
  const HY = 34;

  // Front-facing head, 16 wide x 14 tall (with ears). hy = chin row.
  // o.rot tips the head (radians, + = clockwise); o.faceUp lifts the eyes.
  function head(hx, hy, o = {}) {
    const [lx] = o.look || [0, 0];
    const rot = o.rot || 0;
    if (rot) hctx.clearRect(0, 0, 48, 48);
    const H = (x, y, w, h, c) => {
      if (rot) {
        hctx.fillStyle = c;
        hctx.fillRect(HX + x, HY - y - h, w, h);
      } else {
        R(hx + x, hy + y, w, h, c);
      }
    };
    const rows = [[-5, 10], [-7, 14], [-7, 14], [-8, 16], [-8, 16], [-8, 16], [-8, 16], [-8, 16], [-8, 16], [-7, 14], [-6, 12]];
    rows.forEach(([x, w], i) => H(x, i, w, 1, PAL.fur));

    for (const side of [-1, 1]) {
      const d = side < 0 ? (o.earL || 0) : (o.earR || 0);
      for (let i = 0; i < 4; i++) {
        const w = 4 - i;
        H(side < 0 ? -8 : 8 - w, 10 + i - d, w, 1, PAL.fur);
      }
      H(side < 0 ? -7 : 5, 10 - d, 2, 1, PAL.pink);
      H(side < 0 ? -7 : 6, 11 - d, 1, 1, PAL.pink);
    }

    // tabby markings
    H(-1, 8, 2, 3, PAL.furDark);
    H(-4, 8, 1, 2, PAL.furDark);
    H(3, 8, 1, 2, PAL.furDark);
    H(-8, 5, 2, 1, PAL.furDark);
    H(6, 5, 2, 1, PAL.furDark);

    H(-3, 0, 6, 4, PAL.cream); // muzzle + chin
    drawEyes(H, o.eyes || 'open', lx, o.faceUp || 0);
    drawMouth(H, o.mouth || 'w');
    if (o.blush) {
      H(-7, 3, 2, 1, PAL.blush);
      H(5, 3, 2, 1, PAL.blush);
    }

    if (rot) {
      g.save();
      g.translate(CX + ox + hx, GROUND - oy - hy);
      g.rotate(rot);
      g.imageSmoothingEnabled = false;
      g.drawImage(hc, -HX, -HY);
      g.restore();
    }

    later(() => { // whiskers sit outside the outline
      if (!rot) {
        for (const y of [3, 5]) {
          R(hx - 11, hy + y, 2, 1, PAL.outline);
          R(hx + 9, hy + y, 2, 1, PAL.outline);
        }
      } else {
        // rotate each whisker pixel by hand so they stay crisp
        const c = Math.cos(rot);
        const sn = Math.sin(rot);
        g.fillStyle = PAL.outline;
        for (const y of [3, 5]) {
          for (const x of [-11, -10, 9, 10]) {
            const px = x + 0.5;
            const py = -(y + 0.5);
            const rx = px * c - py * sn;
            const ry = px * sn + py * c;
            g.fillRect(Math.round(CX + ox + hx + rx - 0.5), Math.round(GROUND - oy - hy + ry - 0.5), 1, 1);
          }
        }
      }
    });
  }

  // ---------------------------------------------------------------- bodies
  function tailUp(x0, y0, sway) {
    R(x0, y0, 3, 2, PAL.fur);
    R(x0 + 2, y0 + 2, 2, 5, PAL.fur);
    R(x0 + 2, y0 + 4, 2, 1, PAL.furDark);
    R(x0 + 2 + sway, y0 + 7, 2, 3, PAL.fur);
    R(x0 + 1 + sway * 2, y0 + 10, 3, 2, PAL.furDark);
  }

  function bodyFront() {
    R(-8, 0, 16, 5, PAL.fur);        // haunches
    R(-6, 5, 12, 5, PAL.fur);        // torso
    R(-3, 3, 6, 7, PAL.cream);       // chest
    R(-5, 0, 4, 5, PAL.cream);       // front legs
    R(1, 0, 4, 5, PAL.cream);
    R(-1, 0, 2, 4, PAL.furDark);     // gap between legs
    R(-8, 2, 2, 1, PAL.furDark);
    R(6, 2, 2, 1, PAL.furDark);
    R(-6, 6, 1, 2, PAL.furDark);
    R(5, 6, 1, 2, PAL.furDark);
  }

  // ---------------------------------------------------------------- poses
  function lookDir() {
    return [
      S.dx > 40 ? 1 : S.dx < -40 ? -1 : 0,
      S.dy < -40 ? 1 : S.dy > 40 ? -1 : 0
    ];
  }

  function earDrops(now) {
    if (now < S.twitchUntil) return S.twitchSide < 0 ? { earL: 1 } : { earR: 1 };
    return {};
  }

  const POSES = {
    sit(now, t) {
      const [lx, ly] = lookDir();
      const sway = Math.round(Math.sin(t * 2.4));
      const breath = Math.sin(t * 2.2) > 0.55 ? 1 : 0;
      let eyes = 'open';
      if (now < S.petUntil) eyes = 'happy';
      else if (now < S.blinkUntil) eyes = 'closed';
      else if (S.idle > SLEEPY_AFTER) eyes = 'half';
      // regular yawns while idling
      if (now >= S.yawnUntil && now > S.nextYawn && S.idle > 6000 && S.idle < SLEEP_AFTER) {
        S.yawnStart = now;
        S.yawnUntil = now + 1900;
        S.nextYawn = now + 11000 + Math.random() * 2000;
      }
      let mouth = 'w';
      let lift = 0;
      let up = 0;
      let ears = earDrops(now);
      if (now < S.yawnUntil) {
        const p = (now - S.yawnStart) / 1900;
        const amt = Math.max(0, p < 0.35 ? p / 0.35 : p < 0.7 ? 1 : (1 - p) / 0.3);
        mouth = { yawn: amt };
        eyes = amt > 0.15 ? 'squeeze' : eyes;
        lift = Math.round(amt * 2);          // head tips back a little more as it opens
        up = amt > 0.5 ? 1 : 0;
        ears = { earL: 1, earR: 1 };
      }
      ox = 0;
      tailUp(8, 0, sway);
      bodyFront();
      head(lx, 8 + breath + lift, Object.assign({
        look: [lx, ly], eyes, mouth, faceUp: up, blush: now < S.petUntil
      }, ears));
    },

    // Sitting; the whole head tips back and away so the neck is bared, and one hind
    // leg reaches up, straight, beside the body to scratch it. Sides alternate.
    scratch(now, t) {
      const side = S.scratchSide;
      const flip = (x, w) => (side > 0 ? x : -x - w);
      const Rs = (x, y, w, h, c) => R(flip(x, w), y, w, h, c);
      const fast = Math.floor(t * 16) % 2;          // paw rubs back and forth
      const sway = Math.round(Math.sin(t * 2.4));
      ox = 0;
      tailUp(8, 0, sway);
      bodyFront();
      R(-4, 7, 8, 4, PAL.fur);                      // neck, stretched out
      R(-2, 7, 4, 4, PAL.cream);                    // bared throat
      // hind leg: one straight stroke from the haunch up to the neck
      for (let i = 0; i <= 9; i++) {
        const sx = Math.round(9 - i * 0.33);
        Rs(sx, 1 + i, 3, 1, PAL.fur);
        Rs(sx, 1 + i, 1, 1, PAL.furDark);
      }
      head(0, 10, Object.assign({
        look: [0, 0], eyes: 'happy', mouth: 'w', blush: true, rot: -side * 0.3
      }, side > 0 ? { earR: 1 } : { earL: 1 }));
      Rs(5 - fast, 9 + fast, 4, 3, PAL.cream);      // paw working at the neck
      Rs(5 - fast, 11 + fast, 4, 1, PAL.fur2);
      later(() => {                                 // scratch ticks
        const k = Math.floor(t * 9) % 2;
        R(flip(11, 1), 11 + k, 1, 1, PAL.outline);
        R(flip(13, 1), 10 - k, 1, 1, PAL.outline);
      });
    },

    // Timer alert: hopping on the spot, purr-trembling, happy.
    alert(now, t) {
      const k = Math.abs(Math.sin(t * 6.5));
      const sway = Math.round(Math.sin(t * 9));
      oy += Math.round(k * 8);
      ox = Math.floor(t * 28) % 2;                  // purr tremble
      tailUp(8, 0, sway);
      bodyFront();
      head(0, 8 + (k > 0.6 ? 1 : 0), { eyes: 'happy', mouth: 'open', blush: true, look: [0, 0] });
    },

    walk(now, t) {
      const p = Math.floor(S.walkPhase) % 4;
      const a = [2, 0, -2, 0][p];
      const liftA = [0, 1, 0, 0][p];
      const b = -a;
      const liftB = [0, 0, 0, 1][p];
      const bob = (p === 1 || p === 3) ? 1 : 0;
      const sway = Math.round(Math.sin(S.walkPhase * 1.2));
      ox = 1;
      // tail
      R(-14, 9 + bob, 3, 2, PAL.fur);
      R(-15, 11 + bob, 2, 5, PAL.fur);
      R(-15, 13 + bob, 2, 1, PAL.furDark);
      R(-15 + sway, 16 + bob, 2, 3, PAL.fur);
      R(-16 + sway, 19 + bob, 3, 2, PAL.furDark);
      // far legs (behind the body)
      R(-7 + b, liftB, 3, 5 - liftB, PAL.furFar);
      R(-7 + b, liftB, 3, 2, PAL.cream);
      R(-2 + a, liftA, 3, 5 - liftA, PAL.furFar);
      R(-2 + a, liftA, 3, 2, PAL.cream);
      // body
      const by = 5 + bob;
      R(-10, by, 14, 1, PAL.fur);
      R(-11, by + 1, 16, 6, PAL.fur);
      R(-10, by + 7, 14, 1, PAL.fur);
      R(-8, by, 11, 2, PAL.cream);
      R(-9, by + 5, 1, 3, PAL.furDark);
      R(-6, by + 5, 1, 3, PAL.furDark);
      R(-3, by + 5, 1, 3, PAL.furDark);
      // near legs
      R(-10 + a, liftA, 3, 5 - liftA, PAL.fur);
      R(-10 + a, liftA, 3, 2, PAL.cream);
      R(1 + b, liftB, 3, 5 - liftB, PAL.fur);
      R(1 + b, liftB, 3, 2, PAL.cream);
      head(6, 8 + bob, Object.assign({
        look: [1, 0], eyes: now < S.blinkUntil ? 'closed' : 'open', mouth: 'w'
      }, earDrops(now)));
    },

    // Cat gallop: extend, gather in the air, front paws land, hind legs push.
    run(now, t) {
      const ph = S.runPhase % 1;
      const q = Math.floor(ph * 4);
      const frac = ph * 4 - q;
      // [airborne height, body arch, head drop, front paw (x,y), hind paw (x,y)]
      const F = [
        { lift: 5, arch: 0, front: [11, 1], hind: [-18, 1], kneeF: [6, 5], kneeH: [-14, 4] },   // extended flight
        { lift: 6, arch: 3, front: [3, 1], hind: [-5, 1], kneeF: [4, 4], kneeH: [-7, 4] },      // gathered flight
        { lift: 2, arch: 1, front: [9, 0], hind: [-7, 1], kneeF: [7, 3], kneeH: [-8, 3] },      // front paws land
        { lift: 1, arch: 0, front: [3, 0], hind: [-14, 0], kneeF: [3, 3], kneeH: [-12, 3] }     // hind push-off
      ];
      const f = F[q];
      const g2 = F[(q + 1) % 4];
      const lift = Math.round(f.lift + (g2.lift - f.lift) * frac * 0.5);
      ox = 4;
      oy += lift;
      const ub = 4;                                      // belly line
      const x0 = -12 + (q === 1 ? 2 : 0);
      const x1 = 5 - (q === 1 ? 1 : 0);
      const wave = Math.round(Math.sin(ph * Math.PI * 4));

      const leg = (x0_, y0_, x1_, y1_, color) => {
        const n = Math.max(Math.abs(x1_ - x0_), Math.abs(y1_ - y0_), 1);
        for (let i = 0; i <= n; i++) {
          R(Math.round(x0_ + (x1_ - x0_) * i / n), Math.round(y0_ + (y1_ - y0_) * i / n), 2, 2, color);
        }
      };

      // tail streaming straight back
      R(-21, ub + 5 + wave, 9, 2, PAL.fur);
      R(-24, ub + 5 + wave, 3, 2, PAL.furDark);
      R(-17, ub + 5 + wave, 1, 2, PAL.furDark);
      // far legs, a touch behind and darker
      leg(3, ub + 2, f.front[0] - 2, f.front[1], PAL.furFar);
      leg(-8, ub + 2, f.hind[0] + 2, f.hind[1], PAL.furFar);
      // arched body
      for (let x = x0; x <= x1; x++) {
        const k = (x - x0) / (x1 - x0);
        const e = Math.round(f.arch * Math.sin(k * Math.PI));
        R(x, ub + e, 1, 6, PAL.fur);
        R(x, ub + e, 1, 2, PAL.cream);
      }
      for (const x of [x0 + 2, x0 + 5, x0 + 8]) {
        const k = (x - x0) / (x1 - x0);
        R(x, ub + 3 + Math.round(f.arch * Math.sin(k * Math.PI)), 1, 3, PAL.furDark);
      }
      // near legs, bending at the knee
      leg(2, ub + 3, f.kneeF[0], f.kneeF[1], PAL.fur);
      leg(f.kneeF[0], f.kneeF[1], f.front[0], f.front[1], PAL.fur);
      R(f.front[0], f.front[1], 3, 2, PAL.cream);
      leg(-10, ub + 3, f.kneeH[0], f.kneeH[1], PAL.fur);
      leg(f.kneeH[0], f.kneeH[1], f.hind[0], f.hind[1], PAL.fur);
      R(f.hind[0] - 1, f.hind[1], 3, 2, PAL.cream);
      head(8, ub + (q === 1 ? 3 : 1), {
        look: [1, 0], eyes: 'open', mouth: 'w', earL: 1, earR: 1
      });
    },

    stretch(now, t) {
      const sway = Math.round(Math.sin(t * 3));
      const tremble = Math.floor(t * 16) % 2;
      ox = -2;
      // hind legs
      R(-12, 0, 3, 10, PAL.fur);
      R(-12, 0, 3, 2, PAL.cream);
      // tail
      R(-14, 11, 2, 7, PAL.fur);
      R(-14, 14, 2, 1, PAL.furDark);
      R(-14 + sway, 18, 2, 3, PAL.fur);
      R(-15 + sway, 21, 3, 2, PAL.furDark);
      // back: slanted band, rump high, chest low
      const bandTop = (x) => Math.round(18 - 9 * ((x + 12) / 16));
      for (let x = -12; x < 5; x++) {
        const k = (x + 12) / 16;
        const top = bandTop(x);
        R(x, top - 9, 1, 9, PAL.fur);
        if (k > 0.1 && k < 0.9) R(x, top - 9, 1, 2, PAL.cream);
      }
      for (const x of [-10, -7, -4, -1]) {
        R(x, bandTop(x) - 4, 1, 4, PAL.furDark);
      }
      // front legs reaching forward
      for (let x = 2; x < 15; x++) {
        R(x, Math.round(5 - 5 * (x - 2) / 12), 1, 2, PAL.fur);
      }
      R(13, 0, 5, 2, PAL.cream);
      head(9, 1 + tremble, { eyes: 'happy', mouth: 'open', blush: true });
    },

    sleep(now, t) {
      const br = Math.sin(t * 1.6) > 0 ? 1 : 0;
      ox = 0;
      R(-9, 0, 18, 1, PAL.fur);
      R(-10, 1, 20, 5, PAL.fur);
      R(-9, 6, 18, 1 + br, PAL.fur);
      R(-6, 7 + br, 12, 1, PAL.fur);
      R(-8, 3, 1, 3, PAL.furDark);
      R(-5, 4, 1, 3, PAL.furDark);
      R(4, 4, 1, 3, PAL.furDark);
      R(7, 3, 1, 3, PAL.furDark);
      R(-9, 0, 18, 2, PAL.fur2);       // tail wrapped around the front
      R(5, 0, 4, 2, PAL.furDark);
      head(1, 4 + br, { eyes: 'closed', mouth: 'w', earL: 1 });
    },

    // Picked up by the scruff: head and chest hold still, the hips, hind legs and
    // tail swing like a pendulum from the cursor's motion.
    dragged(now, t) {
      const ang = S.dAng + Math.sin(t * 3.2) * 0.6;
      const dep = (y) => Math.round(ang * Math.max(0, Math.min(1.4, (17 - y) / 12)));
      const Rd = (x, y, w, h, c, mul = 1) => {
        for (let r = 0; r < h; r++) R(x + Math.round(dep(y + r) * mul), y + r, w, 1, c);
      };
      ox = 0;
      Rd(6, 5, 2, 10, PAL.fur, 1.4);               // tail, lagging a little more
      Rd(6, 5, 2, 3, PAL.furDark, 1.4);
      Rd(-5, 4, 3, 8, PAL.fur);                    // hind legs
      Rd(-5, 4, 3, 2, PAL.cream);
      Rd(2, 4, 3, 8, PAL.fur);
      Rd(2, 4, 3, 2, PAL.cream);
      Rd(-6, 10, 12, 5, PAL.fur);                  // hips
      Rd(-5, 15, 10, 6, PAL.fur);                  // belly
      Rd(-3, 10, 6, 11, PAL.cream);
      Rd(-6, 11, 1, 2, PAL.furDark);
      Rd(5, 11, 1, 2, PAL.furDark);
      R(-6, 21, 12, 4, PAL.fur);                   // chest (fixed)
      R(-3, 21, 6, 4, PAL.cream);
      R(-5, 18, 3, 3, PAL.cream);                  // front paws tucked up
      R(2, 18, 3, 3, PAL.cream);
      head(0, 24, { eyes: 'open', look: [0, -1], mouth: 'w' });
    }
  };

  const SIDE_VIEW = { walk: true, run: true, stretch: true };

  function pickPose(now) {
    if (S.dragging) return 'dragged';
    if (now < S.alertUntil) return 'alert';
    if (now < S.stretchUntil) return 'stretch';
    if (S.walking) return S.running ? 'run' : 'walk';
    if (now - S.lastKey < 1100 || now < S.scratchUntil) return 'scratch';
    if (S.idle > SLEEP_AFTER) return 'sleep';
    return 'sit';
  }

  // ---------------------------------------------------------------- post passes
  function particles(now, pose) {
    for (const h of S.hearts) {
      const k = (now - h.t) / 1400;
      const x = CX + h.x + Math.round(Math.sin(k * 6 + h.p) * 2) - 2;
      const y = GROUND - 27 - Math.round(k * 14);
      sprite(HEART, x, y, PAL.heart);
    }
  }

  function outline() {
    const img = g.getImageData(0, 0, LOGICAL, LOGICAL);
    const d = img.data;
    const solid = new Uint8Array(LOGICAL * LOGICAL);
    for (let i = 0; i < solid.length; i++) solid[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    let top = LOGICAL;
    for (let y = 0; y < LOGICAL; y++) {
      for (let x = 0; x < LOGICAL; x++) {
        const i = y * LOGICAL + x;
        if (solid[i]) {
          if (y < top) top = y;
          continue;
        }
        if ((x > 0 && solid[i - 1]) || (x < LOGICAL - 1 && solid[i + 1]) ||
            (y > 0 && solid[i - LOGICAL]) || (y < LOGICAL - 1 && solid[i + LOGICAL])) {
          d[i * 4] = OUTLINE_RGB[0];
          d[i * 4 + 1] = OUTLINE_RGB[1];
          d[i * 4 + 2] = OUTLINE_RGB[2];
          d[i * 4 + 3] = 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
    return top;
  }

  function wobble(t) {
    tg.clearRect(0, 0, LOGICAL, LOGICAL);
    for (let y = 0; y < LOGICAL; y++) {
      const d = Math.round(1.7 * Math.sin(t * 22 + y * 0.28));
      tg.drawImage(off, 0, y, LOGICAL, 1, d, y, LOGICAL, 1);
    }
    g.clearRect(0, 0, LOGICAL, LOGICAL);
    g.drawImage(tmp, 0, 0);
  }

  function shadow(pose, lift) {
    const base = { dragged: 10, sleep: 22, walk: 22, run: 24, stretch: 30, scratch: 18, alert: 18, sit: 18 }[pose] || 18;
    const w = Math.max(6, base - lift * 2) & ~1;
    g.save();
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = 'rgba(0,0,0,0.2)';
    g.fillRect(CX - w / 2, GROUND, w, 1);
    g.fillRect(CX - w / 2 + 2, GROUND + 1, w - 4, 1);
    g.restore();
  }

  // ---------------------------------------------------------------- frame
  function update(now, dt) {
    const speed = Math.hypot(S.vx, S.vy);
    S.speed = speed;
    if (now < S.alertUntil && now > S.nextAlertHeart) {
      S.nextAlertHeart = now + 550;
      S.hearts.push({ t: now, x: -6 + Math.round(Math.random() * 12), p: Math.random() * 6 });
    }
    if (S.dragging) {
      S.dragV *= Math.exp(-dt * 5);
      const target = Math.max(-5, Math.min(5, -S.dragV / 130));
      S.dVel += (60 * (target - S.dAng) - 7 * S.dVel) * dt;
      S.dAng += S.dVel * dt;
    } else {
      S.dAng = 0; S.dVel = 0; S.dragV = 0;
    }
    if (!S.running && speed > 330) S.running = true;
    else if (S.running && speed < 280) S.running = false;
    if (S.running) S.runPhase += dt * (2.6 + speed / 500);
    if (S.idle > 20000 && S.idle < SLEEP_AFTER && now > S.nextScratch && now >= S.scratchUntil) {
      S.scratchSide = -S.scratchSide;
      S.scratchUntil = now + 2400;
      S.nextScratch = now + 22000 + Math.random() * 6000;
    }
    if (!S.walking && speed > 25) S.walking = true;
    else if (S.walking && speed < 12) S.walking = false;
    if (S.walking) {
      if (Math.abs(S.vx) > 12) S.facing = S.vx > 0 ? 1 : -1;
      S.walkPhase += dt * (3.5 + speed / 40);
    }
    if (now > S.nextBlink) {
      S.blinkUntil = now + 140;
      S.nextBlink = now + 2200 + Math.random() * 4000;
    }
    if (now > S.nextTwitch) {
      S.twitchUntil = now + 200;
      S.twitchSide = Math.random() < 0.5 ? -1 : 1;
      S.nextTwitch = now + 4000 + Math.random() * 6000;
    }
    if (S.hearts.length) S.hearts = S.hearts.filter((h) => now - h.t < 1400);
  }

  function drawLogical(now) {
    const t = now / 1000;
    const pose = pickPose(now);
    const flipped = !!SIDE_VIEW[pose] && S.facing < 0;
    const hk = (now - S.hopAt) / 380;
    const hop = (hk >= 0 && hk < 1 && pose !== 'dragged' && pose !== 'walk')
      ? Math.round(5 * Math.sin(Math.PI * hk)) : 0;

    post = [];
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, LOGICAL, LOGICAL);

    const flip = () => { if (flipped) g.setTransform(-1, 0, 0, 1, LOGICAL, 0); };

    g.save();
    flip();
    ox = 0; oy = hop;
    POSES[pose](now, t);
    const lift = oy;
    g.restore();

    particles(now, pose);
    S.topRow = Math.max(0, outline() - 1);

    g.save();
    flip();
    post.forEach((fn) => fn());
    g.restore();

    shadow(pose, lift + (pose === 'dragged' ? 4 : 0));
    return pose;
  }

  // ---------------------------------------------------------------- speech bubble
  function wrap(text, max) {
    const out = [];
    for (const para of String(text).toUpperCase().split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        if (!cur) cur = word;
        else if ((cur + ' ' + word).length <= max) cur += ' ' + word;
        else { out.push(cur); cur = word; }
      }
      if (cur) out.push(cur);
    }
    return out;
  }

  function say(text, ms, kind) {
    const u = fontUnit();
    const maxChars = Math.max(8, Math.min(18, Math.floor((S.size - 20) / (6 * u / S.dpr))));
    S.bubble = { lines: wrap(text, maxChars), until: performance.now() + ms, kind: kind || 'chat' };
  }

  function fontUnit() {
    return Math.max(1, Math.round((S.scale >= 5 ? 3 : 2) * S.dpr));
  }

  function drawBubble(lines, anchorX, anchorY) {
    const u = fontUnit();
    const W = canvas.width;
    const textW = Math.max(...lines.map((l) => Font.width(l, u)));
    const textH = lines.length * 5 * u + (lines.length - 1) * 2 * u;
    const pad = 3 * u;
    const w = textW + pad * 2;
    const h = textH + pad * 2;
    const x = Math.round(Math.min(Math.max(anchorX - w / 2, 2 * u), W - w - 2 * u));
    let y = Math.round(anchorY - 3 * u - h);
    if (y < 2 * u) y = 2 * u;

    view.fillStyle = PAL.outline;
    view.fillRect(x + u, y, w - 2 * u, h);
    view.fillRect(x, y + u, w, h - 2 * u);
    view.fillStyle = PAL.paper;
    view.fillRect(x + 2 * u, y + u, w - 4 * u, h - 2 * u);
    view.fillRect(x + u, y + 2 * u, w - 2 * u, h - 4 * u);

    // tail
    const tx = Math.round(Math.min(Math.max(anchorX, x + 5 * u), x + w - 5 * u) / u) * u;
    view.fillStyle = PAL.paper;
    view.fillRect(tx - 2 * u, y + h - u, 4 * u, u);
    view.fillStyle = PAL.outline;
    view.fillRect(tx - 3 * u, y + h, u, u);
    view.fillRect(tx + 2 * u, y + h, u, u);
    view.fillRect(tx - 2 * u, y + h + u, u, u);
    view.fillRect(tx + u, y + h + u, u, u);
    view.fillRect(tx - u, y + h + 2 * u, 2 * u, u);
    view.fillStyle = PAL.paper;
    view.fillRect(tx - 2 * u, y + h, 4 * u, u);
    view.fillRect(tx - u, y + h + u, 2 * u, u);

    lines.forEach((line, i) => {
      const lw = Font.width(line, u);
      Font.draw(view, line, Math.round(x + (w - lw) / 2), y + pad + i * 7 * u, u, PAL.outline);
    });
  }

  // Floating "Z"s while asleep, drawn with the bitmap font so the letter shape stays legible.
  function drawZzz(now, k) {
    const u = fontUnit();
    for (let i = 0; i < 3; i++) {
      const p = ((now / 3600) + i / 3) % 1;
      if (p > 0.9) continue;
      const uu = Math.max(1, Math.round(u * (p < 0.45 ? 1 : 1.5)));
      const gx = (CX + 7 + Math.round(p * 12) + Math.round(Math.sin(p * 7 + i))) * k;
      const gy = (GROUND - 19 - Math.round(p * 30)) * k;
      for (const [ax, ay] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        Font.draw(view, 'Z', gx + ax * uu, gy + ay * uu, uu, PAL.outline);
      }
      Font.draw(view, 'Z', gx, gy, uu, PAL.zzz);
    }
  }

  function paint(now, pose) {
    const k = canvas.width / LOGICAL;
    view.setTransform(1, 0, 0, 1, 0, 0);
    view.clearRect(0, 0, canvas.width, canvas.height);
    view.imageSmoothingEnabled = false;
    view.drawImage(off, 0, 0, LOGICAL, LOGICAL, 0, 0, LOGICAL * k, LOGICAL * k);
    if (pose === 'sleep') drawZzz(now, k);
    if (S.bubble) {
      if (now < S.bubble.until) drawBubble(S.bubble.lines, CX * k, S.topRow * k - 2 * k);
      else S.bubble = null;
    }
    if (S.name && (S.dragging || (S.hover && now - S.hoverSince > 120))) drawName(k);
  }

  // The cat's name, shown under it while the cursor hovers.
  function drawName(k) {
    const u = fontUnit();
    const text = S.name;
    const w = Font.width(text, u);
    const x = Math.round(CX * k - w / 2);
    const y = Math.round((GROUND + 3) * k);
    for (const [ax, ay] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
      Font.draw(view, text, x + ax * Math.max(1, u / 2), y + ay * Math.max(1, u / 2), u, PAL.outline);
    }
    Font.draw(view, text, x, y, u, PAL.tag);
  }

  function render(now) {
    const dt = Math.min(0.1, Math.max(0, (now - (S.lastRender || now)) / 1000));
    S.lastRender = now;
    update(now, dt);
    const pose = drawLogical(now);
    paint(now, pose);
    return pose;
  }

  // ---------------------------------------------------------------- interaction
  let press = null;

  function spawnHearts(now) {
    for (let i = 0; i < 3; i++) {
      S.hearts.push({ t: now + i * 160, x: -6 + i * 6 + Math.round(Math.random() * 3), p: Math.random() * 6 });
    }
  }

  function pet() {
    const nowT = performance.now();
    if (nowT < S.alertUntil) {
      S.alertUntil = 0;
      S.stretchUntil = 0;
      say('Good job!', 2200);
      api.send('stretch-done');
      S.petUntil = nowT + 1800;
      spawnHearts(nowT);
      return;
    }
    if (!PET_REACTIONS) return;
    const now = nowT;
    if (now < S.stretchUntil || (S.bubble && S.bubble.kind === 'stretch')) {
      S.stretchUntil = 0;
      say('Good job!', 2200);
      api.send('stretch-done');
    } else {
      say(MEOWS[Math.floor(Math.random() * MEOWS.length)], 1700);
    }
    S.petUntil = now + 1800;
    spawnHearts(now);
  }

  function endDrag() {
    if (!S.dragging) return;
    S.dragging = false;
    S.hopAt = performance.now();
    canvas.classList.remove('dragging');
    api.send('drag-end');
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    press = { sx: e.screenX, sy: e.screenY, moved: false };
  });

  window.addEventListener('mousemove', (e) => {
    if (S.dragging) {
      const t = performance.now();
      const dt = (t - S.dragT) / 1000;
      if (dt > 0.004 && dt < 0.2) S.dragV = 0.6 * S.dragV + 0.4 * ((e.screenX - S.dragX) / dt);
      S.dragX = e.screenX;
      S.dragT = t;
    }
    if (!press || press.moved) return;
    if (Math.hypot(e.screenX - press.sx, e.screenY - press.sy) > 4) {
      press.moved = true;
      S.dragging = true;
      S.dragX = e.screenX;
      S.dragT = performance.now();
      canvas.classList.add('dragging');
      api.send('drag-start');
    }
  });

  window.addEventListener('mouseup', () => {
    if (!press) return;
    const wasDrag = press.moved;
    press = null;
    if (wasDrag) endDrag();
    else pet();
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.send('show-menu');
  });

  // ---------------------------------------------------------------- messages from main
  api.on('state', (m) => {
    S.vx = m.vx; S.vy = m.vy;
    S.dx = m.dx; S.dy = m.dy;
    S.idle = m.idle;
    const over = !!m.over;
    if (over && !S.hover) S.hoverSince = performance.now();
    S.hover = over;
  });

  api.on('key', () => {
    const now = performance.now();
    // a new burst of typing = a new scratch session, on the other leg
    if (now - S.lastKey > 1100) S.scratchSide = -S.scratchSide;
    S.lastKey = now;
  });

  api.on('stretch', (m) => {
    const now = performance.now();
    S.stretchUntil = now + (m.ms || 7000);
    S.facing = S.dx >= 0 ? 1 : -1;
    say('Time to stretch!\n' + m.tip, 20000, 'stretch');
  });

  api.on('timer-start', (m) => {
    const now = performance.now();
    S.petUntil = now + 2200;
    spawnHearts(now);
    S.hopAt = now;
    say('Good luck!\nFocus on your work' + (m.label ? '\n' + m.label : ''), 5500);
  });

  api.on('timer-end', (m) => {
    const now = performance.now();
    S.alertUntil = now + 12000;
    S.stretchUntil = 0;
    S.nextAlertHeart = 0;
    say("Time's up!\n" + (m.label || '') + '\nPrrr...', 12000, 'alert');
  });

  api.on('config', (m) => {
    if (m.colors) applyColors(m.colors);
    if (typeof m.name === 'string') S.name = m.name.toUpperCase().slice(0, 14);
    if (m.sleepAfter) {
      SLEEP_AFTER = m.sleepAfter * 1000;
      SLEEPY_AFTER = SLEEP_AFTER * 0.55;
    }
    if (typeof m.pet === 'boolean') PET_REACTIONS = m.pet;
    if (m.size) {
      S.size = m.size;
      S.scale = m.size / LOGICAL;
      resize();
    }
  });

  api.on('say', (m) => {
    if (m.text) say(m.text, m.ms || 2500);
  });

  // ---------------------------------------------------------------- loop
  let lastFrame = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (ts - lastFrame < 33) return;
    lastFrame = ts;
    render(ts);
  }

  resize();
  requestAnimationFrame(frame);
  api.send('ready');

  if (/[?&]debug/.test(location.search)) {
    window.__cat = { S, render, say, resize, PAL, applyColors };
  }
})();
