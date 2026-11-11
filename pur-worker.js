/* RefBoard: lê e grava .pur fora da tela principal. Cada pedido usa um worker novo, que é encerrado
   em seguida para devolver a memória do SQLite ao iPad. */
'use strict';
importScripts('vendor/sql-wasm.js', 'pur.js');

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const SQL = await initSqlJs({ locateFile: (f) => 'vendor/' + f });
    if (msg.op === 'read') {
      const doc = Pur.read(SQL, new Uint8Array(msg.buffer));
      const transfer = [];
      for (const img of doc.images) {
        if (img.data) {
          // Cópia própria: o dado sai da memória do SQLite e vai para a página sem duplicar.
          const own = img.data.byteLength === img.data.buffer.byteLength ? img.data : img.data.slice();
          img.data = own;
          transfer.push(own.buffer);
        }
      }
      self.postMessage({ ok: true, doc }, transfer);
    } else if (msg.op === 'write') {
      const bytes = await Pur.write(SQL, msg.doc, msg.thumbnail);
      self.postMessage({ ok: true, bytes }, [bytes.buffer]);
    } else {
      throw new Error('Operação desconhecida: ' + msg.op);
    }
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
