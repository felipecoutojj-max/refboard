/* RefBoard para iPad (app web). Quadro de imagens de referência compatível com .pur do PureRef 2.1. */
(() => {
  'use strict';

  const P = window.Pur;
  const $ = (s) => document.querySelector(s);
  const canvas = $('#board');
  const ctx = canvas.getContext('2d', { alpha: false });

  const BG = '#202022';
  const ACCENT = '#ffb224';
  const MIN_ZOOM = 0.02, MAX_ZOOM = 40;
  const MAX_PIXELS = 16000000; // limite de canvas do Safari no iPad
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const SWATCHES = ['#ed4d4d', '#ffb224', '#59c36a', '#3fa7d6', '#ffffff', '#141414'];

  const S = {
    items: [],            // imagens do quadro, de trás para a frente
    strokes: [],          // traços da caneta, em coordenadas da cena
    passthrough: [],      // itens do PureRef que este app não edita (notas, grupos) e regrava como vieram
    images: new Map(),    // id -> recurso de imagem
    metadata: P.defaultMetadata(),
    selection: new Set(),
    tool: 'select',
    zoom: 1, panX: 0, panY: 0,
    pen: { color: SWATCHES[0], width: 4, finger: true },
    name: null, dirty: false, fileHandle: null,
    current: null, marquee: null,
  };
  let nextItemId = 1, nextImageId = 1;
  let vw = 1, vh = 1, dpr = 1;
  let loading = false;
  let clip = null;

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const selected = () => S.items.filter((it) => S.selection.has(it.id));
  const isPur = (f) => /\.pur$/i.test(f.name || '');
  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
  const baseName = (s) => (s ? String(s).split(/[\\/]/).pop() : null);

  // ------------------------------------------------------------------ armazenamento local (IndexedDB)

  const DB = (() => {
    let opening = null;
    function open() {
      if (!opening) {
        opening = new Promise((resolve, reject) => {
          const r = indexedDB.open('refboard', 1);
          r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('images'); };
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      }
      return opening;
    }
    async function tx(store, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = t.onabort = () => reject(t.error);
      });
    }
    return {
      get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
      put: (s, k, v) => tx(s, 'readwrite', (o) => o.put(v, k)),
      del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
      clear: (s) => tx(s, 'readwrite', (o) => o.clear()),
      keys: (s) => tx(s, 'readonly', (o) => o.getAllKeys()),
    };
  })();
  let chain = Promise.resolve();
  const queue = (fn) => { chain = chain.then(fn).catch(() => {}); return chain; };

  // ------------------------------------------------------------------ geometria

  /** Item -> cena, com espelhamento (convenção do QTransform: escala, gira, translada). */
  function matrix(it) {
    const sx = it.scale * (it.flipX ? -1 : 1), sy = it.scale * (it.flipY ? -1 : 1);
    const c = Math.cos(it.rotation), s = Math.sin(it.rotation);
    return [sx * c, sx * s, 0, -sy * s, sy * c, 0, it.cx, it.cy, 1];
  }
  const displayCenter = (it) => P.apply(matrix(it), it.cropX, it.cropY);
  function corners(it) {
    const m = matrix(it), hw = it.dw / 2, hh = it.dh / 2;
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => P.apply(m, it.cropX + x, it.cropY + y));
  }
  function itemBounds(it) {
    const c = corners(it);
    const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  function strokeBounds(st) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < st.pts.length; i += 2) {
      minX = Math.min(minX, st.pts[i]); maxX = Math.max(maxX, st.pts[i]);
      minY = Math.min(minY, st.pts[i + 1]); maxY = Math.max(maxY, st.pts[i + 1]);
    }
    const pad = st.width / 2;
    return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  }
  function union(list) {
    if (!list.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of list) {
      minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  const boundsOf = (items, strokes) => union(items.map(itemBounds).concat(strokes.filter((s) => s.pts.length).map(strokeBounds)));
  const contentBounds = () => boundsOf(S.items, S.strokes);
  const toView = (x, y) => [x * S.zoom + S.panX, y * S.zoom + S.panY];
  const toScene = (x, y) => [(x - S.panX) / S.zoom, (y - S.panY) / S.zoom];

  function hitItem(p) {
    const [x, y] = toScene(p.x, p.y);
    for (let i = S.items.length - 1; i >= 0; i--) {
      const it = S.items[i], m = matrix(it);
      const det = m[0] * m[4] - m[1] * m[3];
      if (!det) continue;
      const dx = x - m[6], dy = y - m[7];
      const lx = (m[4] * dx - m[3] * dy) / det, ly = (m[0] * dy - m[1] * dx) / det;
      if (Math.abs(lx - it.cropX) <= it.dw / 2 && Math.abs(ly - it.cropY) <= it.dh / 2) return it;
    }
    return null;
  }
  function handlePoints(it) {
    const cs = corners(it).map(([x, y]) => toView(x, y));
    const dc = toView(...displayCenter(it));
    const mid = [(cs[0][0] + cs[1][0]) / 2, (cs[0][1] + cs[1][1]) / 2];
    const dx = mid[0] - dc[0], dy = mid[1] - dc[1], len = Math.hypot(dx, dy) || 1;
    return { cs, dc, mid, knob: [mid[0] + (dx / len) * 34, mid[1] + (dy / len) * 34] };
  }
  function hitHandle(p, ptype) {
    if (S.tool !== 'select' || S.selection.size !== 1) return null;
    const it = selected()[0];
    if (!it) return null;
    const h = handlePoints(it), r = ptype === 'mouse' ? 11 : 24;
    if (Math.hypot(p.x - h.knob[0], p.y - h.knob[1]) <= r) return { it, mode: 'rotate', h };
    for (const c of h.cs) if (Math.hypot(p.x - c[0], p.y - c[1]) <= r) return { it, mode: 'scale', h };
    return null;
  }

  // ------------------------------------------------------------------ desenho na tela

  let rafPending = false;
  function requestRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(render);
  }

  function strokePath(st) {
    if (st.path) return st.path;
    const p = new Path2D(), pts = st.pts, n = pts.length / 2;
    p.moveTo(pts[0], pts[1]);
    if (n === 1) p.lineTo(pts[0] + 0.01, pts[1]);
    else if (n === 2) p.lineTo(pts[2], pts[3]);
    else {
      for (let i = 1; i < n - 1; i++) {
        const mx = (pts[2 * i] + pts[2 * i + 2]) / 2, my = (pts[2 * i + 1] + pts[2 * i + 3]) / 2;
        p.quadraticCurveTo(pts[2 * i], pts[2 * i + 1], mx, my);
      }
      p.lineTo(pts[2 * n - 2], pts[2 * n - 1]);
    }
    return p;
  }

  /** Desenha itens e traços com cena -> pixels = k * cena + (tx, ty). */
  function paint(g, items, strokes, k, tx, ty, cull) {
    for (const it of items) {
      if (cull) {
        const b = itemBounds(it);
        if ((b.x + b.w) * k + tx < 0 || (b.y + b.h) * k + ty < 0 || b.x * k + tx > cull.w || b.y * k + ty > cull.h) continue;
      }
      const m = matrix(it), res = S.images.get(it.resId);
      g.setTransform(m[0] * k, m[1] * k, m[3] * k, m[4] * k, m[6] * k + tx, m[7] * k + ty);
      g.globalAlpha = it.opacity;
      const x = it.cropX - it.dw / 2, y = it.cropY - it.dh / 2;
      if (res && res.ready) {
        let src = res.img, ps = 1;
        if (res.preview && it.scale * k <= res.previewScale * 1.1) { src = res.preview; ps = res.previewScale; }
        g.drawImage(src, it.srcX * ps, it.srcY * ps, it.dw * ps, it.dh * ps, x, y, it.dw, it.dh);
      } else {
        g.fillStyle = '#5a5a61';
        g.fillRect(x, y, it.dw, it.dh);
        g.strokeStyle = '#cc4d4d'; g.lineWidth = 4;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + it.dw, y + it.dh); g.moveTo(x + it.dw, y); g.lineTo(x, y + it.dh); g.stroke();
      }
    }
    g.globalAlpha = 1;
    g.setTransform(k, 0, 0, k, tx, ty);
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const st of strokes) {
      if (!st.pts.length) continue;
      g.strokeStyle = 'rgba(' + Math.round(st.r * 255) + ',' + Math.round(st.g * 255) + ',' + Math.round(st.b * 255) + ',' + st.a + ')';
      g.lineWidth = st.width;
      if (st === S.current) g.stroke(strokePath({ pts: st.pts }));
      else g.stroke(st.path || (st.path = strokePath(st)));
    }
  }

  function render() {
    rafPending = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    const strokes = S.current ? S.strokes.concat([S.current]) : S.strokes;
    paint(ctx, S.items, strokes, S.zoom * dpr, S.panX * dpr, S.panY * dpr, { w: canvas.width, h: canvas.height });

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sel = selected();
    for (const it of sel) {
      const cs = corners(it).map(([x, y]) => toView(x, y));
      ctx.beginPath();
      ctx.moveTo(cs[0][0], cs[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(cs[i][0], cs[i][1]);
      ctx.closePath();
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.stroke();
      ctx.lineWidth = 1.75; ctx.strokeStyle = ACCENT; ctx.stroke();
    }
    if (sel.length === 1 && S.tool === 'select') {
      const h = handlePoints(sel[0]);
      ctx.lineWidth = 1.5; ctx.strokeStyle = ACCENT;
      ctx.beginPath(); ctx.moveTo(h.mid[0], h.mid[1]); ctx.lineTo(h.knob[0], h.knob[1]); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
      for (const c of h.cs) { ctx.beginPath(); ctx.rect(c[0] - 6, c[1] - 6, 12, 12); ctx.fill(); ctx.stroke(); }
      ctx.fillStyle = ACCENT;
      ctx.beginPath(); ctx.arc(h.knob[0], h.knob[1], 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (S.marquee) {
      const m = S.marquee;
      ctx.fillStyle = 'rgba(255,178,36,0.12)'; ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.25; ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.w, m.h);
    }
  }

  function renderToCanvas(items, strokes, opts) {
    const b = boundsOf(items, strokes);
    if (!b || b.w <= 0 || b.h <= 0) return null;
    let k = opts.maxSide ? opts.maxSide / Math.max(b.w, b.h) : opts.scale;
    k = Math.min(k, Math.sqrt(MAX_PIXELS / (b.w * b.h)));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(b.w * k));
    c.height = Math.max(1, Math.round(b.h * k));
    const g = c.getContext('2d');
    if (opts.bg) { g.fillStyle = opts.bg; g.fillRect(0, 0, c.width, c.height); }
    g.imageSmoothingQuality = 'high';
    paint(g, items, strokes, k, -b.x * k, -b.y * k, null);
    return c;
  }
  const canvasBlob = (c, type, quality) => new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('Não foi possível gerar a imagem'))), type, quality);
  });

  // ------------------------------------------------------------------ vista

  function resize() {
    dpr = window.devicePixelRatio || 1;
    vw = window.innerWidth; vh = window.innerHeight;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    requestRender();
  }
  function viewChanged() { requestRender(); updateStatus(); schedulePersist(); }
  function zoomAt(x, y, factor) {
    const z = clamp(S.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const sx = (x - S.panX) / S.zoom, sy = (y - S.panY) / S.zoom;
    S.zoom = z; S.panX = x - sx * z; S.panY = y - sy * z;
    viewChanged();
  }
  function fitAll() {
    const b = contentBounds();
    const top = $('#top').getBoundingClientRect().bottom + 14, bottom = 132, side = 24;
    const aw = Math.max(vw - 2 * side, 60), ah = Math.max(vh - top - bottom, 60);
    if (!b || b.w <= 0 || b.h <= 0) { S.zoom = 1; S.panX = vw / 2; S.panY = vh / 2; viewChanged(); return; }
    S.zoom = clamp(Math.min(aw / b.w, ah / b.h), MIN_ZOOM, 2);
    S.panX = side + (aw - b.w * S.zoom) / 2 - b.x * S.zoom;
    S.panY = top + (ah - b.h * S.zoom) / 2 - b.y * S.zoom;
    viewChanged();
  }
  function visibleInView(b) {
    const [x0, y0] = toView(b.x, b.y), [x1, y1] = toView(b.x + b.w, b.y + b.h);
    return x0 >= 0 && y0 >= 60 && x1 <= vw && y1 <= vh - 60;
  }

  // ------------------------------------------------------------------ recursos de imagem

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Imagem ilegível'));
      img.src = url;
    });
  }
  const mimeOf = (format) => (format === 'PNG' ? 'image/png' : 'image/jpeg');

  async function addResource(meta, blob) {
    const res = Object.assign({}, meta, { blob, url: null, img: null, preview: null, previewScale: 1, ready: false });
    if (blob) {
      res.url = URL.createObjectURL(blob);
      try {
        res.img = await loadImage(res.url);
        res.fullW = res.img.naturalWidth; res.fullH = res.img.naturalHeight;
        res.ready = res.fullW > 0 && res.fullH > 0;
      } catch (e) { /* fica como imagem ausente */ }
    }
    if (!res.ready) { res.fullW = Math.max(meta.width || 0, 64); res.fullH = Math.max(meta.height || 0, 64); }
    S.images.set(res.id, res);
    if (res.ready && Math.max(res.fullW, res.fullH) > 1600) { previewQueue.push(res); pumpPreviews(); }
    return res;
  }

  // Imagens grandes ganham uma cópia reduzida, usada enquanto aparecem pequenas na tela.
  const previewQueue = [];
  let previewBusy = false;
  async function pumpPreviews() {
    if (previewBusy) return;
    previewBusy = true;
    while (previewQueue.length) {
      const res = previewQueue.shift();
      if (S.images.get(res.id) !== res) continue;
      try {
        const k = 1024 / Math.max(res.fullW, res.fullH);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(res.fullW * k)); c.height = Math.max(1, Math.round(res.fullH * k));
        c.getContext('2d').drawImage(res.img, 0, 0, c.width, c.height);
        const blob = await canvasBlob(c, mimeOf(res.format), 0.85);
        c.width = c.height = 0;
        res.previewUrl = URL.createObjectURL(blob);
        const img = await loadImage(res.previewUrl);
        res.preview = img; res.previewScale = img.naturalWidth / res.fullW;
        requestRender();
      } catch (e) { /* segue com a imagem inteira */ }
      await new Promise((r) => setTimeout(r, 0));
    }
    previewBusy = false;
  }
  function releaseResource(res) {
    if (res.url) URL.revokeObjectURL(res.url);
    if (res.previewUrl) URL.revokeObjectURL(res.previewUrl);
    S.images.delete(res.id);
  }

  function makeBoardItem(fields, imageItem, res, world) {
    const fullW = res.fullW, fullH = res.fullH, t = imageItem.imageTransform;
    let cropX = t[6] + fullW / 2, cropY = t[7] + fullH / 2, dw = fullW, dh = fullH, srcX = 0, srcY = 0;
    const b = P.pathBounds(imageItem.imageBounds);
    if (b && b.width > 0 && b.height > 0) {
      const x0 = Math.max(0, Math.floor(b.x - t[6])), y0 = Math.max(0, Math.floor(b.y - t[7]));
      const x1 = Math.min(fullW, Math.ceil(b.x - t[6] + b.width)), y1 = Math.min(fullH, Math.ceil(b.y - t[7] + b.height));
      if (x1 > x0 && y1 > y0 && !(x0 === 0 && y0 === 0 && x1 === fullW && y1 === fullH)) {
        srcX = x0; srcY = y0; dw = x1 - x0; dh = y1 - y0;
        cropX = (x0 + x1) / 2 + t[6]; cropY = (y0 + y1) / 2 + t[7];
      }
    }
    const det = world[0] * world[4] - world[1] * world[3];
    return {
      id: fields.id, resId: res.id, imageItem,
      cx: world[6], cy: world[7], scale: Math.hypot(world[0], world[1]) || 1, rotation: Math.atan2(world[1], world[0]),
      flipX: false, flipY: det < 0, opacity: fields.opacity, name: fields.name, comment: fields.comment,
      cropX, cropY, dw, dh, srcX, srcY,
    };
  }

  // ------------------------------------------------------------------ importar imagens

  function detectFormat(b) {
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'PNG';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPG';
    return null;
  }
  function exifOrientation(b) {
    let o = 2;
    while (o + 12 < b.length) {
      if (b[o] !== 0xff) return 1;
      const marker = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
      if (marker === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) {
        const t = o + 10, le = b[t] === 0x49;
        const u16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
        const u32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
        const ifd = t + u32(t + 4);
        if (ifd + 2 > b.length) return 1;
        const n = u16(ifd);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > b.length) break;
          if (u16(e) === 0x0112) return u16(e + 8) || 1;
        }
        return 1;
      }
      if (marker === 0xda || marker === 0xd9) return 1;
      o += 2 + len;
    }
    return 1;
  }

  /** Deixa a imagem pronta para o .pur: PNG e JPEG entram como vieram; o resto é convertido. */
  async function prepareImage(blob, name) {
    let bytes = new Uint8Array(await blob.arrayBuffer());
    let format = detectFormat(bytes);
    const url = URL.createObjectURL(blob.type ? blob : new Blob([bytes], { type: format ? mimeOf(format) : '' }));
    try {
      const img = await loadImage(url);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('Imagem sem tamanho');
      if (!format || (format === 'JPG' && exifOrientation(bytes) > 1)) {
        const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        format = format === 'JPG' ? 'JPG' : 'PNG';
        blob = await canvasBlob(c, mimeOf(format), 0.92);
        w = c.width; h = c.height; c.width = c.height = 0;
        bytes = new Uint8Array(await blob.arrayBuffer());
      } else {
        blob = new Blob([bytes], { type: mimeOf(format) });
      }
      return { blob, format, width: w, height: h, origin: name || null, checksum: P.md5Hex(bytes) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function pdfPages(file) {
    const pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const doc = await task.promise;
    const out = [], n = Math.min(doc.numPages, 60), base = (file.name || 'documento.pdf').replace(/\.pdf$/i, '');
    try {
      for (let i = 1; i <= n; i++) {
        busy('Lendo PDF, página ' + i + ' de ' + n);
        const page = await doc.getPage(i);
        let vp = page.getViewport({ scale: 2 });
        if (vp.width * vp.height > MAX_PIXELS) vp = page.getViewport({ scale: 2 * Math.sqrt(MAX_PIXELS / (vp.width * vp.height)) });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        // intent "print": desenha de uma vez, sem depender de quadros de animação da tela
        await page.render({ canvasContext: g, canvas: c, viewport: vp, intent: 'print' }).promise;
        const blob = await canvasBlob(c, 'image/png');
        c.width = c.height = 0;
        out.push(await prepareImage(blob, n > 1 ? base + ' p' + i : base));
      }
    } finally {
      try { await task.destroy(); } catch (e) { /* já encerrado */ }
    }
    return out;
  }

  async function prepareFiles(files) {
    const list = [];
    let failed = 0;
    for (const f of files) {
      try {
        if (isPdf(f)) list.push(...(await pdfPages(f)));
        else list.push(await prepareImage(f, f.name));
      } catch (e) { failed++; console.warn('Arquivo não importado:', f.name || '(colado)', e); }
    }
    return { list, failed };
  }

  async function importFiles(files) {
    files = Array.from(files).filter((f) => !isPur(f));
    if (!files.length) return;
    busy('Importando');
    try {
      const { list, failed } = await prepareFiles(files);
      await addImported(list);
      if (failed) toast(failed === 1 ? 'Um arquivo não é uma imagem que este app consiga ler' : failed + ' arquivos não são imagens que este app consiga ler');
    } finally { busy(false); }
  }

  async function addImported(list) {
    if (!list.length) return;
    const b = contentBounds(), wasEmpty = !S.items.length;
    const maxW = Math.max(...list.map((i) => i.width)), maxH = Math.max(...list.map((i) => i.height));
    let ox, oy;
    if (b) { ox = b.x + b.w + 40; oy = b.y; }
    else { const c = toScene(vw / 2, vh / 2); ox = c[0] - (maxW + 24) / 2; oy = c[1] - (maxH + 24) / 2; }
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length))), cellW = maxW + 24, cellH = maxH + 24;
    const added = new Set();
    for (let i = 0; i < list.length; i++) {
      const im = list[i];
      let res = [...S.images.values()].find((r) => r.checksum === im.checksum && r.ready);
      if (!res) {
        res = await addResource({ id: nextImageId++, sourceType: 1, origin: im.origin, source: im.origin, format: im.format, checksum: im.checksum, width: im.width, height: im.height }, im.blob);
        persistImage(res);
      }
      const w = res.fullW, h = res.fullH;
      const imageItem = {
        imageId: res.id, imageTransform: [1, 0, 0, 0, 1, 0, -w / 2, -h / 2, 1], imageBounds: P.closedRect(-w / 2, -h / 2, w / 2, h / 2),
        playbackSpeed: 1, playbackState: 0, playbackFrame: 0, flags: 1,
      };
      const it = {
        id: nextItemId++, resId: res.id, imageItem,
        cx: ox + ((i % cols) + 0.5) * cellW, cy: oy + (Math.floor(i / cols) + 0.5) * cellH,
        scale: 1, rotation: 0, flipX: false, flipY: false, opacity: 1, name: baseName(im.origin), comment: null,
        cropX: 0, cropY: 0, dw: w, dh: h, srcX: 0, srcY: 0,
      };
      S.items.push(it);
      added.add(it.id);
    }
    S.selection = added;
    markChanged();
    const nb = boundsOf(selected(), []);
    if (wasEmpty || (nb && !visibleInView(nb))) fitAll();
  }

  async function importUrl(url) {
    busy('Baixando imagem');
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      await addImported([await prepareImage(blob, baseName(url.split(/[?#]/)[0]))]);
      return true;
    } catch (e) {
      toast('Esse site não deixa o app baixar a imagem. Salve em Fotos, ou copie a imagem, e traga para cá.');
      return false;
    } finally { busy(false); }
  }
  function imgSrcFromHtml(html) {
    if (!html) return null;
    const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  }

  // ------------------------------------------------------------------ edição

  function markChanged() {
    S.dirty = true;
    updateUI();
    requestRender();
    schedulePersist();
  }
  /** Altera os itens selecionados mantendo o centro visual de cada um no lugar. */
  function transformSelected(fn) {
    for (const it of selected()) {
      const dc = displayCenter(it);
      fn(it);
      const n = displayCenter(it);
      it.cx += dc[0] - n[0]; it.cy += dc[1] - n[1];
    }
    markChanged();
  }
  const cloneItem = (it) => Object.assign({}, it, { imageItem: JSON.parse(JSON.stringify(it.imageItem)) });
  function appendCopies(src, offset) {
    const ids = new Set();
    for (const s of src) {
      if (!S.images.has(s.resId)) continue;
      const it = Object.assign(cloneItem(s), { id: nextItemId++, cx: s.cx + offset, cy: s.cy + offset });
      S.items.push(it);
      ids.add(it.id);
    }
    S.selection = ids;
    markChanged();
  }
  function deleteSelection() {
    if (!S.selection.size) return;
    S.items = S.items.filter((it) => !S.selection.has(it.id));
    S.selection = new Set();
    markChanged();
  }
  function reorder(front) {
    const sel = selected(), rest = S.items.filter((it) => !S.selection.has(it.id));
    S.items = front ? rest.concat(sel) : sel.concat(rest);
    markChanged();
  }
  function setTool(tool) {
    S.tool = tool;
    S.current = null;
    updateUI();
    requestRender();
    schedulePersist();
  }
  function undoStroke() { if (S.strokes.length) { S.strokes.pop(); markChanged(); } }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 };
  }

  // ------------------------------------------------------------------ toques, caneta e mouse

  const ptrs = new Map();
  let G = null, spaceHeld = false, penSeen = false;

  function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  const touchList = () => [...ptrs.entries()].filter(([, q]) => q.type === 'touch');

  function panGesture(p) {
    canvas.classList.add('panning');
    return { kind: 'pan', start: p, pan0: [S.panX, S.panY] };
  }

  function startGesture(e, p) {
    const mouse = e.pointerType === 'mouse';
    if ((mouse && e.button !== 0) || spaceHeld || S.tool === 'hand') return panGesture(p);
    if (S.tool === 'pen') {
      if (e.pointerType === 'pen' && !penSeen) {
        penSeen = true;
        if (S.pen.finger) {
          S.pen.finger = false;
          syncPenUI();
          toast('Apple Pencil detectado: agora o dedo move o quadro. Para desenhar com o dedo, marque "Dedo desenha".');
        }
      }
      if (e.pointerType === 'touch' && !S.pen.finger) return panGesture(p);
      const [x, y] = toScene(p.x, p.y), c = hexToRgb(S.pen.color);
      S.current = { pts: [x, y], r: c.r, g: c.g, b: c.b, a: 1, width: S.pen.width / S.zoom };
      return { kind: 'draw', last: p };
    }
    const h = hitHandle(p, e.pointerType);
    if (h) {
      const it = h.it;
      return { kind: 'handle', mode: h.mode, id: it.id, start: p, c: h.h.dc, dcScene: displayCenter(it), o: { scale: it.scale, rotation: it.rotation, cx: it.cx, cy: it.cy } };
    }
    const it = hitItem(p), additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (it) {
      if (additive) {
        if (S.selection.has(it.id)) S.selection.delete(it.id); else S.selection.add(it.id);
        updateUI();
        return { kind: 'none' };
      }
      const g = { kind: 'drag', id: it.id, start: p, moved: false, long: false, origins: null };
      if (mouse) {
        if (!S.selection.has(it.id)) { S.selection = new Set([it.id]); updateUI(); }
      } else {
        // Toque longo soma a imagem à seleção.
        g.timer = setTimeout(() => {
          if (G !== g || g.moved) return;
          g.long = true;
          S.selection.add(it.id);
          updateUI(); requestRender();
        }, 450);
      }
      return g;
    }
    return { kind: 'marquee', start: p, moved: false, base: additive ? new Set(S.selection) : new Set(), prev: new Set(S.selection) };
  }

  function startPinch(list) {
    const a = list[0], b = list[1];
    G = {
      kind: 'pinch', a: a[0], b: b[0],
      d0: Math.max(Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y), 1),
      mid0: [(a[1].x + b[1].x) / 2, (a[1].y + b[1].y) / 2],
      zoom0: S.zoom, pan0: [S.panX, S.panY],
    };
  }
  function updatePinch() {
    const a = ptrs.get(G.a), b = ptrs.get(G.b);
    if (!a || !b) return;
    const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
    const z = clamp((G.zoom0 * d) / G.d0, MIN_ZOOM, MAX_ZOOM);
    const sx = (G.mid0[0] - G.pan0[0]) / G.zoom0, sy = (G.mid0[1] - G.pan0[1]) / G.zoom0;
    S.zoom = z; S.panX = (a.x + b.x) / 2 - sx * z; S.panY = (a.y + b.y) / 2 - sy * z;
    viewChanged();
  }

  /** Desfaz o que o primeiro dedo tinha começado (quando chega o segundo dedo ou o Pencil). */
  function cancelGesture() {
    const g = G;
    G = null;
    if (!g) return;
    clearTimeout(g.timer);
    canvas.classList.remove('panning');
    if (g.kind === 'draw') S.current = null;
    else if (g.kind === 'marquee') { S.marquee = null; S.selection = g.prev; }
    else if (g.kind === 'pan') { S.panX = g.pan0[0]; S.panY = g.pan0[1]; }
    else if (g.kind === 'drag' && g.origins) {
      for (const it of S.items) { const o = g.origins.get(it.id); if (o) { it.cx = o[0]; it.cy = o[1]; } }
    } else if (g.kind === 'handle') {
      const it = S.items.find((i) => i.id === g.id);
      if (it) Object.assign(it, g.o);
    }
    updateUI(); requestRender();
  }

  function finishGesture() {
    const g = G;
    G = null;
    clearTimeout(g.timer);
    canvas.classList.remove('panning');
    if (g.kind === 'pan') schedulePersist();
    else if (g.kind === 'draw') {
      if (S.current) { S.strokes.push(S.current); S.current = null; markChanged(); }
    } else if (g.kind === 'drag') {
      if (g.moved) markChanged();
      else if (!g.long) S.selection = new Set([g.id]);
    } else if (g.kind === 'marquee') {
      if (!g.moved) S.selection = g.base;
      S.marquee = null;
    } else if (g.kind === 'handle') markChanged();
    updateUI(); requestRender();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* sem captura */ }
    const p = pos(e);
    ptrs.set(e.pointerId, { x: p.x, y: p.y, type: e.pointerType });
    hidePanels();
    if (e.pointerType === 'touch') {
      if (G && G.ptype === 'pen') return; // palma apoiada enquanto o Pencil desenha
      const t = touchList();
      if (t.length >= 2) {
        if (G && G.kind !== 'pinch') cancelGesture();
        if (!G) startPinch(t);
        return;
      }
    } else if (e.pointerType === 'pen' && G && G.ptype === 'touch') {
      cancelGesture(); // o Pencil tem prioridade sobre o dedo
    }
    if (G) return;
    G = startGesture(e, p);
    if (G) { G.pid = e.pointerId; G.ptype = e.pointerType; }
    requestRender();
  });

  canvas.addEventListener('pointermove', (e) => {
    const q = ptrs.get(e.pointerId);
    if (!q) return;
    const p = pos(e);
    q.x = p.x; q.y = p.y;
    if (!G) return;
    if (G.kind === 'pinch') { updatePinch(); return; }
    if (e.pointerId !== G.pid) return;
    const dx = p.x - G.start?.x, dy = p.y - G.start?.y;
    if (G.kind === 'pan') {
      S.panX = G.pan0[0] + dx; S.panY = G.pan0[1] + dy;
      viewChanged();
    } else if (G.kind === 'draw') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of evs.length ? evs : [e]) {
        const pp = pos(ev);
        if (Math.hypot(pp.x - G.last.x, pp.y - G.last.y) < 0.8) continue;
        G.last = pp;
        S.current.pts.push(...toScene(pp.x, pp.y));
      }
      requestRender();
    } else if (G.kind === 'drag') {
      if (!G.moved) {
        if (Math.hypot(dx, dy) < (G.ptype === 'mouse' ? 3 : 7)) return;
        G.moved = true;
        clearTimeout(G.timer);
        if (!S.selection.has(G.id)) S.selection = new Set([G.id]);
        G.origins = new Map(selected().map((it) => [it.id, [it.cx, it.cy]]));
        updateUI();
      }
      for (const it of selected()) {
        const o = G.origins.get(it.id);
        if (o) { it.cx = o[0] + dx / S.zoom; it.cy = o[1] + dy / S.zoom; }
      }
      requestRender();
    } else if (G.kind === 'marquee') {
      if (!G.moved && Math.hypot(dx, dy) < 4) return;
      G.moved = true;
      const m = { x: Math.min(G.start.x, p.x), y: Math.min(G.start.y, p.y), w: Math.abs(dx), h: Math.abs(dy) };
      S.marquee = m;
      const [sx, sy] = toScene(m.x, m.y), sw = m.w / S.zoom, sh = m.h / S.zoom;
      const sel = new Set(G.base);
      for (const it of S.items) {
        const b = itemBounds(it);
        if (b.x < sx + sw && b.x + b.w > sx && b.y < sy + sh && b.y + b.h > sy) sel.add(it.id);
      }
      S.selection = sel;
      updateUI(); requestRender();
    } else if (G.kind === 'handle') {
      const it = S.items.find((i) => i.id === G.id);
      if (!it) return;
      const v0 = [G.start.x - G.c[0], G.start.y - G.c[1]], v1 = [p.x - G.c[0], p.y - G.c[1]];
      if (G.mode === 'rotate') {
        let r = G.o.rotation + Math.atan2(v1[1], v1[0]) - Math.atan2(v0[1], v0[0]);
        const quarter = Math.PI / 2, nearest = Math.round(r / quarter) * quarter;
        if (Math.abs(r - nearest) < 0.035) r = nearest; // encaixe suave em múltiplos de 90°
        it.rotation = r;
      } else {
        it.scale = clamp((G.o.scale * Math.max(Math.hypot(v1[0], v1[1]), 1)) / Math.max(Math.hypot(v0[0], v0[1]), 1), 0.01, 100);
      }
      const n = displayCenter(it);
      it.cx += G.dcScene[0] - n[0]; it.cy += G.dcScene[1] - n[1];
      requestRender();
    }
  });

  function pointerEnd(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* já solto */ }
    if (!G) return;
    if (G.kind === 'pinch') {
      const t = touchList();
      G = null;
      if (t.length >= 2) startPinch(t); else schedulePersist();
      return;
    }
    if (e.pointerId !== G.pid) return;
    if (e.type === 'pointercancel') cancelGesture(); else finishGesture();
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pos(e);
    if (e.ctrlKey || e.metaKey) { zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01))); return; }
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    S.panX -= dx; S.panY -= dy;
    viewChanged();
  }, { passive: false });

  // Pinça no trackpad (Safari). Com dedos na tela, a pinça é tratada pelos eventos de toque acima.
  let trackpadZoom = null;
  window.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    trackpadZoom = touchList().length ? null : { zoom: S.zoom, x: e.clientX, y: e.clientY };
  });
  window.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (trackpadZoom && !touchList().length) zoomAt(trackpadZoom.x, trackpadZoom.y, (trackpadZoom.zoom * e.scale) / S.zoom);
  });
  window.addEventListener('gestureend', (e) => { e.preventDefault(); trackpadZoom = null; });

  // ------------------------------------------------------------------ copiar e colar

  async function copySelection() {
    const sel = selected();
    if (!sel.length) { toast('Selecione uma imagem para copiar'); return false; }
    const c = renderToCanvas(sel, [], { scale: 1 / Math.min(...sel.map((i) => i.scale)) });
    clip = { items: sel.map(cloneItem), w: c ? c.width : 0, h: c ? c.height : 0, pastes: 0 };
    if (c && navigator.clipboard && window.ClipboardItem) {
      const pending = canvasBlob(c, 'image/png');
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })]);
      } catch (e) {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': await pending })]); } catch (e2) { /* fica só a cópia interna */ }
      }
    }
    toast(sel.length === 1 ? 'Imagem copiada' : sel.length + ' imagens copiadas');
    return true;
  }
  async function cutSelection() {
    const pending = copySelection();
    if (clip && S.selection.size) deleteSelection();
    await pending;
  }
  function pasteInternal() {
    if (!clip) return false;
    clip.pastes++;
    appendCopies(clip.items, (30 * clip.pastes) / S.zoom);
    const nb = boundsOf(selected(), []);
    if (nb && !visibleInView(nb)) fitAll();
    return true;
  }
  async function pasteBlobs(blobs) {
    const { list, failed } = await prepareFiles(blobs);
    // A imagem que este app pôs na área de transferência volta como itens idênticos, não como figura achatada.
    if (clip && list.length === 1 && list[0].width === clip.w && list[0].height === clip.h) return pasteInternal();
    for (const im of list) if (!im.origin) im.origin = 'Colado';
    await addImported(list);
    if (failed && !list.length) toast('O que está copiado não é uma imagem que este app consiga ler');
    return list.length > 0;
  }
  async function pasteFromButton() {
    if (navigator.clipboard && navigator.clipboard.read) {
      try {
        const items = await navigator.clipboard.read();
        const blobs = [];
        let url = null;
        for (const it of items) {
          const t = it.types.find((x) => x === 'image/png') || it.types.find((x) => x.startsWith('image/'));
          if (t) { blobs.push(await it.getType(t)); continue; }
          if (!url && it.types.includes('text/html')) url = imgSrcFromHtml(await (await it.getType('text/html')).text());
          if (!url && it.types.includes('text/plain')) {
            const text = (await (await it.getType('text/plain')).text()).trim();
            if (/^https?:\/\/\S+$/i.test(text)) url = text;
          }
        }
        if (blobs.length) { busy('Colando'); try { if (await pasteBlobs(blobs)) return; } finally { busy(false); } }
        else if (url && (await importUrl(url))) return;
      } catch (e) { /* sem permissão ou nada legível: tenta a cópia interna */ }
    }
    if (!pasteInternal()) toast('Não há imagem para colar. Copie uma imagem em outro app e toque em Colar.');
  }
  document.addEventListener('paste', (e) => {
    if (isTyping(e.target)) return;
    e.preventDefault();
    const cd = e.clipboardData;
    const files = Array.from(cd.files || []).filter((f) => f.type.startsWith('image/') || isPdf(f));
    const url = imgSrcFromHtml(cd.getData('text/html')) || (/^https?:\/\/\S+$/i.test(cd.getData('text/plain').trim()) ? cd.getData('text/plain').trim() : null);
    run(async () => {
      if (files.length) { busy('Colando'); try { await pasteBlobs(files); } finally { busy(false); } }
      else if (url) await importUrl(url);
      else if (!pasteInternal()) toast('Não há imagem para colar');
    });
  });

  // ------------------------------------------------------------------ arrastar de outros apps

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('#dropHint').hidden = false; });
  window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropHint').hidden = true; });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropHint').hidden = true;
    const dt = e.dataTransfer;
    const files = Array.from(dt.files || []);
    const url = imgSrcFromHtml(dt.getData('text/html')) || (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split(/\r?\n/).find((l) => /^(https?|data):/i.test(l));
    run(async () => {
      const board = files.find(isPur);
      if (board) { if (await confirmDiscard()) await openBoardFile(board); }
      else if (files.length) await importFiles(files);
      else if (url) await importUrl(url);
    });
  });

  // ------------------------------------------------------------------ abrir e salvar .pur

  function purWorker(msg, transfer) {
    return new Promise((resolve, reject) => {
      const w = new Worker('pur-worker.js');
      w.onmessage = (e) => { w.terminate(); if (e.data.ok) resolve(e.data); else reject(new Error(e.data.error)); };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Não foi possível carregar o leitor de .pur')); };
      w.postMessage(msg, transfer || []);
    });
  }

  function clearBoard() {
    for (const res of [...S.images.values()]) releaseResource(res);
    S.items = []; S.strokes = []; S.passthrough = []; S.metadata = P.defaultMetadata();
    S.selection = new Set(); S.current = null; S.marquee = null;
    S.name = null; S.dirty = false; S.fileHandle = null;
    clip = null;
    nextItemId = 1; nextImageId = 1;
  }

  function importDrawing(list, world) {
    const scale = Math.hypot(world[0], world[1]) || 1;
    for (const st of list) {
      const pts = [];
      for (const e of st.path.elements) pts.push(...P.apply(world, e.x, e.y));
      if (!pts.length) continue;
      S.strokes.push({ pts, r: st.red / 65535, g: st.green / 65535, b: st.blue / 65535, a: st.alpha / 65535, width: st.width * scale });
    }
  }

  async function openBoardFile(file) {
    busy('Abrindo');
    loading = true;
    try {
      const buffer = await file.arrayBuffer();
      const { doc } = await purWorker({ op: 'read', buffer }, [buffer]);
      clearBoard();
      for (const im of doc.images) {
        const meta = { id: im.id, sourceType: im.sourceType, origin: im.origin, source: im.source, format: im.format, checksum: im.checksum, width: im.width, height: im.height };
        await addResource(meta, im.data ? new Blob([im.data], { type: mimeOf(im.format) }) : null);
        im.data = null;
      }
      for (const item of doc.items) {
        if (item.kind === 'drawing' && item.drawing.strokes.t === 'strokes') { importDrawing(item.drawing.strokes.strokes, P.worldTransform(doc, item)); continue; }
        if (item.kind !== 'image') { S.passthrough.push(item); continue; }
        const res = S.images.get(item.image.imageId) || (await addResource({ id: item.image.imageId, sourceType: 1, origin: null, source: null, format: null, checksum: null, width: 0, height: 0 }, null));
        const it = makeBoardItem(item, item.image, res, P.worldTransform(doc, item));
        it.z = item.z;
        S.items.push(it);
      }
      S.items.sort((a, b) => a.z - b.z);
      for (const it of S.items) delete it.z;
      S.metadata = doc.metadata;
      S.name = file.name || 'Quadro.pur';
      nextItemId = Math.max(0, ...doc.items.map((i) => i.id)) + 1;
      nextImageId = Math.max(0, ...doc.images.map((i) => i.id)) + 1;
      loading = false;
      fitAll();
      updateUI();
      persistEverything();
      toast('Aberto: ' + S.name + (doc.checksumValid === false ? ' (o arquivo tem a verificação inválida, mas foi lido)' : ''));
    } finally {
      loading = false;
      busy(false);
    }
  }

  function buildDoc() {
    const used = new Set(S.items.map((it) => it.resId));
    const images = [...S.images.values()].filter((r) => used.has(r.id) && r.blob).sort((a, b) => a.id - b.id).map((r) => ({
      id: r.id, sourceType: r.sourceType === undefined ? 1 : r.sourceType, origin: r.origin, source: r.source,
      format: r.format, checksum: r.checksum, data: r.blob, width: r.width || r.fullW, height: r.height || r.fullH,
    }));
    const items = S.items.map((it, i) => ({
      id: it.id, parent: P.ROOT_PARENT, name: it.name, transform: matrix(it), sortOrder: { t: 'bigRational', n: i + 1, d: 1 },
      z: i, opacity: it.opacity, locked: 0, comment: it.comment, kind: 'image', image: it.imageItem,
    }));
    let next = items.length + 1;
    for (const p of S.passthrough) {
      const copy = Object.assign({}, p);
      if (copy.parent === P.ROOT_PARENT) copy.sortOrder = { t: 'bigRational', n: next++, d: 1 };
      items.push(copy);
    }
    if (S.strokes.length) {
      const ch = (v) => Math.round(clamp(v, 0, 1) * 65535);
      const strokes = S.strokes.map((s) => {
        const elements = [];
        for (let i = 0; i < s.pts.length; i += 2) elements.push({ type: i === 0 ? 0 : 1, x: s.pts[i], y: s.pts[i + 1] });
        if (elements.length === 1) elements.push({ type: 1, x: elements[0].x + 0.01, y: elements[0].y });
        return { tag: 100, colorSpec: 1, alpha: ch(s.a), red: ch(s.r), green: ch(s.g), blue: ch(s.b), width: s.width, path: { elements, currentSubpathStart: 0, fillRule: 0 }, options: new Uint8Array(20) };
      });
      items.push({
        id: Math.max(0, ...items.map((i) => i.id)) + 1, parent: P.ROOT_PARENT, name: null, transform: P.identity(),
        sortOrder: { t: 'bigRational', n: next, d: 1 }, z: items.length, opacity: 1, locked: 0, comment: null,
        kind: 'drawing', drawing: { strokes: { t: 'strokes', strokes } },
      });
    }
    const metadata = Object.assign({}, S.metadata, {
      viewTransform: P.identity(), horizontalScroll: 0, verticalScroll: 0, saved: 1,
      applicationVersion: P.APP_VERSION, thumbnail: null, sceneRect: null,
    });
    return { images, items, metadata };
  }

  async function thumbnailBytes() {
    const c = renderToCanvas(S.items, S.strokes, { maxSide: 256, bg: '#212121' });
    if (!c) return new Uint8Array(0);
    return new Uint8Array(await (await canvasBlob(c, 'image/jpeg', 0.7)).arrayBuffer());
  }
  async function makePurBytes() {
    const { bytes } = await purWorker({ op: 'write', doc: buildDoc(), thumbnail: await thumbnailBytes() });
    return bytes;
  }

  function download(file) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  const sizeText = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1).replace('.', ',') + ' MB');

  /** Entrega o arquivo ao usuário. No iPad não existe "gravar por cima": o arquivo sai pela folha de compartilhamento. */
  async function deliver(bytes, name) {
    const file = new File([bytes], name, { type: 'application/octet-stream' });
    const canShare = IS_IOS && navigator.canShare && navigator.canShare({ files: [file] });
    if (!canShare) { download(file); return true; }
    for (;;) {
      const r = await ask({
        title: 'Quadro pronto', text: name + ', ' + sizeText(bytes.length) + '. Na próxima tela, escolha "Salvar em Arquivos".',
        buttons: [{ label: 'Salvar em Arquivos', value: 'share', kind: 'primary' }, { label: 'Baixar pelo Safari', value: 'download' }, { label: 'Cancelar', value: 'cancel', kind: 'quiet' }],
      });
      if (!r || r.value === 'cancel') return false;
      if (r.value === 'download') { download(file); return true; }
      try { await navigator.share({ files: [file] }); return true; }
      catch (e) {
        if (e && e.name === 'AbortError') { toast('O quadro não foi salvo'); return false; }
        toast('O iPad recusou o compartilhamento. Tente "Baixar pelo Safari".');
      }
    }
  }

  async function saveBoard(as) {
    if (!S.items.length && !S.strokes.length && !S.passthrough.length) { toast('O quadro está vazio, não há o que salvar'); return false; }
    let name = S.name, handle = S.fileHandle;
    if (window.showSaveFilePicker && !IS_IOS) {
      if (as || !handle) {
        try {
          handle = await window.showSaveFilePicker({ suggestedName: name || 'Quadro.pur', types: [{ description: 'Quadro do PureRef', accept: { 'application/octet-stream': ['.pur'] } }] });
        } catch (e) { return false; }
        name = handle.name;
      }
    } else if (as || !name) {
      const r = await ask({
        title: 'Salvar como', text: 'Nome do arquivo', input: name ? name.replace(/\.pur$/i, '') : 'Quadro',
        buttons: [{ label: 'Salvar', value: 'ok', kind: 'primary' }, { label: 'Cancelar', value: 'cancel', kind: 'quiet' }],
      });
      if (!r || r.value !== 'ok' || !r.text.trim()) return false;
      name = r.text.trim().replace(/[\\/:*?"<>|]/g, '-');
      if (!/\.pur$/i.test(name)) name += '.pur';
    }
    let bytes;
    busy('Salvando');
    try { bytes = await makePurBytes(); } finally { busy(false); }
    let ok;
    if (handle) {
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      ok = true;
    } else ok = await deliver(bytes, name);
    if (!ok) return false;
    S.name = name; S.fileHandle = handle || null; S.dirty = false;
    updateUI();
    schedulePersist();
    toast('Salvo: ' + name);
    return true;
  }

  /** Antes de trocar de quadro: Salvar, Não salvar ou Cancelar. Devolve true se pode seguir. */
  async function confirmDiscard() {
    if (!S.dirty || (!S.items.length && !S.strokes.length)) return true;
    const r = await ask({
      title: 'Salvar as alterações em ' + (S.name || 'Sem título') + '?', text: 'Se não salvar, as alterações deste quadro serão perdidas.',
      buttons: [{ label: 'Salvar', value: 'save', kind: 'primary' }, { label: 'Não salvar', value: 'discard', kind: 'danger' }, { label: 'Cancelar', value: 'cancel', kind: 'quiet' }],
    });
    if (!r || r.value === 'cancel') return false;
    if (r.value === 'discard') return true;
    return saveBoard(false);
  }

  async function requestOpen() {
    const wasDirty = S.dirty;
    if (!(await confirmDiscard())) return;
    if (wasDirty && !S.dirty) { toast('Salvo. Toque em Abrir de novo para escolher o outro quadro.'); return; }
    $('#pickBoard').click();
  }
  async function newBoard() {
    if (!(await confirmDiscard())) return;
    clearBoard();
    S.zoom = 1; S.panX = vw / 2; S.panY = vh / 2;
    updateUI(); requestRender();
    persistEverything();
  }

  // ------------------------------------------------------------------ guardar o trabalho no aparelho

  let persistTimer = null;
  function schedulePersist() {
    if (loading) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistState, 600);
  }
  function snapshot() {
    return {
      v: 1, name: S.name, dirty: S.dirty, items: S.items, passthrough: S.passthrough, metadata: S.metadata,
      strokes: S.strokes.map((s) => ({ pts: s.pts, r: s.r, g: s.g, b: s.b, a: s.a, width: s.width })),
      images: [...S.images.values()].map((r) => ({ id: r.id, sourceType: r.sourceType, origin: r.origin, source: r.source, format: r.format, checksum: r.checksum, width: r.width, height: r.height })),
      view: { zoom: S.zoom, panX: S.panX, panY: S.panY }, pen: S.pen, tool: S.tool, nextItemId, nextImageId,
    };
  }
  function persistState() {
    clearTimeout(persistTimer);
    if (loading) return;
    // Imagens que nenhum item usa mais (nem a cópia interna) saem da memória e do armazenamento.
    const used = new Set(S.items.map((it) => it.resId));
    if (clip) for (const it of clip.items) used.add(it.resId);
    for (const res of [...S.images.values()]) if (!used.has(res.id)) releaseResource(res);
    const snap = snapshot();
    queue(async () => {
      await DB.put('kv', 'state', snap);
      const keep = new Set(snap.images.map((i) => i.id));
      for (const k of await DB.keys('images')) if (!keep.has(k)) await DB.del('images', k);
    });
  }
  function persistImage(res) {
    if (!res.blob) return;
    queue(async () => DB.put('images', res.id, await res.blob.arrayBuffer()));
  }
  function persistEverything() {
    const all = [...S.images.values()];
    queue(() => DB.clear('images'));
    for (const res of all) persistImage(res);
    persistState();
  }
  async function restore() {
    let st;
    try { st = await DB.get('kv', 'state'); } catch (e) { return; }
    if (!st || st.v !== 1) return;
    loading = true;
    busy('Abrindo o quadro guardado');
    try {
      for (const meta of st.images) {
        const buf = await DB.get('images', meta.id);
        await addResource(meta, buf ? new Blob([buf], { type: mimeOf(meta.format) }) : null);
      }
      S.items = st.items.filter((it) => S.images.has(it.resId));
      S.strokes = st.strokes; S.passthrough = st.passthrough || []; S.metadata = st.metadata || P.defaultMetadata();
      S.name = st.name; S.dirty = !!st.dirty;
      Object.assign(S.pen, st.pen || {});
      S.tool = st.tool || 'select';
      S.zoom = st.view.zoom; S.panX = st.view.panX; S.panY = st.view.panY;
      nextItemId = st.nextItemId; nextImageId = st.nextImageId;
    } catch (e) {
      clearBoard();
    } finally {
      loading = false;
      busy(false);
    }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) persistState(); });
  window.addEventListener('pagehide', persistState);
  window.addEventListener('beforeunload', (e) => {
    if (!IS_IOS && S.dirty && (S.items.length || S.strokes.length)) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------------ interface

  let toastTimer = null;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, Math.min(7000, 2200 + text.length * 45));
  }
  function busy(text) {
    $('#busy').hidden = !text;
    if (text) $('#busyText').textContent = text;
  }
  function run(fn) {
    Promise.resolve().then(fn).catch((e) => {
      busy(false);
      loading = false;
      toast((e && e.message) || 'Algo deu errado');
    });
  }
  const isTyping = (t) => t && (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'color' || t.tagName === 'TEXTAREA');

  const dialog = $('#dialog');
  let dialogResolve = null;
  function ask({ title, text, buttons, input }) {
    return new Promise((resolve) => {
      $('#dlgTitle').textContent = title;
      $('#dlgText').textContent = text || '';
      const field = $('#dlgInput');
      field.hidden = input === undefined;
      field.value = input === undefined ? '' : input;
      const box = $('#dlgButtons');
      box.textContent = '';
      const done = (value) => {
        if (!dialogResolve) return;
        dialogResolve = null;
        dialog.close();
        resolve(value === null ? null : { value, text: field.value });
      };
      dialogResolve = done;
      for (const b of buttons) {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = b.label;
        if (b.kind) el.className = b.kind;
        el.addEventListener('click', () => done(b.value));
        box.appendChild(el);
      }
      field.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); done(buttons[0].value); } };
      dialog.showModal();
      if (input !== undefined) { field.focus(); field.select(); }
    });
  }
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); if (dialogResolve) dialogResolve(null); });

  function updateStatus() {
    const n = S.items.length, t = S.strokes.length;
    $('#status').textContent = (n === 1 ? '1 imagem' : n + ' imagens') + ', ' + (t === 1 ? '1 traço' : t + ' traços') + ', zoom ' + Math.round(S.zoom * 100) + '%';
  }
  function syncPenUI() {
    $('#fingerDraws').checked = S.pen.finger;
    $('#penWidth').value = S.pen.width;
    $('#penWidthOut').textContent = S.pen.width;
    $('#penColor').value = S.pen.color;
    for (const el of document.querySelectorAll('.swatch')) el.classList.toggle('active', el.dataset.color === S.pen.color);
  }
  function syncOpacityUI() {
    const sel = selected(), targets = sel.length ? sel : S.items;
    $('#opacityTarget').textContent = sel.length ? (sel.length === 1 ? 'Imagem selecionada' : sel.length + ' imagens selecionadas') : 'Todas as imagens';
    const v = targets.length ? Math.round(targets[0].opacity * 100) : 100;
    $('#opacityRange').value = v;
    $('#opacityOut').textContent = v + '%';
  }
  function hidePanels() { $('#opacityPanel').hidden = true; }
  function updateUI() {
    for (const el of document.querySelectorAll('.tool')) el.classList.toggle('active', el.dataset.tool === S.tool);
    canvas.className = 'tool-' + S.tool;
    $('#penPalette').hidden = S.tool !== 'pen';
    $('#selbar').hidden = !S.selection.size;
    $('#empty').hidden = S.items.length > 0 || S.strokes.length > 0 || S.tool === 'pen';
    const name = $('#docname');
    name.textContent = S.name || 'Sem título';
    name.classList.toggle('dirty', S.dirty);
    document.title = (S.name ? S.name.replace(/\.pur$/i, '') + ' · ' : '') + 'RefBoard';
    if (!$('#opacityPanel').hidden) syncOpacityUI();
    updateStatus();
  }

  const actions = {
    new: () => newBoard(),
    open: () => requestOpen(),
    import: () => $('#pickImages').click(),
    save: () => saveBoard(false),
    saveas: () => saveBoard(true),
    copy: () => copySelection(),
    paste: () => pasteFromButton(),
    cut: () => cutSelection(),
    fit: () => fitAll(),
    opacity: () => {
      const panel = $('#opacityPanel'), show = panel.hidden;
      panel.hidden = !show;
      if (show) {
        const r = $('#opacityBtn').getBoundingClientRect();
        panel.style.left = clamp(r.left + r.width / 2 - 125, 10, vw - 260) + 'px';
        panel.style.top = r.bottom + 12 + 'px';
        syncOpacityUI();
      }
    },
    undoStroke,
    clearStrokes: async () => {
      if (!S.strokes.length) return;
      const r = await ask({ title: 'Apagar todos os traços?', text: 'As imagens continuam no quadro.', buttons: [{ label: 'Apagar traços', value: 'ok', kind: 'danger' }, { label: 'Cancelar', value: 'cancel', kind: 'quiet' }] });
      if (r && r.value === 'ok') { S.strokes = []; markChanged(); }
    },
    rotl: () => transformSelected((it) => { it.rotation -= Math.PI / 2; }),
    rotr: () => transformSelected((it) => { it.rotation += Math.PI / 2; }),
    fliph: () => transformSelected((it) => { it.flipX = !it.flipX; }),
    flipv: () => transformSelected((it) => { it.flipY = !it.flipY; }),
    smaller: () => transformSelected((it) => { it.scale = clamp(it.scale / 1.1, 0.01, 100); }),
    bigger: () => transformSelected((it) => { it.scale = clamp(it.scale * 1.1, 0.01, 100); }),
    dup: () => appendCopies(selected(), 30 / S.zoom),
    front: () => reorder(true),
    back: () => reorder(false),
    all: () => { S.selection = new Set(S.items.map((it) => it.id)); updateUI(); requestRender(); },
    reset: () => transformSelected((it) => { it.scale = 1; it.rotation = 0; it.flipX = false; it.flipY = false; it.opacity = 1; }),
    delete: () => deleteSelection(),
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act && actions[b.dataset.act]) {
      if (b.dataset.act !== 'opacity') hidePanels();
      run(() => actions[b.dataset.act]());
    } else if (b.dataset.tool) { hidePanels(); setTool(b.dataset.tool); }
    else if (b.dataset.color) { S.pen.color = b.dataset.color; syncPenUI(); schedulePersist(); }
    else if (b.dataset.opacity) setOpacity(Number(b.dataset.opacity));
  });

  function setOpacity(percent) {
    const sel = selected();
    for (const it of sel.length ? sel : S.items) it.opacity = clamp(percent / 100, 0.1, 1);
    $('#opacityRange').value = percent;
    $('#opacityOut').textContent = percent + '%';
    markChanged();
  }
  $('#opacityRange').addEventListener('input', (e) => setOpacity(Number(e.target.value)));
  $('#penWidth').addEventListener('input', (e) => { S.pen.width = Number(e.target.value); syncPenUI(); schedulePersist(); });
  $('#penColor').addEventListener('input', (e) => { S.pen.color = e.target.value; syncPenUI(); schedulePersist(); });
  $('#fingerDraws').addEventListener('change', (e) => { S.pen.finger = e.target.checked; penSeen = true; schedulePersist(); });

  $('#pickBoard').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) run(() => openBoardFile(f));
  });
  $('#pickImages').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    run(async () => {
      const board = files.find(isPur);
      if (board && files.length === 1) { if (await confirmDiscard()) await openBoardFile(board); }
      else await importFiles(files);
    });
  });

  window.addEventListener('keydown', (e) => {
    if (dialog.open || isTyping(e.target)) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (e.code === 'Space') { spaceHeld = true; e.preventDefault(); return; }
    const hit = (fn) => { e.preventDefault(); run(fn); };
    if (mod) {
      if (k === 'a') hit(actions.all);
      else if (k === 'c') hit(actions.copy);
      else if (k === 'x') hit(actions.cut);
      else if (k === 'd') hit(actions.dup);
      else if (k === 'z') hit(undoStroke);
      else if (k === 's') hit(() => saveBoard(e.shiftKey));
      else if (k === 'o') hit(actions.open);
      else if (k === '0') hit(actions.fit);
      return;
    }
    if (k === 'v') setTool('select');
    else if (k === 'h') setTool('hand');
    else if (k === 'p') setTool('pen');
    else if (k === 'delete' || k === 'backspace') hit(actions.delete);
    else if (k === 'escape') { S.selection = new Set(); hidePanels(); updateUI(); requestRender(); }
    else if (k === ',' || k === '.') { S.pen.width = clamp(S.pen.width + (k === '.' ? 1 : -1), 1, 30); syncPenUI(); schedulePersist(); }
    else if (k.startsWith('arrow') && S.selection.size) {
      const d = (e.shiftKey ? 10 : 1) / S.zoom;
      const dx = k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, dy = k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0;
      for (const it of selected()) { it.cx += dx; it.cy += dy; }
      e.preventDefault();
      markChanged();
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceHeld = false; });
  window.addEventListener('blur', () => { spaceHeld = false; });
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------------ início

  for (const color of SWATCHES) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = color;
    b.style.background = color;
    b.title = 'Cor ' + color;
    $('#swatches').appendChild(b);
  }

  window.RefBoard = { S, P, buildDoc, makePurBytes, openBoardFile, importFiles, addImported, prepareImage, fitAll, actions, setTool, copySelection, pasteInternal, saveBoard, snapshot, persistState, hitHandle, hitItem, handlePoints, gesture: () => G, whenIdle: () => chain };

  resize();
  S.panX = vw / 2; S.panY = vh / 2;
  updateUI();
  syncPenUI();
  run(async () => {
    await restore();
    updateUI();
    syncPenUI();
    requestRender();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
