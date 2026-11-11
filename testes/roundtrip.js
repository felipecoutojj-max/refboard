// Autoteste do leitor/gravador .pur em JavaScript.
// Uso: node testes/roundtrip.js <quadro.pur> <pasta-de-saida>
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Pur = require('../pur.js');
const initSqlJs = require('../vendor/sql-wasm.js');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'ok   ' : 'FALHA') + ' ' + name + (detail ? '  (' + detail + ')' : ''));
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function summary(doc) {
  return {
    images: doc.images.map((i) => [i.id, i.format, i.width, i.height, i.checksum, i.data ? i.data.length : -1]),
    items: doc.items.map((i) => [i.id, i.parent, i.kind, i.name, i.z, i.opacity, i.transform.map((v) => +v.toFixed(9)), JSON.stringify(i.sortOrder),
      i.kind === 'image' ? [i.image.imageId, i.image.imageTransform, i.image.imageBounds && i.image.imageBounds.elements.length] : null,
      i.kind === 'drawing' && i.drawing.strokes.t === 'strokes' ? i.drawing.strokes.strokes.map((s) => [s.red, s.green, s.blue, s.alpha, s.width, s.path.elements.length]) : null]),
  };
}

(async () => {
  const [src, outDir] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (f) => path.join(__dirname, '..', 'vendor', f) });

  // MD5
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 70000]) {
    const b = crypto.randomBytes(n);
    check('md5 de ' + n + ' bytes', Pur.md5Hex(new Uint8Array(b)) === crypto.createHash('md5').update(b).digest('hex'));
  }

  // QVariant
  for (const v of [
    { t: 'rectF', x: 1.5, y: -2, width: 300, height: 400 }, { t: 'sizeF', width: -1, height: -1 },
    { t: 'transform', m: [0.5, 0.25, 0, -0.25, 0.5, 0, 100, -200, 1] }, { t: 'bigRational', n: 7, d: 1 },
    { t: 'painterPath', path: Pur.closedRect(-10, -20, 10, 20) },
  ]) {
    const back = Pur.decodeVariant(Pur.encodeVariant(v));
    check('QVariant ' + v.t, JSON.stringify(back) === JSON.stringify(v));
  }
  const all = new Uint8Array(256).map((_, i) => i);
  check('latin1 <-> UTF-8', same(Array.from(Pur.utf8ToLatin1(Pur.latin1ToUtf8(all))), Array.from(all)));

  // Leitura do exemplo
  const original = new Uint8Array(fs.readFileSync(src));
  const doc = Pur.read(SQL, original.slice());
  check('lê o exemplo', doc.items.length > 0 && doc.images.length > 0, doc.items.length + ' itens, ' + doc.images.length + ' imagens');
  check('checksum do exemplo', doc.checksumValid === true);
  check('imagens com dados e MD5 certo', doc.images.every((i) => i.data && Pur.md5Hex(i.data) === i.checksum));
  console.log(JSON.stringify({ header: { ...doc.header, thumbnail: doc.header.thumbnail.length }, kinds: doc.items.map((i) => i.kind) }));

  // Regravação
  const rewritten = await Pur.write(SQL, doc, doc.header.thumbnail);
  fs.writeFileSync(path.join(outDir, 'js-regravado.pur'), rewritten);
  const back = Pur.read(SQL, rewritten.slice());
  check('regravado: checksum', back.checksumValid === true);
  check('regravado: mesmo conteúdo', JSON.stringify(summary(back)) === JSON.stringify(summary(doc)));
  check('regravado: mesmos bytes de imagem', back.images.every((im, i) => same(Array.from(im.data.subarray(0, 4096)), Array.from(doc.images[i].data.subarray(0, 4096)))));
  const info = new Pur.Reader(rewritten);
  check('regravado: cabeçalho 2.1', info.qstring() === '2.1');

  // Quadro novo com imagem espelhada/girada, traços e Blob como dado de imagem
  const img = doc.images[0];
  const w = img.width, h = img.height;
  const fresh = {
    images: [{ ...img, id: 1, data: new Blob([img.data]) }],
    items: [
      { id: 1, parent: -1, name: 'girada', transform: [0, 0.5, 0, 0.5, 0, 0, 120, -40, 1], sortOrder: { t: 'bigRational', n: 1, d: 1 }, z: 0, opacity: 0.6, locked: 0, comment: null, kind: 'image',
        image: { imageId: 1, imageTransform: [1, 0, 0, 0, 1, 0, -w / 2, -h / 2, 1], imageBounds: Pur.closedRect(-w / 2, -h / 2, w / 2, h / 2), playbackSpeed: 1, playbackState: 0, playbackFrame: 0, flags: 1 } },
      { id: 2, parent: -1, name: null, transform: Pur.identity(), sortOrder: { t: 'bigRational', n: 2, d: 1 }, z: 1, opacity: 1, locked: 0, comment: null, kind: 'drawing',
        drawing: { strokes: { t: 'strokes', strokes: [
          { alpha: 65535, red: 60909, green: 19789, blue: 19789, width: 4, path: { elements: [{ type: 0, x: 0, y: 0 }, { type: 1, x: 50, y: 80 }, { type: 1, x: 200.5, y: -3.25 }], currentSubpathStart: 0, fillRule: 0 } },
          { alpha: 32768, red: 0, green: 65535, blue: 0, width: 12.5, path: { elements: [{ type: 0, x: -5, y: -5 }, { type: 1, x: -5.01, y: -5 }], currentSubpathStart: 0, fillRule: 0 } },
        ] } } },
    ],
    metadata: Pur.defaultMetadata(),
  };
  const freshBytes = await Pur.write(SQL, fresh, new Uint8Array(0));
  fs.writeFileSync(path.join(outDir, 'js-novo.pur'), freshBytes);
  const freshBack = Pur.read(SQL, freshBytes.slice());
  check('novo: checksum', freshBack.checksumValid === true);
  check('novo: imagem e traços', freshBack.items.length === 2 && freshBack.items[1].kind === 'drawing' && freshBack.items[1].drawing.strokes.t === 'strokes' && freshBack.items[1].drawing.strokes.strokes.length === 2);
  const st = freshBack.items[1].drawing.strokes.strokes[0];
  check('novo: traço preservado', st.red === 60909 && st.width === 4 && st.path.elements[2].x === 200.5 && st.path.elements[2].y === -3.25);
  check('novo: transformação preservada', same(freshBack.items[0].transform, [0, 0.5, 0, 0.5, 0, 0, 120, -40, 1]) && freshBack.items[0].opacity === 0.6);
  check('novo: dados da imagem (Blob)', same(Array.from(freshBack.images[0].data.subarray(0, 2048)), Array.from(img.data.subarray(0, 2048))) && freshBack.images[0].data.length === img.data.length);

  // Arquivos inválidos
  let msg = '';
  try { Pur.read(SQL, new Uint8Array(crypto.randomBytes(500))); } catch (e) { msg = e.message; }
  check('recusa arquivo que não é .pur', msg.length > 0, msg);
  msg = '';
  try { Pur.read(SQL, original.slice(0, original.length - 50)); } catch (e) { msg = e.message; }
  check('recusa arquivo truncado', msg.length > 0, msg);

  console.log('\n' + passed + ' verificações ok, ' + failed + ' falhas');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
