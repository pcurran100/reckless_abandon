// Spindle: Miró-style lines drawn as you scroll.
// Add <script src="spindle.js" defer></script> to any page. Tune CONFIG below.
(() => {
  // ---- Tune here -------------------------------------------------------
  const CONFIG = {
    content: 'main',           // element holding your page content
    protect: 'h1, h2, h3, h4, p, li, img, figure, pre, table, blockquote', // nothing is drawn over these
    textPadding: 18,           // px of clear space kept around protected elements
    seed: null,                // null = new drawing each load; a number = same drawing every time

    // Density
    bandHeight: 560,           // px between rows of figures (smaller = denser)
    figuresPerRow: [1, 2],     // min, max figures per row on wide screens (1 on phones)
    starsPerRow: [1, 2],       // min, max asterisks per row
    creatureChance: 0.45,      // share of figures that are a shape with legs (rest are lone lines)

    // Lines
    lineLength: [350, 900],    // px, lone lines
    legs: [2, 4],              // min, max legs on a shape
    lineWidth: [1.6, 2.7],     // base width range, px
    wobble: [0.18, 0.32],      // how much width swells and thins along a line
    loopChance: 0.015,         // per step
    elbowChance: 0.02,         // per step
    behindChance: 0.3,         // share of lone lines that pass behind shapes

    // Shapes
    shapeSize: [22, 55],       // px radius range
    overlapChance: 0.55,       // chance a shape gets a second overlapping shape
    palette: ['--red', '--blue', '--yellow', '--green', '--ink'],

    // Scroll
    revealAt: 0.8,             // the drawing edge sits this far down the visible area
    ease: 0.12                 // smoothing of the drawing edge (1 = instant)
  };
  // ----------------------------------------------------------------------

  const NS = 'http://www.w3.org/2000/svg';
  const TAU = Math.PI * 2;
  const css = document.createElement('style');
  css.textContent = `
    :where(:root){--ink:#000;--red:#e0482a;--blue:#5a7ddb;--yellow:#f2e36b;--green:#6cae88}
    @media (prefers-color-scheme:dark){:where(:root){--ink:#eef0e6;--red:#ee5a3b;--blue:#7f9cec;--yellow:#eadb63;--green:#7fc29c}}
    #spindle{position:absolute;top:0;left:0;pointer-events:none;z-index:0;overflow:visible}
    #spindle .stroke{fill:none;stroke:var(--ink);stroke-linecap:round;stroke-linejoin:round}
    #spindle .pop{transform-box:fill-box;transform-origin:center;transform:scale(0);transition:transform .5s cubic-bezier(.3,1.5,.5,1)}
    #spindle .pop.on{transform:scale(1)}
    @media (prefers-reduced-motion:reduce){#spindle .pop{transition:none}}`;
  document.head.appendChild(css);
  if (getComputedStyle(document.body).position === 'static') document.body.style.position = 'relative';
  let svg = document.getElementById('spindle');
  if (!svg) {
    svg = document.createElementNS(NS, 'svg');
    svg.id = 'spindle';
    svg.setAttribute('aria-hidden', 'true');
    document.body.prepend(svg);
  }
  const main = document.querySelector(CONFIG.content) || document.body;
  const range2 = ([a, b]) => a + Math.floor(rng() * (b - a + 1));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let rng, strokes = [], pops = [], layers = {}, clipN = 0, maskN = 0, W = 0, H = 0;
  let current = 0, target = 0, ticking = false, io, sentinels;
  let seed = CONFIG.seed ?? ((Math.random() * 1e9) | 0), lastW = 0, lastH = 0;
  const visible = new Set();
  const SENT = 25;

  const mulberry = a => () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const R = (a, b) => a + (b - a) * rng();
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const f = n => n.toFixed(1);
  const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const ext = pts => { let lo = Infinity, hi = -Infinity; for (const p of pts) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1]; } return [lo, hi]; };
  const heading = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);

  // Text areas the drawing must stay out of
  let zones = [];
  function measureZones() {
    const sr = svg.getBoundingClientRect(), range = document.createRange();
    zones = [...main.querySelectorAll(CONFIG.protect)].map(e => {
      range.selectNodeContents(e);
      const r = range.getBoundingClientRect();
      return { x0: r.left - sr.left, y0: r.top - sr.top, x1: r.right - sr.left, y1: r.bottom - sr.top };
    });
  }
  const blocked = (x, y, pad = CONFIG.textPadding) => zones.some(z => x > z.x0 - pad && x < z.x1 + pad && y > z.y0 - pad && y < z.y1 + pad);
  const boxBlocked = (b, pad = 8) => zones.some(z => b.x < z.x1 + pad && b.x + b.width > z.x0 - pad && b.y < z.y1 + pad && b.y + b.height > z.y0 - pad);
  function nearest(x, y) {
    let best = Infinity, bx = x, by = y;
    for (const z of zones) {
      const nx = Math.max(z.x0, Math.min(z.x1, x)), ny = Math.max(z.y0, Math.min(z.y1, y)), d = Math.hypot(x - nx, y - ny);
      if (d < best) { best = d; bx = nx; by = ny; }
    }
    return [best, bx, by];
  }
  const segment = (a, b, step = 4) => { const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)), out = []; for (let i = 0; i <= n; i++) out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); return out; };

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  // Catmull-Rom through points, as cubic Beziers
  function curve(pts, closed, noMove) {
    const n = pts.length;
    if (n < 2) return '';
    const P = i => closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))];
    let d = noMove ? '' : `M${f(pts[0][0])},${f(pts[0][1])}`;
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ` +
           `${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
    }
    return closed ? d + 'Z' : d;
  }

  // The pen: small steps, drifting curvature, occasional loops and elbows
  function wander(x, y, th, len, box, opts = {}) {
    const loopP = opts.loopP ?? CONFIG.loopChance;
    const kinkP = opts.kinkP ?? CONFIG.elbowChance;
    const noise = opts.noise ?? 0.025;
    const step = 6;
    const pts = [[x, y]];
    let k = R(-0.02, 0.02), loop = 0, dir = 1, loopK = 0.2;
    const n = Math.max(4, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      if (loop > 0) {
        loop--; k += (dir * loopK - k) * 0.3;
      } else {
        if (rng() < loopP) { loopK = R(0.14, 0.26); loop = Math.round(TAU / loopK * R(0.9, 1.15)); dir = rng() < 0.5 ? -1 : 1; }
        else if (rng() < kinkP) th += R(-1.5, 1.5);
        k += R(-noise, noise); k *= 0.93;
      }
      if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) {
        const want = Math.atan2(box.cy - y, box.cx - x);
        const diff = ((want - th) % TAU + TAU * 1.5) % TAU - Math.PI;
        th += diff * 0.08;
      }
      // veer away from text, and stop dead rather than enter it
      const [d, nx, ny] = nearest(x, y);
      if (d > 0 && d < CONFIG.textPadding + 60) {
        const want = Math.atan2(y - ny, x - nx);
        const diff = ((want - th) % TAU + TAU * 1.5) % TAU - Math.PI;
        th += diff * 0.25 * (1 - Math.max(0, d - CONFIG.textPadding) / 60);
        loop = 0;
      }
      th += k;
      x += Math.cos(th) * step; y += Math.sin(th) * step;
      if (blocked(x, y)) { pts.cut = true; break; }
      pts.push([x, y]);
    }
    return pts;
  }

  // Inward spiral: curvature grows each step
  function spiral(x, y, th) {
    const pts = [[x, y]];
    const dir = rng() < 0.5 ? -1 : 1;
    const turns = R(1.2, 2.6) * TAU;
    let k = R(0.04, 0.07), step = 5, total = 0;
    while (total < turns && pts.length < 200) {
      k *= 1.045; step = Math.max(1.4, step * 0.985);
      th += dir * k; total += k;
      x += Math.cos(th) * step; y += Math.sin(th) * step;
      pts.push([x, y]);
    }
    return pts;
  }

  // Width along the line: two slow waves, a slight swell at the start, a taper at the end
  function widths(pts, base, endMin) {
    const n = pts.length, L = [0];
    for (let i = 1; i < n; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const total = L[n - 1] || 1;
    const l1 = R(140, 340), l2 = R(40, 90), p1 = R(0, TAU), p2 = R(0, TAU);
    const a1 = R(...CONFIG.wobble), a2 = a1 * 0.4;
    const tailLen = Math.min(45, total * 0.35);
    return L.map(d => {
      let w = base * (1 + a1 * Math.sin(d / l1 * TAU + p1) + a2 * Math.sin(d / l2 * TAU + p2));
      w *= 1 + 0.25 * Math.max(0, 1 - d / 15);                       // pen lands
      w *= endMin + (1 - endMin) * Math.min(1, (total - d) / tailLen); // pen lifts
      return Math.max(0.45, w);
    });
  }

  function outline(pts, ws) {
    const n = pts.length, A = [], B = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
      const nx = -dy / m, ny = dx / m, h = ws[i] / 2, p = pts[i];
      A.push([p[0] + nx * h, p[1] + ny * h]);
      B.push([p[0] - nx * h, p[1] - ny * h]);
    }
    B.reverse();
    const re = ws[n - 1] / 2, rs = ws[0] / 2;
    return curve(A) + `A${f(re)},${f(re)} 0 0 0 ${f(B[0][0])},${f(B[0][1])}` + curve(B, false, true) +
           `A${f(rs)},${f(rs)} 0 0 0 ${f(A[0][0])},${f(A[0][1])}Z`;
  }

  // A variable-width ink line, revealed through a dashed mask along its centre
  function addStroke(pts, start, span, base, endMin = 0.45, layer) {
    base = base ?? R(...CONFIG.lineWidth);
    const ws = widths(pts, base, endMin);
    const id = 'spm' + (maskN++);
    const mask = el('mask', { id, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, layers.defs);
    const mp = el('path', { d: curve(pts), fill: 'none', stroke: '#fff', 'stroke-width': f(Math.max(...ws) + 3), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, mask);
    const ink = el('path', { d: outline(pts, ws), style: 'fill:var(--ink)', mask: `url(#${id})` }, layer || layers.lines);
    const len = mp.getTotalLength() + 4;
    mp.style.strokeDasharray = `${len} ${len}`;
    mp.style.strokeDashoffset = len;
    ink.style.visibility = 'hidden';
    const s = { el: mp, ink, len, base, start, span: Math.max(40, span), p: -1 };
    strokes.push(s);
    return s;
  }
  const strokeFromPts = (pts, lead = 40, extra = 160, layer) => {
    const [y0, y1] = ext(pts);
    return addStroke(pts, y0 - lead, (y1 - y0) + extra, undefined, undefined, layer);
  };
  const done = s => s.start + s.span;

  function pop(node, at, layer) {
    node.classList.add('pop');
    (layer || layers.dots).appendChild(node);
    pops.push({ el: node, at, on: null });
    return node;
  }

  // Shapes
  function blobD(cx, cy, r) {
    const n = 7 + Math.floor(rng() * 3), a0 = R(0, TAU), sx = R(0.75, 1.3), pts = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + i / n * TAU, rr = r * R(0.85, 1.12);
      pts.push([cx + Math.cos(a) * rr * sx, cy + Math.sin(a) * rr / sx]);
    }
    return curve(pts, true);
  }
  function triD(cx, cy, r) {
    const a0 = R(0, TAU);
    const v = [0, 1, 2].map(i => { const a = a0 + i * TAU / 3 + R(-0.5, 0.5), rr = r * R(0.55, 1.35); return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]; });
    let d = `M${f(v[0][0])},${f(v[0][1])}`;
    for (let i = 0; i < 3; i++) {
      const p = v[i], q = v[(i + 1) % 3], b = R(-0.25, 0.25);
      const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, dx = q[0] - p[0], dy = q[1] - p[1];
      d += `Q${f(mx - dy * b)},${f(my + dx * b)} ${f(q[0])},${f(q[1])}`;
    }
    return d + 'Z';
  }
  function crescentD(cx, cy, r) {
    const a = R(0, TAU), c = Math.cos(a), s = Math.sin(a), r2 = r * R(1.15, 1.8);
    const p1 = [cx + s * r, cy - c * r], p2 = [cx - s * r, cy + c * r];
    return `M${f(p1[0])},${f(p1[1])}A${f(r)},${f(r)} 0 0 1 ${f(p2[0])},${f(p2[1])}A${f(r2)},${f(r2)} 0 0 0 ${f(p1[0])},${f(p1[1])}Z`;
  }
  const shapeD = (kind, cx, cy, r) => kind === 'tri' ? triD(cx, cy, r) : kind === 'crescent' ? crescentD(cx, cy, r) : blobD(cx, cy, r);

  // A flat shape, sometimes overlapped by a second with the overlap in a third colour
  function shapeGroup(cx, cy, r, at, forceInk) {
    const g = el('g', {});
    const cols = shuffle(CONFIG.palette);
    if (forceInk) cols.unshift('--ink');
    const dA = shapeD(pick(['blob', 'tri', 'tri', 'crescent']), cx, cy, r);
    const A = el('path', { d: dA, style: `fill:var(${cols[0]})` }, g);
    pop(g, at, layers.shapes);
    const L = A.getTotalLength(), samples = [];
    for (let i = 0; i < 64; i++) { const q = A.getPointAtLength(L * i / 64); samples.push([q.x, q.y]); }
    let mx = 0, my = 0; for (const q of samples) { mx += q[0]; my += q[1]; }
    const c = [mx / 64, my / 64];
    if (!forceInk && rng() < CONFIG.overlapChance) {
      // centre the second shape on the first one's edge so they always overlap
      const q = pick(samples), t = R(0, 0.3);
      const dB = shapeD(pick(['blob', 'tri', 'crescent']), q[0] + (c[0] - q[0]) * t, q[1] + (c[1] - q[1]) * t, r * R(0.5, 0.9));
      el('path', { d: dB, style: `fill:var(${cols[1]})` }, g);
      const id = 'spclip' + (clipN++);
      const cp = el('clipPath', { id }, layers.defs);
      el('path', { d: dA }, cp);
      el('path', { d: dB, style: `fill:var(${cols[2]})`, 'clip-path': `url(#${id})` }, g);
    }
    return { g, A, samples, c };
  }

  const inside = (path, x, y) => { try { return path.isPointInFill(new DOMPoint(x, y)); } catch (e) { return true; } };

  function inkBlob(cx, cy, r, at) {
    const g = el('g', {});
    el('path', { d: blobD(cx, cy, r), style: 'fill:var(--ink)' }, g);
    pop(g, at);
    return { g, A: g.firstChild };
  }

  // Put a shape on a line's end, retrying until the line actually reaches into it
  function capShape(x, y, th, r, at, ink) {
    const bx = x - Math.cos(th) * 3, by = y - Math.sin(th) * 3;
    for (let t = 0; t < 10; t++) {
      const off = r * R(0.3, 0.6), cx = x + Math.cos(th) * off, cy = y + Math.sin(th) * off;
      const sh = ink ? inkBlob(cx, cy, r, at) : shapeGroup(cx, cy, r, at);
      if (inside(sh.A, bx, by) && !boxBlocked(sh.g.getBBox())) return sh;
      sh.g.remove(); pops.pop();
    }
    pop(el('circle', { cx: f(x), cy: f(y), r: f(R(3, 6)), style: 'fill:var(--ink)' }), at);
  }

  function terminal(s, p, th, pool) {
    let kind = pick(pool);
    const at = done(s), [x, y] = p;
    if (kind === 'ring' && blocked(x + Math.cos(th) * 8, y + Math.sin(th) * 8, 10)) kind = 'dot';
    if (kind === 'dot') {
      pop(el('circle', { cx: f(x), cy: f(y), r: f(R(3, 7)), style: 'fill:var(--ink)' }), at);
    } else if (kind === 'ring') {
      const r = R(4, 8);
      pop(el('circle', { cx: f(x + Math.cos(th) * r), cy: f(y + Math.sin(th) * r), r: f(r), class: 'stroke', 'stroke-width': '1.8' }), at);
    } else if (kind === 'bigdot') {
      capShape(x, y, th, R(9, 20), at, true);
    } else if (kind === 'blob') {
      capShape(x, y, th, R(14, 30), at, false);
    } else if (kind === 'spiral') {
      const sp = spiral(x, y, th);
      if (sp.some(q => blocked(q[0], q[1]))) pop(el('circle', { cx: f(x), cy: f(y), r: f(R(3, 6)), style: 'fill:var(--ink)' }), at);
      else addStroke(sp, at, 140, s.base * 0.9, 0.2, s.ink.parentNode);
    }
  }

  function ticks(s, pts) {
    const n = pts.length, count = pick([0, 0, 1, 1, 2]);
    if (n < 6) return;
    for (let t = 0; t < count; t++) {
      const i = Math.floor(R(0.2, 0.8) * n), p = pts[i];
      const a = heading(pts[i - 1], pts[i + 1]) + Math.PI / 2 + R(-0.5, 0.5), l = R(8, 20);
      const e0 = [p[0] - Math.cos(a) * l, p[1] - Math.sin(a) * l], e1 = [p[0] + Math.cos(a) * l, p[1] + Math.sin(a) * l];
      if (blocked(...e0) || blocked(...e1)) continue;
      addStroke(segment(e0, e1), s.start + s.span * (i / n), 60);
    }
  }

  function star(cx, cy, size) {
    const rays = pick([3, 3, 4, 4, 5]), base = R(0, Math.PI), w = R(1.4, 2.2);
    for (let i = 0; i < rays; i++) {
      const a = base + i * Math.PI / rays + R(-0.15, 0.15);
      const l1 = size * R(0.7, 1.1), l2 = size * R(0.7, 1.1);
      addStroke(segment([cx - Math.cos(a) * l1, cy - Math.sin(a) * l1], [cx + Math.cos(a) * l2, cy + Math.sin(a) * l2]), cy - size - 20 + i * 22, 50, w);
    }
  }

  function tuft(x, y, at) {
    const n = pick([2, 3, 3, 4]), big = { x0: -1e9, x1: 1e9, y0: -1e9, y1: 1e9, cx: 0, cy: 0 };
    for (let i = 0; i < n; i++) {
      const th = -Math.PI / 2 + (i - (n - 1) / 2) * 0.35 + R(-0.1, 0.1);
      const pts = wander(x + (i - (n - 1) / 2) * 2, y, th, R(25, 55), big, { loopP: 0, kinkP: 0, noise: 0.03 });
      if (pts.length < 3) continue;
      addStroke(pts, at + i * 15, 60, R(1.3, 2), 0.25, layers.back);
    }
  }

  function wanderer(cx, cy, box) {
    const pts = wander(cx, cy, R(0, TAU), R(...CONFIG.lineLength), box);
    if (pts.length < 6) return;
    let cutEnd = !!pts.cut;
    if (pts[0][1] > pts[pts.length - 1][1]) { pts.reverse(); cutEnd = false; }   // draw from the top end down
    const n = pts.length, s = strokeFromPts(pts, 40, 160, rng() < CONFIG.behindChance ? layers.back : layers.lines);
    if (rng() < 0.6) pop(el('circle', { cx: f(pts[0][0]), cy: f(pts[0][1]), r: f(R(3, 8)), style: 'fill:var(--ink)' }), s.start + 10);
    terminal(s, pts[n - 1], heading(pts[n - 2], pts[n - 1]), cutEnd ? ['dot', 'none'] : ['dot', 'dot', 'spiral', 'spiral', 'bigdot', 'blob', 'ring', 'none']);
    ticks(s, pts);
  }

  function creature(cx, cy, box, r) {
    const at = cy - r - 40;
    const sh = shapeGroup(cx, cy, r, at, rng() < 0.35), [ox, oy] = sh.c;
    const legs = range2(CONFIG.legs);
    for (let i = 0; i < legs; i++) {
      let p = null, th, layer = layers.lines;
      if (rng() < 0.35) {
        // run through the shape, over or under it
        for (let t = 0; t < 12 && !p; t++) { const x = ox + R(-r, r) * 0.8, y = oy + R(-r, r) * 0.8; if (inside(sh.A, x, y)) p = [x, y]; }
        if (p) { th = R(0, TAU); if (rng() < 0.5) layer = layers.back; }
      }
      if (!p) {
        // leave from the edge, starting just inside it so the line touches
        const q = pick(sh.samples), a = Math.atan2(q[1] - oy, q[0] - ox);
        p = [q[0] - Math.cos(a) * 3, q[1] - Math.sin(a) * 3]; th = a + R(-0.4, 0.4);
      }
      const pts = wander(p[0], p[1], th, R(80, 280), box, { loopP: 0.01 });
      if (pts.length < 4) continue;
      const n = pts.length, [y0, y1] = ext(pts);
      const s = addStroke(pts, at + 30 + i * 25, (y1 - y0) + 120, undefined, undefined, layer);
      terminal(s, pts[n - 1], heading(pts[n - 2], pts[n - 1]), pts.cut ? ['dot', 'none'] : ['dot', 'dot', 'ring', 'spiral', 'none', 'none']);
    }
    if (rng() < 0.4) {
      const top = sh.samples.reduce((m, q) => q[1] < m[1] ? q : m);
      tuft(top[0], top[1] + 4, at + 20);
    }
  }

  // Track which slice of the page is on screen. Works whether the window scrolls
  // or the page sits full-height inside a frame that scrolls.
  function watch() {
    if (io) io.disconnect();
    if (sentinels) sentinels.remove();
    visible.clear();
    sentinels = document.createElement('div');
    sentinels.setAttribute('aria-hidden', 'true');
    sentinels.style.cssText = `position:absolute;top:0;left:0;width:1px;height:${H}px;pointer-events:none;visibility:hidden`;
    for (let y = 0; y < H; y += SENT) {
      const d = document.createElement('div');
      d.style.cssText = `position:absolute;left:0;top:${y}px;width:1px;height:${SENT}px`;
      d.dataset.y = y;
      sentinels.appendChild(d);
    }
    document.body.appendChild(sentinels);
    io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const y = +e.target.dataset.y;
        if (e.isIntersecting) visible.add(y); else visible.delete(y);
      }
      if (!visible.size) return;
      let lo = Infinity, hi = -Infinity;
      for (const y of visible) { if (y < lo) lo = y; if (y > hi) hi = y; }
      hi += SENT;
      target = lo + (hi - lo) * CONFIG.revealAt;
      kick();
    });
    for (const d of sentinels.children) io.observe(d);
  }

  function build() {
    svg.replaceChildren();
    strokes = []; pops = []; clipN = 0; maskN = 0;
    rng = mulberry(seed);

    W = document.documentElement.clientWidth;
    H = Math.max(document.body.offsetHeight, main.offsetTop + main.offsetHeight);
    lastW = W; lastH = H;
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    layers.defs = el('defs', {}, svg);
    layers.back = el('g', {}, svg);
    layers.shapes = el('g', {}, svg);
    layers.lines = el('g', {}, svg);
    layers.dots = el('g', {}, svg);

    measureZones();
    const band = CONFIG.bandHeight, P = CONFIG.textPadding;
    const m = Math.min(60, W * 0.06);
    for (let y = 140; y < H - band * 0.3; y += band) {
      const count = W < 700 ? 1 : range2(CONFIG.figuresPerRow);
      for (let i = 0; i < count; i++) {
        const isCreature = rng() < CONFIG.creatureChance, r = R(...CONFIG.shapeSize), clear = (isCreature ? r * 2.4 : 30) + P;
        let pos = null;
        for (let t = 0; t < 15 && !pos; t++) {
          const cx = R(W * (0.1 + 0.8 * i / count), W * (0.1 + 0.8 * (i + 1) / count));
          const cy = y + R(0, band * 0.6);
          if (!blocked(cx, cy, clear)) pos = [cx, cy];
        }
        if (!pos) continue;
        const [cx, cy] = pos;
        const box = { x0: m, x1: W - m, y0: cy - band * 0.55, y1: cy + band * 0.55, cx, cy };
        if (isCreature) creature(cx, cy, box, r); else wanderer(cx, cy, box);
      }
      const ns = range2(CONFIG.starsPerRow);
      for (let i = 0; i < ns; i++) {
        const size = R(10, 26);
        for (let t = 0; t < 10; t++) {
          const sx = R(m, W - m), sy = y + R(0, band);
          if (!blocked(sx, sy, size * 1.2 + P)) { star(sx, sy, size); break; }
        }
      }
    }

    current = Math.max(0, target - 700);   // re-draw what's on screen
    draw(current);
    watch();
    kick();
  }

  function draw(r) {
    for (const s of strokes) {
      let p = (r - s.start) / s.span;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      if (p !== s.p) {
        s.p = p;
        s.el.style.strokeDashoffset = s.len * (1 - p);
        s.ink.style.visibility = p > 0 ? 'visible' : 'hidden';
      }
    }
    for (const q of pops) {
      const on = r >= q.at;
      if (on !== q.on) { q.on = on; q.el.classList.toggle('on', on); }
    }
  }

  function frame() {
    if (reduce) current = target;
    else current += (target - current) * CONFIG.ease;
    if (Math.abs(target - current) < 0.5) current = target;
    draw(current);
    if (current !== target) requestAnimationFrame(frame);
    else ticking = false;
  }
  function kick() { if (!ticking) { ticking = true; requestAnimationFrame(frame); } }

  let rt;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (document.documentElement.clientWidth !== lastW || Math.abs(document.body.offsetHeight - lastH) > 40) build();
    }, 150);
  }).observe(document.body);

  const regen = document.getElementById('regen');
  if (regen) regen.addEventListener('click', () => {
    seed = (Math.random() * 1e9) | 0;
    build();
  });

  build();
  if (document.fonts) document.fonts.ready.then(() => build());
})();
