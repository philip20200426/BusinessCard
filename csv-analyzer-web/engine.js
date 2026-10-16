// engine.js — 网页版 CSV 数据引擎（移植自 csv_engine.py，纯浏览器运行）
/* global Papa */

// ---------------- 常量 ----------------
const SN_ALIASES = [
  'sn', 's/n', 'sn号', 'sn码', '序列号', '序号', '条码', '条码号',
  '产品条码', 'serial', 'serial_no', 'serialnumber', 'serial number',
  '设备sn', '机号', '机身号', 'device_id', 'uid', 's n',
];
const PASS_ALIASES = [
  'pass', 'result', '判定', '测试结果', '结果', '是否通过', '是否pass',
  'pass/fail', 'passfail', '结论', '状态', '测试判定', '判定结果',
  '测试状态', '良品判定', '通过', 'ng', 'fail', 'ok',
];
const TIME_ALIASES = [
  '测试时间', '时间', '日期', '测试日期', '生产日期', 'date', 'time',
  'datetime', 'test_time', 'testtime', '测试时间点', '检测时间',
  'timestamp', 'createtime', 'create_time', '记录时间',
  '测试时间(年-月-日 时:分:秒)', '测试日期时间',
];

const PASS_WORDS = new Set([
  'pass', 'p', 'ok', '1', 'true', 'y', 'yes', '通过', '合格', '良品',
  '良', 'good', 'accept', 'accepted', 'pass(良)', 'ok(良)', 'pass(良品)',
]);
const FAIL_WORDS = new Set([
  'fail', 'f', 'ng', '0', 'false', 'n', 'no', '失败', '不合格', '不良品',
  '不良', 'bad', 'reject', 'rejected', 'fail(不良)', 'ng(不良)',
  '不通过', '不ok', '未通过', '不pass', 'false(不良)', '没通过',
]);

const ENCODING_CANDIDATES = ['utf-8', 'gb18030', 'gbk'];
const DELIMITERS = [',', '\t', ';', '|'];

// ---------------- 工具函数 ----------------
function normalizeCol(name) {
  return String(name).trim().toLowerCase()
    .replace(/[\s_\-\/:：（）()\[\]【】.、]+/g, '');
}

function _toFloat(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const f = Number(v);
  return Number.isFinite(f) ? f : null;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function parseTimeValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || ['nan', 'none', 'null', '-', 'na', 'n/a'].includes(s.toLowerCase())) return null;
  // Excel 序列号（如 46300.5）
  if (/^\d+(\.\d+)?$/.test(s) && s.includes('.')) {
    const f = parseFloat(s);
    if (f >= 20000 && f <= 80000) {
      const ms = Date.UTC(1899, 11, 30) + Math.round(f * 86400000);
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
        + `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    }
  }
  let m;
  // ISO 带 T 或空格：YYYY-MM-DD[T ]HH:MM[:SS[.fff]]
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se || 0)}`;
  }
  // YYYY/MM/DD HH:MM[:SS]
  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})[ ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se || 0)}`;
  }
  // YYYY.MM.DD HH:MM[:SS]
  m = s.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})[ ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se || 0)}`;
  }
  // 仅日期：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${pad2(mo)}-${pad2(d)} 00:00:00`;
  }
  // YYYYMMDD HH:MM:SS
  m = s.match(/^(\d{4})(\d{2})(\d{2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se)}`;
  }
  // YYYYMMDD
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo}-${d} 00:00:00`;
  }
  // MM/DD/YYYY [HH:MM:SS]
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    const [, mo, d, y, h, mi, se] = m;
    return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h || 0)}:${pad2(mi || 0)}:${pad2(se || 0)}`;
  }
  // DD/MM/YYYY [HH:MM:SS]
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    const [, d, mo, y, h, mi, se] = m;
    if (Number(d) > 12) {
      return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h || 0)}:${pad2(mi || 0)}:${pad2(se || 0)}`;
    }
  }
  return null;
}

function _wordHit(ls, words) {
  for (const w of words) {
    if (ls === w) return true;
    if (w.length >= 3 && ls.includes(w)) return true;
  }
  return false;
}

