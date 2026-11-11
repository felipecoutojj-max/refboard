/* RefBoard: leitor e gravador de arquivos PureRef 2.1 (.pur).
   Funciona na página, em Web Worker e no Node. Precisa do sql.js (SQLite em WebAssembly) passado como `SQL`.

   Layout de um .pur, com D = banco SQLite, N = len(D) e H = tamanho do cabeçalho:
     [0, H)     cabeçalho PureRef
     [H, N)     D[H:N]
     [N, N+H)   D[0:H]  (o início do SQLite, deslocado para o fim) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pur = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT_VERSION = '2.1';
  const APP_VERSION = '2.1.3';
  const ROOT_PARENT = -1;
  const SQLITE_MAGIC = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];

  class PurError extends Error {}

  // ---------------------------------------------------------------- MD5

  const MD5_K = new Int32Array(64);
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

  function md5Hex(bytes) {
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    const M = new Int32Array(16);
    function block(buf, off) {
      for (let i = 0; i < 16; i++, off += 4) M[i] = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        const round = i >> 4;
        if (round === 0) { F = (B & C) | (~B & D); g = i; }
        else if (round === 1) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (round === 2) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + MD5_K[i] + M[g]) | 0;
        const s = MD5_S[(round << 2) | (i & 3)];
        A = D; D = C; C = B;
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const n = bytes.length;
    const full = n - (n % 64);
    for (let off = 0; off < full; off += 64) block(bytes, off);
    const rest = n - full;
    const tail = new Uint8Array(rest < 56 ? 64 : 128);
    tail.set(bytes.subarray(full, n));
    tail[rest] = 0x80;
    const lo = (n << 3) >>> 0, hi = Math.floor(n / 536870912);
    const L = tail.length;
    tail[L - 8] = lo & 255; tail[L - 7] = (lo >>> 8) & 255; tail[L - 6] = (lo >>> 16) & 255; tail[L - 5] = lo >>> 24;
    tail[L - 4] = hi & 255; tail[L - 3] = (hi >>> 8) & 255; tail[L - 2] = (hi >>> 16) & 255; tail[L - 1] = (hi >>> 24) & 255;
    for (let off = 0; off < L; off += 64) block(tail, off);
    let out = '';
    for (const v of [a0, b0, c0, d0]) {
      for (let i = 0; i < 4; i++) out += ((v >>> (8 * i)) & 255).toString(16).padStart(2, '0');
    }
    return out;
  }

  // ---------------------------------------------------------------- QDataStream (big-endian)

  class Reader {
    constructor(bytes, position) {
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = position || 0;
    }
    get atEnd() { return this.pos >= this.bytes.length; }
    need(n) {
      if (n < 0 || this.pos + n > this.bytes.length) {
        throw new PurError('Dados truncados: faltam ' + n + ' bytes na posição ' + this.pos);
      }
    }
    readBytes(n) { this.need(n); const out = this.bytes.subarray(this.pos, this.pos + n); this.pos += n; return out; }
    u8() { this.need(1); return this.bytes[this.pos++]; }
    u16() { this.need(2); const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
    i32() { this.need(4); const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
    u64() { const hi = this.u32(), lo = this.u32(); return hi * 4294967296 + lo; }
    f64() { this.need(8); const v = this.view.getFloat64(this.pos); this.pos += 8; return v; }
    /** QString: uint32 com o tamanho em bytes (0xFFFFFFFF = nula) e depois UTF-16BE. */
    qstring() {
      const len = this.u32();
      if (len === 0xffffffff) return null;
      this.need(len);
      let s = '';
      for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(this.view.getUint16(this.pos + i));
      this.pos += len;
      return s;
    }
    qbytearray() {
      const len = this.u32();
      if (len === 0xffffffff) return null;
      return this.readBytes(len);
    }
  }

  class Writer {
    constructor(capacity) {
      this.buf = new Uint8Array(capacity || 256);
      this.view = new DataView(this.buf.buffer);
      this.len = 0;
    }
    grow(n) {
      if (this.len + n <= this.buf.length) return;
      let cap = this.buf.length * 2;
      while (cap < this.len + n) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    bytes(b) { this.grow(b.length); this.buf.set(b, this.len); this.len += b.length; }
    u8(v) { this.grow(1); this.buf[this.len++] = v & 255; }
    u16(v) { this.grow(2); this.view.setUint16(this.len, v); this.len += 2; }
    u32(v) { this.grow(4); this.view.setUint32(this.len, v >>> 0); this.len += 4; }
    i32(v) { this.grow(4); this.view.setInt32(this.len, v | 0); this.len += 4; }
    u64(v) { this.u32(Math.floor(v / 4294967296)); this.u32(v % 4294967296); }
    f64(v) { this.grow(8); this.view.setFloat64(this.len, v); this.len += 8; }
    qstring(s) {
      if (s === null || s === undefined) { this.u32(0xffffffff); return; }
      this.u32(s.length * 2);
      this.grow(s.length * 2);
      for (let i = 0; i < s.length; i++) { this.view.setUint16(this.len, s.charCodeAt(i)); this.len += 2; }
    }
    qbytearray(b) {
      if (b === null || b === undefined) { this.u32(0xffffffff); return; }
      this.u32(b.length); this.bytes(b);
    }
    result() { return this.buf.slice(0, this.len); }
  }

  // ---------------------------------------------------------------- Geometria

  const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const identity = () => IDENTITY.slice();

  /** Aplica `a` e depois `b` (convenção de vetor-linha do QTransform). Só a parte afim. */
  function concat(a, b) {
    return [
      a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], 0,
      a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], 0,
      a[6] * b[0] + a[7] * b[3] + b[6], a[6] * b[1] + a[7] * b[4] + b[7], 1,
    ];
  }
  function apply(m, x, y) { return [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]; }

  function closedRect(x0, y0, x1, y1) {
    return {
      elements: [
        { type: 0, x: x0, y: y0 }, { type: 1, x: x1, y: y0 }, { type: 1, x: x1, y: y1 },
        { type: 1, x: x0, y: y1 }, { type: 1, x: x0, y: y0 },
      ],
      currentSubpathStart: 0, fillRule: 0,
    };
  }
  function pathBounds(path) {
    if (!path || !path.elements.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of path.elements) {
      if (e.x < minX) minX = e.x; if (e.x > maxX) maxX = e.x;
      if (e.y < minY) minY = e.y; if (e.y > maxY) maxY = e.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // ---------------------------------------------------------------- QVariant

  const T_RECTF = 20, T_SIZEF = 22, T_TRANSFORM = 80, T_USER = 1024;
  const N_BIGRATIONAL = 'BigRational', N_PATH = 'QPainterPath', N_STROKES = 'QList<GraphicsDrawItem::Stroke>';

  function readPath(r) {
    const count = r.u32();
    const elements = new Array(count);
    for (let i = 0; i < count; i++) elements[i] = { type: r.i32(), x: r.f64(), y: r.f64() };
    const path = { elements, currentSubpathStart: 0, fillRule: 0 };
    if (count !== 0) { path.currentSubpathStart = r.i32(); path.fillRule = r.i32(); }
    return path;
  }
  function writePath(w, path) {
    w.u32(path.elements.length);
    for (const e of path.elements) { w.i32(e.type); w.f64(e.x); w.f64(e.y); }
    if (path.elements.length) { w.i32(path.currentSubpathStart || 0); w.i32(path.fillRule || 0); }
  }
  function readStroke(r) {
    const tag = r.u8(), colorSpec = r.u8();
    const alpha = r.u16(), red = r.u16(), green = r.u16(), blue = r.u16();
    r.u16(); // preenchimento
    const width = r.f64();
    const path = readPath(r);
    const options = r.readBytes(20).slice();
    return { tag, colorSpec, alpha, red, green, blue, width, path, options };
  }
  function writeStroke(w, s) {
    w.u8(s.tag === undefined ? 100 : s.tag); w.u8(s.colorSpec === undefined ? 1 : s.colorSpec);
    w.u16(s.alpha); w.u16(s.red); w.u16(s.green); w.u16(s.blue); w.u16(0);
    w.f64(s.width);
    writePath(w, s.path);
    const opts = new Uint8Array(20);
    if (s.options) opts.set(s.options.subarray(0, 20));
    w.bytes(opts);
  }

  function decodeVariant(bytes) {
    const r = new Reader(bytes);
    const typeId = r.u32(), isNull = r.u8();
    let typeName = null;
    if (typeId === T_USER) {
      const nameBytes = r.qbytearray();
      if (!nameBytes) throw new PurError('QVariant de usuário sem nome de tipo');
      let end = nameBytes.length;
      while (end > 0 && nameBytes[end - 1] === 0) end--;
      typeName = String.fromCharCode.apply(null, nameBytes.subarray(0, end));
    }
    const payload = bytes.slice(r.pos);
    const raw = { t: 'raw', typeId, isNull, typeName, payload };
    if (isNull !== 0) return raw;
    const p = new Reader(payload);
    try {
      if (typeId === T_RECTF) {
        const v = { t: 'rectF', x: p.f64(), y: p.f64(), width: p.f64(), height: p.f64() };
        return p.atEnd ? v : raw;
      }
      if (typeId === T_SIZEF) {
        const v = { t: 'sizeF', width: p.f64(), height: p.f64() };
        return p.atEnd ? v : raw;
      }
      if (typeId === T_TRANSFORM) {
        const m = [];
        for (let i = 0; i < 9; i++) m.push(p.f64());
        return p.atEnd ? { t: 'transform', m } : raw;
      }
      if (typeId === T_USER && typeName === N_BIGRATIONAL) {
        if (payload.length !== 32) return raw;
        const w = [];
        for (let i = 0; i < 8; i++) w.push(p.u32());
        if (!(w[0] === 1 && w[1] === 0 && w[2] === 1 && w[4] === 1 && w[5] === 0 && w[6] === 1)) return raw;
        return { t: 'bigRational', n: w[3], d: w[7] };
      }
      if (typeId === T_USER && typeName === N_PATH) {
        const path = readPath(p);
        return p.atEnd ? { t: 'painterPath', path } : raw;
      }
      if (typeId === T_USER && typeName === N_STROKES) {
        const count = p.u32();
        const strokes = [];
        for (let i = 0; i < count; i++) strokes.push(readStroke(p));
        return p.atEnd ? { t: 'strokes', strokes } : raw;
      }
    } catch (e) {
      return raw;
    }
    return raw;
  }

  function userHeader(w, name) {
    w.u32(T_USER); w.u8(0);
    const nb = new Uint8Array(name.length + 1);
    for (let i = 0; i < name.length; i++) nb[i] = name.charCodeAt(i);
    w.qbytearray(nb);
  }

  function encodeVariant(v) {
    const w = new Writer();
    switch (v.t) {
      case 'rectF': w.u32(T_RECTF); w.u8(0); w.f64(v.x); w.f64(v.y); w.f64(v.width); w.f64(v.height); break;
      case 'sizeF': w.u32(T_SIZEF); w.u8(0); w.f64(v.width); w.f64(v.height); break;
      case 'transform': w.u32(T_TRANSFORM); w.u8(0); for (const x of v.m) w.f64(x); break;
      case 'bigRational': userHeader(w, N_BIGRATIONAL); for (const x of [1, 0, 1, v.n, 1, 0, 1, v.d]) w.u32(x); break;
      case 'painterPath': userHeader(w, N_PATH); writePath(w, v.path); break;
      case 'strokes': userHeader(w, N_STROKES); w.u32(v.strokes.length); for (const s of v.strokes) writeStroke(w, s); break;
      case 'raw':
        w.u32(v.typeId); w.u8(v.isNull);
        if (v.typeId === T_USER) {
          const name = v.typeName || '';
          const nb = new Uint8Array(name.length + 1);
          for (let i = 0; i < name.length; i++) nb[i] = name.charCodeAt(i);
          w.qbytearray(nb);
        }
        w.bytes(v.payload);
        break;
      default: throw new PurError('QVariant desconhecido: ' + v.t);
    }
    return w.result();
  }

  // ---------------------------------------------------------------- Cabeçalho e contêiner

  function parseHeader(file) {
    try {
      return parseHeaderUnchecked(file);
    } catch (e) {
      throw new PurError('Este arquivo não parece ser um quadro do PureRef (.pur)');
    }
  }

  function parseHeaderUnchecked(file) {
    const r = new Reader(file);
    const formatVersion = r.qstring();
    if (formatVersion === null) throw new PurError('Cabeçalho inválido: versão de formato nula');
    if (formatVersion.length > 16 || !/^[0-9]/.test(formatVersion)) {
      throw new PurError('Este arquivo não parece ser um quadro do PureRef');
    }
    const reserved = r.u32();
    const databaseLength = r.u64();
    const appVersion = r.qstring();
    const checksum = r.qstring();
    if (appVersion === null || checksum === null) throw new PurError('Cabeçalho inválido');
    const checksumRegionStart = r.pos;
    const thumbLen = r.u32();
    const thumbnail = r.readBytes(thumbLen).slice();
    return {
      header: { formatVersion, reserved, databaseLength, appVersion, checksum, thumbnail },
      headerLength: r.pos, checksumRegionStart,
    };
  }

  function startsWithSqliteMagic(bytes) {
    if (bytes.length < 16) return false;
    for (let i = 0; i < 16; i++) if (bytes[i] !== SQLITE_MAGIC[i]) return false;
    return true;
  }

  /** Desfaz o contêiner. Reaproveita o buffer de `file` (ele fica alterado). */
  function unpack(file) {
    const parsed = parseHeader(file);
    const header = parsed.header;
    if (!header.formatVersion.startsWith('2.')) {
      throw new PurError('Versão de formato ' + header.formatVersion + ' não suportada; só arquivos 2.x do PureRef');
    }
    const h = parsed.headerLength, n = header.databaseLength;
    if (!(n >= h && n <= file.length)) throw new PurError('Cabeçalho inválido: tamanho do banco fora do arquivo');
    if (file.length - n < h) throw new PurError('Arquivo truncado: falta o início do banco de dados');
    const checksumValid = md5Hex(file.subarray(parsed.checksumRegionStart)) === header.checksum.toLowerCase();
    file.copyWithin(0, n, n + h);
    const database = file.subarray(0, n);
    if (!startsWithSqliteMagic(database)) throw new PurError('Cabeçalho inválido: o banco não começa com a assinatura do SQLite');
    return { header, headerLength: h, database, checksumValid };
  }

  function pack(database, thumbnail) {
    thumbnail = thumbnail || new Uint8Array(0);
    if (!startsWithSqliteMagic(database)) throw new PurError('O banco não começa com a assinatura do SQLite');
    const w = new Writer(256);
    w.qstring(FORMAT_VERSION); w.u32(0); w.u64(database.length); w.qstring(APP_VERSION);
    const checksumTextStart = w.len + 4;
    w.qstring('0'.repeat(32));
    const checksumRegionStart = w.len;
    w.u32(thumbnail.length);
    const prefix = w.result();
    const h = prefix.length + thumbnail.length;
    if (database.length <= h) throw new PurError('Banco menor que o cabeçalho');
    const out = new Uint8Array(database.length + h);
    out.set(prefix, 0);
    out.set(thumbnail, prefix.length);
    out.set(database.subarray(h), h);
    out.set(database.subarray(0, h), database.length);
    const sum = md5Hex(out.subarray(checksumRegionStart));
    for (let i = 0; i < 32; i++) { out[checksumTextStart + 2 * i] = 0; out[checksumTextStart + 2 * i + 1] = sum.charCodeAt(i); }
    return out;
  }

  // ---------------------------------------------------------------- SQLite

  const CREATE = [
    'CREATE TABLE images (id INTEGER PRIMARY KEY,source_type INTEGER,origin TEXT,source TEXT,format TEXT,checksum TEXT,data BLOB,width INTEGER,height INTEGER)',
    'CREATE TABLE metadata (id INTEGER PRIMARY KEY,scene_rect TEXT,application_version TEXT,view_transform TEXT,thumbnail BLOB,horizontal_scroll INTEGER,vertical_scroll INTEGER,last_save_path TEXT,last_load_path TEXT,last_load_checksum TEXT,saved INTEGER)',
    'CREATE TABLE items (parent INTEGER,id INTEGER PRIMARY KEY,name TEXT,transform BLOB,sort_order BLOB,z REAL,opacity REAL,locked INTEGER,comment INTEGER)',
    'CREATE TABLE items_images (image INTEGER,playback_speed REAL,id INTEGER PRIMARY KEY,playback_state INTEGER,image_transform BLOB,image_bounds BLOB,playback_frame INTEGER,flags INTEGER)',
    'CREATE TABLE items_drawings (id INTEGER PRIMARY KEY,strokes BLOB)',
    'CREATE TABLE items_notes (text_color TEXT,id INTEGER PRIMARY KEY,fixed_size TEXT,background_color TEXT,text TEXT,style INTEGER)',
    'CREATE TABLE items_groups (id INTEGER PRIMARY KEY,background_color TEXT,lock_mode INTEGER)',
  ];
  const PRAGMAS = [
    'PRAGMA page_size = 4096', 'PRAGMA auto_vacuum = 1', "PRAGMA encoding = 'UTF-8'", 'PRAGMA journal_mode = DELETE',
    'PRAGMA application_id = 940753918', 'PRAGMA user_version = 200101',
  ];

  /** Esquisitice do PureRef: bytes guardados um a um como U+0000..U+00FF numa célula TEXT (UTF-8). */
  function latin1ToUtf8(bytes) {
    let extra = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) extra++;
    const out = new Uint8Array(bytes.length + extra);
    let o = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) out[o++] = b;
      else { out[o++] = 0xc0 | (b >> 6); out[o++] = 0x80 | (b & 0x3f); }
    }
    return out;
  }
  function utf8ToLatin1(bytes) {
    const out = new Uint8Array(bytes.length);
    let o = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b < 0x80) out[o++] = b;
      else if ((b === 0xc2 || b === 0xc3) && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) {
        out[o++] = ((b & 0x03) << 6) | (bytes[++i] & 0x3f);
      } else return null;
    }
    return out.slice(0, o);
  }
  /** Bytes originais de uma célula lida como (typeof(col), CAST(col AS BLOB)). */
  function cellBytes(type, blob) {
    if (blob === null || blob === undefined) return null;
    if (type === 'blob') return blob;
    if (type === 'text') return utf8ToLatin1(blob);
    return null;
  }
  const raw = (col) => 'typeof(' + col + ') AS ' + col + '_t, CAST(' + col + ' AS BLOB) AS ' + col;

  function rows(db, sql) {
    const out = [];
    const stmt = db.prepare(sql);
    try { while (stmt.step()) out.push(stmt.getAsObject()); } finally { stmt.free(); }
    return out;
  }
  function decodeTransformCell(row, col) {
    const b = cellBytes(row[col + '_t'], row[col]);
    if (!b || !b.length) return null;
    try { const v = decodeVariant(b); return v.t === 'transform' ? v.m : null; } catch (e) { return null; }
  }
  function decodeVariantCell(row, col) {
    const b = cellBytes(row[col + '_t'], row[col]);
    if (!b || !b.length) return null;
    return decodeVariant(b);
  }
  const num = (v, fallback) => (typeof v === 'number' ? v : (v === null || v === undefined || isNaN(Number(v)) ? fallback : Number(v)));
  const text = (v) => (v === null || v === undefined ? null : String(v));

  function readDatabase(SQL, database) {
    const db = new SQL.Database(database);
    const doc = { images: [], items: [], metadata: defaultMetadata(), header: null, checksumValid: null };
    try {
      for (const r of rows(db, 'SELECT id, source_type, origin, source, format, checksum, typeof(data) AS data_t, CAST(data AS BLOB) AS data, width, height FROM images ORDER BY id')) {
        doc.images.push({
          id: num(r.id, 0), sourceType: num(r.source_type, 0), origin: text(r.origin), source: text(r.source),
          format: text(r.format), checksum: text(r.checksum), data: cellBytes(r.data_t, r.data),
          width: num(r.width, 0), height: num(r.height, 0),
        });
      }
      const byId = (list) => { const m = new Map(); for (const r of list) m.set(num(r.id, -1), r); return m; };
      const imageRows = byId(rows(db, 'SELECT image, playback_speed, id, playback_state, ' + raw('image_transform') + ', ' + raw('image_bounds') + ', playback_frame, flags FROM items_images'));
      const noteRows = byId(rows(db, 'SELECT text_color, id, ' + raw('fixed_size') + ', background_color, text, style FROM items_notes'));
      const groupRows = byId(rows(db, 'SELECT id, background_color, lock_mode FROM items_groups'));
      const drawingRows = byId(rows(db, 'SELECT id, ' + raw('strokes') + ' FROM items_drawings'));

      for (const r of rows(db, 'SELECT parent, id, name, ' + raw('transform') + ', ' + raw('sort_order') + ', z, opacity, locked, comment FROM items ORDER BY id')) {
        const id = num(r.id, 0);
        const item = {
          id, parent: num(r.parent, ROOT_PARENT), name: text(r.name),
          transform: decodeTransformCell(r, 'transform') || identity(),
          sortOrder: decodeVariantCell(r, 'sort_order') || { t: 'bigRational', n: 1, d: 1 },
          z: num(r.z, 0), opacity: num(r.opacity, 1), locked: num(r.locked, 0), comment: r.comment === undefined ? null : r.comment,
          kind: 'unknown',
        };
        let s;
        if ((s = imageRows.get(id))) {
          const bounds = decodeVariantCell(s, 'image_bounds');
          item.kind = 'image';
          item.image = {
            imageId: num(s.image, 0),
            imageTransform: decodeTransformCell(s, 'image_transform') || identity(),
            imageBounds: bounds && bounds.t === 'painterPath' ? bounds.path : null,
            playbackSpeed: num(s.playback_speed, 1), playbackState: num(s.playback_state, 0),
            playbackFrame: num(s.playback_frame, 0), flags: num(s.flags, 1),
          };
        } else if ((s = noteRows.get(id))) {
          const size = decodeVariantCell(s, 'fixed_size');
          item.kind = 'note';
          item.note = {
            html: text(s.text) || '', textColor: text(s.text_color),
            fixedSize: size && size.t === 'sizeF' ? { width: size.width, height: size.height } : { width: -1, height: -1 },
            backgroundColor: text(s.background_color), style: num(s.style, 0),
          };
        } else if ((s = groupRows.get(id))) {
          item.kind = 'group';
          item.group = { backgroundColor: text(s.background_color), lockMode: num(s.lock_mode, 1) };
        } else if ((s = drawingRows.get(id))) {
          item.kind = 'drawing';
          item.drawing = { strokes: decodeVariantCell(s, 'strokes') || { t: 'strokes', strokes: [] } };
        }
        doc.items.push(item);
      }

      const m = rows(db, 'SELECT id, ' + raw('scene_rect') + ', application_version, ' + raw('view_transform') +
        ', thumbnail, horizontal_scroll, vertical_scroll, last_save_path, last_load_path, last_load_checksum, saved FROM metadata ORDER BY id LIMIT 1')[0];
      if (m) {
        doc.metadata = {
          sceneRect: decodeVariantCell(m, 'scene_rect'),
          viewTransform: decodeTransformCell(m, 'view_transform') || identity(),
          horizontalScroll: num(m.horizontal_scroll, 0), verticalScroll: num(m.vertical_scroll, 0),
          applicationVersion: text(m.application_version) || '',
          thumbnail: m.thumbnail instanceof Uint8Array ? m.thumbnail : null,
          lastSavePath: text(m.last_save_path), lastLoadPath: text(m.last_load_path),
          lastLoadChecksum: text(m.last_load_checksum), saved: num(m.saved, 0),
        };
      }
    } finally {
      db.close();
    }
    return doc;
  }

  function defaultMetadata() {
    return {
      sceneRect: null, viewTransform: identity(), horizontalScroll: 0, verticalScroll: 0,
      applicationVersion: APP_VERSION, thumbnail: null, lastSavePath: null, lastLoadPath: null,
      lastLoadChecksum: null, saved: 1,
    };
  }

  /** Lê um arquivo .pur (Uint8Array). O buffer de entrada é reaproveitado e fica alterado. */
  function read(SQL, file) {
    const un = unpack(file);
    const doc = readDatabase(SQL, un.database);
    doc.header = un.header;
    doc.checksumValid = un.checksumValid;
    return doc;
  }

  async function toBytes(data) {
    if (data === null || data === undefined) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data.arrayBuffer === 'function') return new Uint8Array(await data.arrayBuffer());
    throw new PurError('Dados de imagem em formato inesperado');
  }

  const V = (v) => (v === null || v === undefined ? null : latin1ToUtf8(encodeVariant(v)));
  const T = (m) => V({ t: 'transform', m });

  async function makeDatabase(SQL, doc) {
    const db = new SQL.Database();
    try {
      for (const p of PRAGMAS) db.run(p);
      for (const c of CREATE) db.run(c);
      db.run('BEGIN');
      for (const img of doc.images) {
        db.run('INSERT INTO images (id, source_type, origin, source, format, checksum, data, width, height) VALUES (?,?,?,?,?,?,?,?,?)', [
          img.id, img.sourceType === undefined ? 1 : img.sourceType, img.origin, img.source, img.format, img.checksum,
          await toBytes(img.data), img.width, img.height,
        ]);
      }
      for (const it of doc.items) {
        db.run('INSERT INTO items (parent, id, name, transform, sort_order, z, opacity, locked, comment) VALUES (?,?,?,CAST(? AS TEXT),CAST(? AS TEXT),?,?,?,?)', [
          it.parent, it.id, it.name === undefined ? null : it.name, T(it.transform), V(it.sortOrder),
          it.z, it.opacity, it.locked || 0, it.comment === undefined ? null : it.comment,
        ]);
        if (it.kind === 'image') {
          const im = it.image;
          db.run('INSERT INTO items_images (image, playback_speed, id, playback_state, image_transform, image_bounds, playback_frame, flags) VALUES (?,?,?,?,CAST(? AS TEXT),CAST(? AS TEXT),?,?)', [
            im.imageId, im.playbackSpeed, it.id, im.playbackState, T(im.imageTransform),
            im.imageBounds ? V({ t: 'painterPath', path: im.imageBounds }) : null, im.playbackFrame, im.flags,
          ]);
        } else if (it.kind === 'note') {
          const n = it.note;
          db.run('INSERT INTO items_notes (text_color, id, fixed_size, background_color, text, style) VALUES (?,?,CAST(? AS TEXT),?,?,?)', [
            n.textColor, it.id, V({ t: 'sizeF', width: n.fixedSize.width, height: n.fixedSize.height }),
            n.backgroundColor, n.html, n.style,
          ]);
        } else if (it.kind === 'group') {
          db.run('INSERT INTO items_groups (id, background_color, lock_mode) VALUES (?,?,?)', [it.id, it.group.backgroundColor, it.group.lockMode]);
        } else if (it.kind === 'drawing') {
          db.run('INSERT INTO items_drawings (id, strokes) VALUES (?,CAST(? AS TEXT))', [it.id, V(it.drawing.strokes)]);
        }
      }
      const m = doc.metadata || defaultMetadata();
      db.run('INSERT INTO metadata (id, scene_rect, application_version, view_transform, thumbnail, horizontal_scroll, vertical_scroll, last_save_path, last_load_path, last_load_checksum, saved) VALUES (0,CAST(? AS TEXT),?,CAST(? AS TEXT),?,?,?,?,?,?,?)', [
        V(m.sceneRect), m.applicationVersion || APP_VERSION, T(m.viewTransform || identity()),
        m.thumbnail || new Uint8Array(0), Math.trunc(m.horizontalScroll || 0), Math.trunc(m.verticalScroll || 0),
        m.lastSavePath, m.lastLoadPath, m.lastLoadChecksum, m.saved === undefined ? 1 : m.saved,
      ]);
      db.run('COMMIT');
      return db.export();
    } finally {
      db.close();
    }
  }

  /** Monta os bytes de um arquivo .pur. `data` das imagens pode ser Uint8Array ou Blob. */
  async function write(SQL, doc, thumbnail) {
    const database = await makeDatabase(SQL, doc);
    return pack(database, thumbnail || (doc.metadata && doc.metadata.thumbnail) || new Uint8Array(0));
  }

  function worldTransform(doc, item) {
    const byId = new Map(doc.items.map((i) => [i.id, i]));
    let t = item.transform, parentId = item.parent, guard = 0;
    while (parentId !== ROOT_PARENT && byId.has(parentId) && guard++ < 1000) {
      const p = byId.get(parentId);
      t = concat(t, p.transform);
      parentId = p.parent;
    }
    return t;
  }

  return {
    FORMAT_VERSION, APP_VERSION, ROOT_PARENT, PurError,
    md5Hex, Reader, Writer, identity, concat, apply, closedRect, pathBounds,
    decodeVariant, encodeVariant, parseHeader, unpack, pack, latin1ToUtf8, utf8ToLatin1,
    read, readDatabase, write, makeDatabase, worldTransform, defaultMetadata,
  };
});
