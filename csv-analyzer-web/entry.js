// entry.js — 工位录入 Tab（移植自 Python 版 tab_quick_entry.py）
// 优先使用 File System Access API 实时追加写本地 CSV（Chrome/Edge）；
// 不支持的浏览器自动降级为 localStorage 暂存 + 手动导出下载。
// 自包含模块：UI 事件、保存逻辑、状态刷新、目录选择全部内部完成。

(function () {
  'use strict';

  // ---------------- 常量（对齐 Python 版） ----------------
  const QE_POSITIONS = ['left', 'left_center', 'left_back', 'right', 'right_center', 'right_back'];
  const CSV_HEADER = ['时间', 'SN', '结果', '位置'];
  const SAFE_FN_SEG_RE = /^[A-Za-z0-9_.\-]+$/;
  const BOM = '\uFEFF'; // 兼容 Excel 直接打开中文
  const STAGE_PREFIX = 'qe_file_'; // localStorage 暂存 key：qe_file_YYYY-MM-DD_<position>
  const HDB_NAME = 'qe-handles';   // 存目录句柄的独立 IndexedDB
  const HDB_STORE = 'kv';

  const $ = (id) => document.getElementById(id);
  const fsSupported = typeof window.showDirectoryPicker === 'function';
  let dirHandle = null; // FileSystemDirectoryHandle（FS 模式）

  // ---------------- 时间 / CSV 工具 ----------------
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function tsStr() {
    const d = new Date();
    return todayStr() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function csvField(s) {
    s = String(s);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvLine(values) { return values.map(csvField).join(',') + '\r\n'; }
  function headerLine() { return BOM + csvLine(CSV_HEADER); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- 目录句柄持久化（IndexedDB 最小实现） ----------------
  function hdbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(HDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function hdbSet(key, value) {
    const db = await hdbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(HDB_STORE, 'readwrite');
      tx.objectStore(HDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function hdbGet(key) {
    const db = await hdbOpen();
    return new Promise((resolve, reject) => {
      const req = db.transaction(HDB_STORE, 'readonly').objectStore(HDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------- FS 模式：权限与追加写 ----------------
  async function ensurePerm(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function appendRecordFs(filename, line) {
    const fh = await dirHandle.getFileHandle(filename, { create: true });
    const file = await fh.getFile();
    const existing = file.size > 0 ? await file.text() : '';
    const writable = await fh.createWritable();
    await writable.write(existing ? existing + line : headerLine() + line);
    await writable.close();
  }

  // ---------------- 降级模式：localStorage 暂存 ----------------
  function appendRecordStaged(date, position, line) {
    const key = STAGE_PREFIX + date + '_' + position;
    const existing = localStorage.getItem(key);
    try {
      localStorage.setItem(key, existing ? existing + line : headerLine() + line);
    } catch (e) {
      throw new Error('暂存空间不足，请先导出并清空暂存');
    }
  }
  function listStagedFiles() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(STAGE_PREFIX)) {
        const rest = k.slice(STAGE_PREFIX.length);
        out.push({
          date: rest.slice(0, 10),
          position: rest.slice(11),
          key: k,
          text: localStorage.getItem(k) || '',
        });
      }
    }
    out.sort((a, b) => (a.date + a.position).localeCompare(b.date + b.position));
    return out;
  }
  function downloadFile(name, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------- 统计 ----------------
  function countInText(text) {
    let pass = 0, ng = 0;
    for (const ln of text.split(/\r?\n/)) {
      const r = (ln.split(',')[2] || '').trim().toLowerCase();
      if (r === 'pass') pass++;
      else if (r === 'ng') ng++;
    }
    return { pass, ng, total: pass + ng };
  }

  async function todayStatsFs(date) {
    let pass = 0, ng = 0;
    for await (const entry of dirHandle.values()) {
      if (entry.kind !== 'file') continue;
      if (!entry.name.startsWith(date + '_') || !entry.name.toLowerCase().endsWith('.csv')) continue;
      try {
        const c = countInText(await (await entry.getFile()).text());
        pass += c.pass; ng += c.ng;
      } catch (e) { /* 单个文件读取失败不影响整体 */ }
    }
    return { pass, ng, total: pass + ng };
  }

  function todayStatsStaged(date) {
    let pass = 0, ng = 0;
    for (const f of listStagedFiles()) {
      if (f.date !== date) continue;
      const c = countInText(f.text);
      pass += c.pass; ng += c.ng;
    }
    return { pass, ng, total: pass + ng };
  }

  // ---------------- 状态区刷新 ----------------
  async function refreshStatus(last) {
    const date = todayStr();
    let stats = { pass: 0, ng: 0, total: 0 };
    let modeLine;

    if (fsSupported && dirHandle) {
      modeLine = '保存目录：<b>' + escapeHtml(dirHandle.name) + '</b>（实时写入）';
      try { stats = await todayStatsFs(date); } catch (e) { /* 无权限时跳过统计 */ }
    } else if (fsSupported) {
      modeLine = '保存目录：<span style="color:#e5484d">未选择，请先点「浏览…」</span>';
      stats = todayStatsStaged(date);
    } else {
      const staged = listStagedFiles();
      const stagedTotal = staged.reduce((s, f) => s + countInText(f.text).total, 0);
      modeLine = '当前浏览器不支持目录直写，记录暂存浏览器（共 <b>' + stagedTotal +
        '</b> 条 / ' + staged.length + ' 个文件），请定期点「导出暂存 CSV」下载保存';
      stats = todayStatsStaged(date);
    }

    let html =
      '<div>' + modeLine + '</div>' +
      '<div class="qe-stats">' +
      '<div class="qe-stat total"><div class="num">' + stats.total + '</div><div class="lbl">今日累计</div></div>' +
      '<div class="qe-stat pass"><div class="num">' + stats.pass + '</div><div class="lbl">PASS</div></div>' +
      '<div class="qe-stat ng"><div class="num">' + stats.ng + '</div><div class="lbl">NG</div></div>' +
      '</div>';
    if (last) {
      const color = last.result === 'pass' ? '#1fa65a' : '#e5484d';
      html +=
        '<div class="qe-last">最近保存：<b>' + last.ts + '</b>　SN=<b>' + escapeHtml(last.sn) + '</b>　' +
        '结果=<span style="color:' + color + '"><b>' + last.result.toUpperCase() + '</b></span>　' +
        '位置=<b>' + escapeHtml(last.position) + '</b>　→ ' + escapeHtml(last.filename) + '</div>';
    }
    $('qeStatusBox').innerHTML = html;
  }

  function showWarn(msg) {
    $('qeStatusBox').innerHTML = '<span style="color:#e5484d">提示：' + escapeHtml(msg) + '</span>';
  }

  // ---------------- 保存主流程 ----------------
  async function onSave(result) {
    const sn = $('qeSn').value.trim();
    if (!sn) { showWarn('请先输入 SN 号'); $('qeSn').focus(); return; }

    const position = $('qePos').value.trim();
    if (!position) { showWarn('请选择或输入位置'); $('qePos').focus(); return; }
    if (!SAFE_FN_SEG_RE.test(position)) {
      showWarn('位置只能包含英文、数字、下划线、连字符或点号（避免中文与路径分隔符进入文件名）。示例：front、corner_2、line-A');
      $('qePos').focus();
      return;
    }
    if (fsSupported && !dirHandle) {
      showWarn('请先点「浏览…」选择 CSV 保存目录');
      return;
    }

    const date = todayStr(), ts = tsStr();
    const line = csvLine([ts, sn, result, position]);
    const filename = date + '_' + position + '.csv';

    try {
      if (fsSupported) {
        if (!(await ensurePerm(dirHandle))) { showWarn('未获得目录写权限'); return; }
        await appendRecordFs(filename, line);
      } else {
        appendRecordStaged(date, position, line);
      }
    } catch (e) {
      showWarn('保存失败：' + e.message);
      return;
    }

    $('qeSn').value = '';
    $('qeSn').focus();
    await refreshStatus({ sn, result, position, ts, filename });
    if (typeof setStatus === 'function') {
      setStatus('已保存：' + ts + '　SN=' + sn + '　结果=' + result.toUpperCase() +
        '　位置=' + position + '　→ ' + filename);
    }
  }

  // ---------------- 导出 / 清空暂存 ----------------
  function onExportStaged() {
    const files = listStagedFiles();
    if (!files.length) { showWarn('没有暂存记录可导出'); return; }
    files.forEach((f, i) => {
      setTimeout(() => downloadFile(f.date + '_' + f.position + '.csv', f.text), i * 300);
    });
    if (typeof setStatus === 'function') {
      setStatus('已导出 ' + files.length + ' 个 CSV 文件（浏览器可能提示允许批量下载）');
    }
  }

  function onClearStaged() {
    const files = listStagedFiles();
    if (!files.length) { showWarn('暂存已为空'); return; }
    if (!confirm('确定删除浏览器内 ' + files.length + ' 个暂存文件？已导出的不受影响。')) return;
    files.forEach(f => localStorage.removeItem(f.key));
    refreshStatus();
  }

  // ---------------- 初始化 ----------------
  function init() {
    // 位置候选
    const dl = $('qePosList');
    for (const p of QE_POSITIONS) {
      const opt = document.createElement('option');
      opt.value = p;
      dl.appendChild(opt);
    }

    if (fsSupported) {
      $('qeBtnBrowse').onclick = async () => {
        try {
          dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
          try { await hdbSet('saveDir', dirHandle); } catch (e) { /* 句柄持久化失败不影响使用 */ }
          $('qeDir').value = dirHandle.name;
          refreshStatus();
        } catch (e) { /* 用户取消选择 */ }
      };
      // 恢复上次目录句柄（权限在首次保存时随点击手势重新请求）
      (async () => {
        try {
          const h = await hdbGet('saveDir');
          if (h) {
            dirHandle = h;
            const granted = (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
            $('qeDir').value = h.name + (granted ? '' : '（首次保存时重新授权）');
            refreshStatus();
          }
        } catch (e) { /* ignore */ }
      })();
    } else {
      // 降级 UI：目录选择不可用，展示导出/清空
      $('qeBtnBrowse').disabled = true;
      $('qeDir').placeholder = '当前浏览器不支持目录直写，记录暂存浏览器';
      $('qeBtnExport').style.display = '';
      $('qeBtnClearStaged').style.display = '';
      $('qeBtnExport').onclick = onExportStaged;
      $('qeBtnClearStaged').onclick = onClearStaged;
    }

    $('qeBtnPass').onclick = () => onSave('pass');
    $('qeBtnNg').onclick = () => onSave('ng');
    $('qeSn').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onSave('pass'); }
    });

    refreshStatus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