function parsePassValue(v) {
  if (v === null || v === undefined) return 'UNKNOWN';
  const s = String(v).trim();
  if (!s || ['nan', 'none', 'null', '-', 'na', 'n/a'].includes(s.toLowerCase())) return 'UNKNOWN';
  const ls = s.toLowerCase();
  if (_wordHit(ls, FAIL_WORDS)) return 'FAIL';
  if (_wordHit(ls, PASS_WORDS)) return 'PASS';
  return 'UNKNOWN';
}

function guessColumn(headers, role) {
  const aliases = { sn: SN_ALIASES, pass: PASS_ALIASES, time: TIME_ALIASES }[role];
  const normMap = new Map();
  for (const h of headers) normMap.set(normalizeCol(h), h);
  for (const a of aliases) {
    const n = normalizeCol(a);
    if (normMap.has(n)) return normMap.get(n);
  }
  for (const h of headers) {
    const hn = normalizeCol(h);
    for (const a of aliases) {
      const an = normalizeCol(a);
      if (an.length >= 4 && hn.includes(an)) return h;
    }
  }
  return null;
}

async function detectEncoding(file) {
  const buf = await file.slice(0, 8192).arrayBuffer();
  for (const enc of ENCODING_CANDIDATES) {
    try {
      new TextDecoder(enc, { fatal: true }).decode(buf);
      return enc;
    } catch (e) { /* try next */ }
  }
  return 'gb18030'; // 兜底：能解任意单字节，中文一般也正确
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 10);
  let best = ',', bestScore = 0;
  for (const sep of DELIMITERS) {
    let total = 0;
    for (const line of lines) total += line.split(sep).length - 1;
    if (total > bestScore) { bestScore = total; best = sep; }
  }
  return best;
}

function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function parseCsvFile(file, opts) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, Object.assign({}, opts, {
      complete: (res) => { if (opts.complete) opts.complete(res); resolve(res); },
      error: (err) => reject(err),
    }));
  });
}

// ---------------- 引擎 ----------------
class Engine {
  constructor() {
    this.db = null;
    this._cancel = false;
  }

  async open() { this.db = await openDB(); }
  close() { if (this.db) { this.db.close(); this.db = null; } }
  cancel() { this._cancel = true; }

  // ---------- meta / mapping ----------
  async getMeta(key, def = '') { return getMeta(this.db, key, def); }
  async setMeta(key, value) { return setMeta(this.db, key, value); }

  async saveMapping(mapping) {
    await this.setMeta('column_mapping', JSON.stringify(mapping));
  }
  async loadMapping() {
    const raw = await this.getMeta('column_mapping', '');
    if (raw) { try { return JSON.parse(raw); } catch (e) { /* ignore */ } }
    return {};
  }

  // ---------- 列管理 ----------
  async listColumns() { return listColumns(this.db); }

  async _columnKeyByName(name) {
    const norm = normalizeCol(name);
    const row = await getColumnByNorm(this.db, norm);
    if (row) return { key: row.key, name: row.name, isNumeric: !!row.isNumeric };
    return null;
  }

  async _nextColKey() {
    const keys = await getAllColumnKeys(this.db);
    let max = 0;
    for (const k of keys) {
      if (typeof k === 'string' && k[0] === 'c' && /^\d+$/.test(k.slice(1))) {
        max = Math.max(max, parseInt(k.slice(1), 10));
      }
    }
    return `c${max + 1}`;
  }

  async _ensureColumn(name, sampleValues) {
    const norm = normalizeCol(name);
    const existing = await getColumnByNorm(this.db, norm);
    if (existing) return existing.key;
    let nums = 0, total = 0;
    for (const v of sampleValues.slice(0, 500)) {
      if (v === null || v === undefined || String(v).trim() === '') continue;
      total++;
      if (_toFloat(v) !== null) nums++;
    }
    const isNumeric = (total > 0 && nums / total >= 0.8) ? 1 : 0;
    const key = await this._nextColKey();
    await addColumn(this.db, key, String(name), norm, isNumeric);
    return key;
  }

  _resolveRoleColumns(headers, mapping) {
    const result = { sn: null, pass: null, time: null };
    mapping = mapping || {};
    for (const role of Object.keys(result)) {
      if (mapping[role] && headers.includes(mapping[role])) result[role] = mapping[role];
      else result[role] = guessColumn(headers, role);
    }
    return result;
  }

