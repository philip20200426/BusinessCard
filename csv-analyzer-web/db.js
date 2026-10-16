// db.js — IndexedDB 封装
const DB_NAME = 'csv-analyzer-web';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('files')) {
        const os = db.createObjectStore('files', { keyPath: 'id', autoIncrement: true });
        os.createIndex('path', 'path', { unique: true });
      }
      if (!db.objectStoreNames.contains('records')) {
        const os = db.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        os.createIndex('sn', 'sn', { unique: false });
        os.createIndex('test_time', 'test_time', { unique: false });
        os.createIndex('pass_status', 'pass_status', { unique: false });
        os.createIndex('fileId', 'fileId', { unique: false });
      }
      if (!db.objectStoreNames.contains('columns')) {
        const os = db.createObjectStore('columns', { keyPath: 'key' });
        os.createIndex('norm', 'norm', { unique: true });
      }
    };
  });
}

function wrapReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function clearStore(db, name) {
  const tx = db.transaction(name, 'readwrite');
  tx.objectStore(name).clear();
  await txComplete(tx);
}

async function clearAllData(db) {
  await clearStore(db, 'records');
  await clearStore(db, 'files');
  await clearStore(db, 'columns');
  // keep meta intentionally (mapping etc.)
}

async function getMeta(db, key, defaultValue = '') {
  const tx = db.transaction('meta', 'readonly');
  const res = await wrapReq(tx.objectStore('meta').get(key));
  return res ? res.value : defaultValue;
}

async function setMeta(db, key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ key, value });
  await txComplete(tx);
}

async function getFileByPath(db, path) {
  const tx = db.transaction('files', 'readonly');
  const idx = tx.objectStore('files').index('path');
  return wrapReq(idx.get(path));
}

async function listFiles(db) {
  const tx = db.transaction('files', 'readonly');
  return wrapReq(tx.objectStore('files').getAll());
}

async function insertFile(db, obj) {
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  const req = store.add(obj);
  const id = await wrapReq(req);
  await txComplete(tx);
  return id;
}

async function updateFileRows(db, id, rows) {
  const tx = db.transaction('files', 'readwrite');
  const store = tx.objectStore('files');
  const obj = await wrapReq(store.get(id));
  if (obj) { obj.rows = rows; store.put(obj); }
  await txComplete(tx);
}

async function deleteFileById(db, id) {
  const tx = db.transaction('files', 'readwrite');
  tx.objectStore('files').delete(id);
  await txComplete(tx);
}

async function deleteRecordsByFileId(db, fileId) {
  const tx = db.transaction('records', 'readwrite');
  const store = tx.objectStore('records');
  const idx = store.index('fileId');
  await new Promise((resolve, reject) => {
    const req = idx.openCursor(IDBKeyRange.only(fileId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
      else resolve();
    };
    req.onerror = () => reject(req.error);
  });
  await txComplete(tx);
}

async function bulkAddRecords(db, records) {
  const CHUNK = 2000;
  for (let i = 0; i < records.length; i += CHUNK) {
    const slice = records.slice(i, i + CHUNK);
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    for (const rec of slice) store.put(rec);
    await txComplete(tx);
  }
}

async function listColumns(db) {
  const tx = db.transaction('columns', 'readonly');
  const rows = await wrapReq(tx.objectStore('columns').getAll());
  rows.sort((a, b) => {
    const na = parseInt(a.key.slice(1), 10) || 0;
    const nb = parseInt(b.key.slice(1), 10) || 0;
    return na - nb;
  });
  return rows.map(r => ({ key: r.key, name: r.name, isNumeric: !!r.isNumeric }));
}

async function getColumnByNorm(db, norm) {
  const tx = db.transaction('columns', 'readonly');
  const idx = tx.objectStore('columns').index('norm');
  return wrapReq(idx.get(norm));
}

async function addColumn(db, key, name, norm, isNumeric) {
  const tx = db.transaction('columns', 'readwrite');
  tx.objectStore('columns').put({ key, name, norm, isNumeric: isNumeric ? 1 : 0 });
  await txComplete(tx);
}

async function getAllColumnKeys(db) {
  const tx = db.transaction('columns', 'readonly');
  return wrapReq(tx.objectStore('columns').getAllKeys());
}

async function getRecordCount(db) {
  const tx = db.transaction('records', 'readonly');
  return wrapReq(tx.objectStore('records').count());
}