  // ---------- 表头扫描 ----------
  async scanHeaders(files) {
    const colSet = new Set();
    let okFiles = 0;
    for (const fp of files) {
      try {
        const enc = await detectEncoding(fp);
        const headBuf = await fp.slice(0, 8192).arrayBuffer();
        const text = new TextDecoder(enc).decode(headBuf);
        const sep = detectDelimiter(text);
        const res = await parseCsvFile(fp, {
          encoding: enc, delimiter: sep, header: true, preview: 1, skipEmptyLines: true,
        });
        for (const c of (res.meta.fields || [])) colSet.add(String(c).trim());
        okFiles++;
      } catch (e) { /* skip bad file */ }
    }
    const headers = Array.from(colSet);
    return {
      filesTotal: files.length,
      filesOk: okFiles,
      columns: headers,
      guesses: { sn: guessColumn(headers, 'sn'), pass: guessColumn(headers, 'pass'), time: guessColumn(headers, 'time') },
    };
  }

  // ---------- 导入 ----------
  async scanFiles(files, { incremental = true, mapping = null, progressCb = null, cancelCheck = null } = {}) {
    this._cancel = false;
    const summary = {
      totalFiles: files.length, newFiles: 0, updatedFiles: 0,
      skipped: 0, removed: 0, records: 0, cancelled: false, errors: [],
    };
    if (!files.length) return summary;

    const dbFiles = await listFiles(this.db);
    const dbMap = new Map(dbFiles.map(f => [f.path, f]));
    const seen = new Set();

    for (let i = 0; i < files.length; i++) {
      if ((cancelCheck && cancelCheck()) || this._cancel) { summary.cancelled = true; break; }
      const fp = files[i];
      const path = fp.webkitRelativePath || fp.name;
      seen.add(path);
      const old = dbMap.get(path);
      if (incremental && old && old.mtime === fp.lastModified && old.size === fp.size) {
        summary.skipped++;
        if (progressCb) progressCb(i + 1, files.length, fp.name, -1);
        continue;
      }
      let n = -1;
      try {
        n = await this._importFile(fp, mapping);
        summary.records += n;
        if (old) summary.updatedFiles++; else summary.newFiles++;
      } catch (e) {
        if (this._cancel) { summary.cancelled = true; break; }
        summary.errors.push(`${fp.name}: ${e && e.message ? e.message : e}`);
      }
      if (progressCb) progressCb(i + 1, files.length, fp.name, n);
    }

    if (incremental) {
      for (const dbf of dbFiles) {
        if (!seen.has(dbf.path)) {
          await deleteRecordsByFileId(this.db, dbf.id);
          await deleteFileById(this.db, dbf.id);
          summary.removed++;
        }
      }
    }

    await this._refreshMeta();
    return summary;
  }

  async rebuild(files, opts = {}) {
    await clearStore(this.db, 'records');
    await clearStore(this.db, 'files');
    await clearStore(this.db, 'columns');
    return this.scanFiles(files, Object.assign({}, opts, { incremental: false }));
  }

  async _importFile(fp, mapping) {
    const path = fp.webkitRelativePath || fp.name;
    const enc = await detectEncoding(fp);
    const headText = new TextDecoder(enc).decode(await fp.slice(0, 8192).arrayBuffer());
    const sep = detectDelimiter(headText);

    // 预览前 1000 行：取表头 + 数值列判定样本
    const preview = await parseCsvFile(fp, {
      encoding: enc, delimiter: sep, header: true, preview: 1000, skipEmptyLines: true,
      transformHeader: h => String(h).trim(),
    });
    const headers = (preview.meta.fields || []).map(h => String(h).trim());
    if (!headers.length) return 0;
    const roleCols = this._resolveRoleColumns(headers, mapping);

    const colKeys = [];
    for (const h of headers) {
      const vals = preview.data.map(r => r[h]);
      colKeys.push(await this._ensureColumn(h, vals));
    }
    const idxOf = h => headers.indexOf(h);
    const snKey = roleCols.sn && headers.includes(roleCols.sn) ? colKeys[idxOf(roleCols.sn)] : null;
    const passKey = roleCols.pass && headers.includes(roleCols.pass) ? colKeys[idxOf(roleCols.pass)] : null;
    const timeKey = roleCols.time && headers.includes(roleCols.time) ? colKeys[idxOf(roleCols.time)] : null;

    // 旧文件数据先删除（增量更新场景）
    const old = await getFileByPath(this.db, path);
    if (old) {
      await deleteRecordsByFileId(this.db, old.id);
      await deleteFileById(this.db, old.id);
    }
    const fileId = await insertFile(this.db, {
      path, mtime: fp.lastModified, size: fp.size, rows: 0,
      headers, importedAt: nowStr(),
    });

    // 全量流式解析
    let total = 0;
    let buffer = [];
    const self = this;
    await new Promise((resolve, reject) => {
      Papa.parse(fp, {
        encoding: enc, delimiter: sep, header: true, skipEmptyLines: true,
        transformHeader: h => String(h).trim(),
        chunkSize: 1024 * 512,
        chunk: (results, parser) => {
          if (self._cancel) { parser.abort(); return; }
          for (const row of results.data) {
            const rec = { fileId, filePath: path, sn: '', pass_status: 'UNKNOWN', test_time: null, d: {} };
            for (let j = 0; j < headers.length; j++) {
              const h = headers[j];
              const key = colKeys[j];
              const v = row[h];
              const sv = (v === null || v === undefined) ? '' : String(v).trim();
              if (key === snKey) rec.sn = sv;
              else if (key === passKey) rec.pass_status = parsePassValue(v);
              else if (key === timeKey) rec.test_time = parseTimeValue(v);
              else if (sv !== '') rec.d[key] = sv;
            }
            buffer.push(rec);
          }
          if (buffer.length >= 2000) {
            parser.pause();
            const chunk = buffer; buffer = [];
            bulkAddRecords(self.db, chunk).then(
              () => { if (!self._cancel) parser.resume(); else parser.abort(); },
              reject,
            );
          }
        },
        complete: async () => {
          try {
            if (buffer.length && !self._cancel) await bulkAddRecords(self.db, buffer);
            resolve();
          } catch (e) { reject(e); }
        },
        error: (err) => reject(err),
      });
    });

    if (this._cancel) {
      // 取消时清理本文件残留，保持库一致
      await deleteRecordsByFileId(this.db, fileId);
      await deleteFileById(this.db, fileId);
      throw new Error('cancelled');
    }

    total = await this._countFileRecords(fileId);
    await updateFileRows(this.db, fileId, total);
    return total;
  }

  async _countFileRecords(fileId) {
    const tx = this.db.transaction('records', 'readonly');
    const idx = tx.objectStore('records').index('fileId');
    return wrapReq(idx.count(IDBKeyRange.only(fileId)));
  }

  async _refreshMeta() {
    let minTime = '', maxTime = '';
    const tx = this.db.transaction('records', 'readonly');
    const idx = tx.objectStore('records').index('test_time');
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(null, 'next');
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { resolve(); return; }
        if (c.value.test_time) { minTime = c.value.test_time; resolve(); } else c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { resolve(); return; }
        if (c.value.test_time) { maxTime = c.value.test_time; resolve(); } else c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    await this.setMeta('min_time', minTime);
    await this.setMeta('max_time', maxTime);
    await this.setMeta('last_scan_at', nowStr());
  }

  // ---------- 统计与查询 ----------
  async stats() {
    const files = await listFiles(this.db);
    let nRecords = 0;
    for (const f of files) nRecords += f.rows || 0;
    const cols = await this.listColumns();
    let dbSize = 0;
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        dbSize = est.usage || 0;
      }
    } catch (e) { /* ignore */ }
    return {
      files: files.length,
      records: nRecords,
      minTime: await this.getMeta('min_time', ''),
      maxTime: await this.getMeta('max_time', ''),
      lastScanAt: await this.getMeta('last_scan_at', ''),
      columns: cols.map(c => c.name),
      dbSize,
    };
  }

  async listSn(limit = 2000) {
    const tx = this.db.transaction('records', 'readonly');
    const store = tx.objectStore('records');
    const seen = new Set();
    return new Promise((resolve, reject) => {
      const req = store.openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor || seen.size >= limit) { resolve(Array.from(seen)); return; }
        const sn = cursor.value.sn;
        if (sn) seen.add(sn);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  _matchTime(r, start, end) {
    if (start && (!r.test_time || r.test_time < start)) return false;
    if (end && (!r.test_time || r.test_time > end + ' 23:59:59')) return false;
    return true;
  }

  static _matchFile(r, inc, exc) {
    if (inc.length && !inc.some(k => r.filePath.includes(k))) return false;
    if (exc.length && exc.some(k => r.filePath.includes(k))) return false;
    return true;
  }

  async getSnRecords(sn, start, end, limit = 5000) {
    const lowerSn = sn.toLowerCase();
    const rows = [];
    let truncated = false;
    const tx = this.db.transaction('records', 'readonly');
    const store = tx.objectStore('records');
    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        if (rows.length >= limit) { truncated = true; resolve(); return; }
        const r = cursor.value;
        if (r.sn && r.sn.toLowerCase().includes(lowerSn) && this._matchTime(r, start, end)) {
          rows.push(r);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    rows.sort((a, b) => {
      if (a.sn !== b.sn) return a.sn < b.sn ? -1 : 1;
      const ta = a.test_time || '', tb = b.test_time || '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return (a.id || 0) - (b.id || 0);
    });

    const cols = await this.listColumns();
    const roleNorms = new Set();
    for (const a of [...SN_ALIASES, ...PASS_ALIASES, ...TIME_ALIASES]) roleNorms.add(normalizeCol(a));
    const showCols = cols.filter(c => !roleNorms.has(normalizeCol(c.name)));

    const outRows = rows.map(r => {
      const obj = { SN: r.sn || '', 判定: r.pass_status || '', 测试时间: r.test_time || '' };
      for (const c of showCols) {
        obj[c.name] = (r.d && r.d[c.key] !== undefined) ? r.d[c.key] : '';
      }
      return obj;
    });
    return {
      columns: ['SN', '判定', '测试时间', ...showCols.map(c => c.name)],
      rows: outRows,
      truncated,
      total: rows.length,
    };
  }

  async getDistribution(colDisplay, { start = null, end = null, fileInclude = [], fileExclude = [] } = {}) {
    let col = await this._columnKeyByName(colDisplay);
    if (!col) {
      const allCols = await this.listColumns();
      const target = normalizeCol(colDisplay);
      const cands = allCols.filter(c => {
        const nc = normalizeCol(c.name);
        return nc.includes(target) || target.includes(nc);
      });
      if (cands.length === 1) col = cands[0];
      else if (cands.length > 1) {
        return { found: false, reason: `列名“${colDisplay}”匹配到多个列：${cands.map(c => c.name).join('，')}，请使用完整列名` };
      } else {
        return { found: false, reason: `未找到列“${colDisplay}”，请先在“列名设置”中确认列名，或先执行预解析` };
      }
    }
    const key = col.key;
    const inc = (fileInclude || []).filter(Boolean);
    const exc = (fileExclude || []).filter(Boolean);

    let passCount = 0, ngCount = 0, unknownCount = 0;
    const vals = [];
    const tx = this.db.transaction('records', 'readonly');
    const store = tx.objectStore('records');
    await new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) { resolve(); return; }
        const r = cursor.value;
        if (!this._matchTime(r, start, end) || !Engine._matchFile(r, inc, exc)) { cursor.continue(); return; }
        if (r.pass_status === 'PASS') passCount++;
        else if (r.pass_status === 'FAIL') ngCount++;
        else unknownCount++;
        if (r.pass_status === 'PASS') {
          const v = r.d ? r.d[key] : undefined;
          if (v !== undefined && v !== null && String(v).trim() !== '') vals.push(v);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    const rawCount = vals.length;
    if (col.isNumeric) {
      const arr = [];
      for (const v of vals) { const f = _toFloat(v); if (f !== null) arr.push(f); }
      return {
        found: true, name: col.name, isNumeric: true, values: arr, rawCount,
        passCount, ngCount, unknownCount,
      };
    }
    const counts = {};
    for (const v of vals) { const s = String(v); counts[s] = (counts[s] || 0) + 1; }
    return {
      found: true, name: col.name, isNumeric: false, counts, rawCount,
      passCount, ngCount, unknownCount,
    };
  }

  async countFiles(fileInclude = [], fileExclude = []) {
    const inc = (fileInclude || []).filter(Boolean);
    const exc = (fileExclude || []).filter(Boolean);
    const files = await listFiles(this.db);
    return files.filter(f => {
      const r = { filePath: f.path };
      return Engine._matchFile(r, inc, exc);
    }).length;
  }
}

window.Engine = Engine;
window.EngineUtil = { normalizeCol, parseTimeValue, parsePassValue, guessColumn };
