// app.js — 页面逻辑
/* global Engine, echarts */

const $ = (id) => document.getElementById(id);
const engine = new Engine();
let pickedFiles = [];
let lastSnResult = null;
let charts = [];

// ---------- 状态栏 ----------
function setStatus(msg) { $('statusBar').textContent = msg; }

// ---------- UI 设置持久化 ----------
function saveUiSetting(key, value) {
  try { localStorage.setItem('ui_' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}
function loadUiSetting(key, def) {
  try {
    const raw = localStorage.getItem('ui_' + key);
    if (raw !== null) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return def;
}

// ---------- 时间范围 ----------
function getTimeRange() {
  if (!$('timeEnable').checked) return { start: null, end: null };
  return { start: $('timeStart').value || null, end: $('timeEnd').value || null };
}

// ---------- 统计信息 ----------
async function refreshStats() {
  try {
    const s = await engine.stats();
    const sizeTxt = s.dbSize ? `，库占用约 ${(s.dbSize / 1048576).toFixed(1)} MB` : '';
    $('dbStats').textContent = s.records
      ? `已入库：${s.files} 个文件 / ${s.records} 条记录，时间范围 ${s.minTime || '—'} ~ ${s.maxTime || '—'}${sizeTxt}，上次解析 ${s.lastScanAt || '—'}`
      : '数据库为空，请先选择 CSV 目录并执行预解析';
  } catch (e) {
    $('dbStats').textContent = '统计信息读取失败：' + e.message;
  }
}

async function refreshColCombo() {
  const cols = await engine.listColumns();
  const combo = $('colCombo');
  combo.innerHTML = '<option value="">— 已知列 —</option>';
  for (const c of cols) {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name + (c.isNumeric ? '' : '（文本）');
    combo.appendChild(opt);
  }
}

async function loadSnHistory() {
  const sns = await engine.listSn(500);
  const dl = $('snList');
  dl.innerHTML = '';
  for (const s of sns) {
    const opt = document.createElement('option');
    opt.value = s;
    dl.appendChild(opt);
  }
}

// ---------- 扫描 ----------
function setScanning(on) {
  $('btnFullScan').disabled = on;
  $('btnIncrScan').disabled = on;
  $('btnPickDir').disabled = on;
  $('btnCancel').style.display = on ? '' : 'none';
  $('progressWrap').style.display = on ? 'flex' : 'none';
}

let scanning = false;

async function runScan(full) {
  if (scanning) { setStatus('已有解析任务进行中，请等待完成或先取消'); return; }
  if (!pickedFiles.length) {
    alert('请先点击“选择 CSV 目录…”选择包含 CSV 的文件夹');
    return;
  }
  if (full && !confirm('全量预解析会清空已入库数据并重新导入，确认继续？')) return;
  scanning = true;
  setScanning(true);
  engine._cancel = false;
  const mapping = await engine.loadMapping();
  const t0 = Date.now();
  try {
    const opts = {
      incremental: !full,
      mapping,
      progressCb: (done, total, name, n) => {
        const pct = Math.round(done / total * 100);
        $('progressFill').style.width = pct + '%';
        const tag = n === -1 ? '（跳过/失败）' : `（${n} 行）`;
        $('progressText').textContent = `${done}/${total} ${name} ${tag}`;
      },
    };
    const summary = full
      ? await engine.rebuild(pickedFiles, opts)
      : await engine.scanFiles(pickedFiles, opts);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let msg = `解析完成（${secs}s）：新增 ${summary.newFiles}，更新 ${summary.updatedFiles}，`
      + `跳过 ${summary.skipped}，移除 ${summary.removed}，共导入 ${summary.records} 条记录`;
    if (summary.cancelled) msg += '（已取消，完成部分已保留）';
    setStatus(msg);
    if (summary.errors.length) {
      console.warn('解析错误：', summary.errors);
      setStatus(msg + `；${summary.errors.length} 个文件出错（详见控制台）`);
    }
  } catch (e) {
    setStatus('解析失败：' + (e && e.message ? e.message : e));
  } finally {
    scanning = false;
    setScanning(false);
    $('progressFill').style.width = '0';
    $('progressText').textContent = '';
    await refreshStats();
    await refreshColCombo();
    await loadSnHistory();
  }
}

// ---------- SN 查询 ----------
function renderSnTable(result) {
  const wrap = $('snTableWrap');
  if (!result.rows.length) {
    wrap.innerHTML = '<span class="muted">没有查询到记录</span>';
    return;
  }
  let html = '<table class="data"><thead><tr>';
  for (const c of result.columns) html += `<th>${escapeHtml(c)}</th>`;
  html += '</tr></thead><tbody>';
  for (const row of result.rows) {
    html += '<tr>';
    for (const c of result.columns) {
      const v = row[c];
      let cls = '';
      if (c === '判定') cls = v === 'PASS' ? 'pass' : (v === 'FAIL' ? 'fail' : '');
      html += `<td class="${cls}">${escapeHtml(v === null || v === undefined ? '' : String(v))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function doSnQuery() {
  const sn = $('snInput').value.trim();
  if (!sn) { alert('请输入 SN 号'); return; }
  const s = await engine.stats();
  if (!s.records) { alert('数据库还没有数据，请先执行预解析'); return; }
  setStatus('正在查询…');
  const { start, end } = getTimeRange();
  try {
    const result = await engine.getSnRecords(sn, start, end);
    lastSnResult = result;
    renderSnTable(result);
    const passN = result.rows.filter(r => r['判定'] === 'PASS').length;
    const failN = result.rows.filter(r => r['判定'] === 'FAIL').length;
    let txt = `共 ${result.total} 次测试：PASS ${passN}，FAIL ${failN}，未知 ${result.total - passN - failN}`;
    if (result.truncated) txt += `（仅显示前 ${result.rows.length} 条，可导出查看全部…）`;
    $('snSummary').textContent = txt;
    setStatus(`查询完成：命中 ${result.total} 条记录`);
  } catch (e) {
    setStatus('查询失败：' + (e && e.message ? e.message : e));
  }
}

function exportSnCsv() {
  if (!lastSnResult || !lastSnResult.rows.length) { alert('请先执行查询'); return; }
  const cols = lastSnResult.columns;
  const lines = [cols.map(csvEscape).join(',')];
  for (const row of lastSnResult.rows) {
    lines.push(cols.map(c => csvEscape(row[c] === null || row[c] === undefined ? '' : String(row[c]))).join(','));
  }
  downloadText('﻿' + lines.join('\r\n'), `sn_query_${Date.now()}.csv`, 'text/csv');
}

function csvEscape(s) {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- 动态分布 ----------
const distCols = new Set();

function renderColList() {
  const ul = $('colList');
  ul.innerHTML = '';
  for (const name of distCols) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(name)}</span><a title="移除">×</a>`;
    li.querySelector('a').onclick = () => { distCols.delete(name); renderColList(); saveCols(); };
    ul.appendChild(li);
  }
}

function addCol(name) {
  name = (name || '').trim();
  if (!name) return;
  distCols.add(name);
  renderColList();
  saveCols();
}

function saveCols() { saveUiSetting('dist_cols', Array.from(distCols)); }

function splitNames(s) {
  return s.split(/[,，;；、\s]+/).map(x => x.trim()).filter(Boolean);
}

// 统计量
function meanOf(a) { let s = 0; for (const v of a) s += v; return s / a.length; }
function medianOf(a) {
  const b = a.slice().sort((x, y) => x - y);
  const n = b.length;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}
function percentileOf(a, p) {
  const b = a.slice().sort((x, y) => x - y);
  const pos = (b.length - 1) * p / 100;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return b[lo];
  return b[lo] + (b[hi] - b[lo]) * (pos - lo);
}
function stdOf(a, mean) {
  let s = 0;
  for (const v of a) s += (v - mean) * (v - mean);
  return Math.sqrt(s / a.length);
}
function fmtG(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const av = Math.abs(v);
  if (av !== 0 && (av >= 1e6 || av < 1e-3)) return v.toExponential(3);
  return Number(v.toPrecision(5)).toString();
}

async function doDist() {
  const names = Array.from(distCols);
  if (!names.length) { alert('请先添加要分析的列名'); return; }
  const s = await engine.stats();
  if (!s.records) { alert('数据库还没有数据，请先执行预解析'); return; }
  const { start, end } = getTimeRange();
  const fileInc = splitNames($('fileInclude').value);
  const fileExc = splitNames($('fileExclude').value);
  if (fileInc.length || fileExc.length) {
    const nFiles = await engine.countFiles(fileInc, fileExc);
    if (nFiles === 0) { alert('文件名筛选没有命中任何已入库的文件，请检查关键词'); return; }
  }
  setStatus('正在计算分布…');
  const results = [], errors = [];
  for (const name of names) {
    const r = await engine.getDistribution(name, { start, end, fileInclude: fileInc, fileExclude: fileExc });
    if (r.found) results.push(r);
    else errors.push(r.reason || `列 ${name} 不存在`);
  }
  renderCharts(results);
  setStatus(errors.length ? '部分列未找到：' + errors.join('；') : `已绘制 ${results.length} 个列名的分布`);
}

function renderCharts(results) {
  for (const ch of charts) ch.dispose();
  charts = [];
  const grid = $('chartsGrid');
  grid.innerHTML = '';
  grid.className = 'charts-grid' + (results.length > 1 ? ' multi' : '');
  if (!results.length) {
    grid.innerHTML = '<div class="card muted">没有可绘制的列（请检查列名，或先执行预解析）</div>';
    return;
  }
  const kSigma = parseFloat($('sigmaInput').value) || 3;
  for (const r of results) {
    const card = document.createElement('div');
    card.className = 'chart-card';
    const box = document.createElement('div');
    box.className = 'chart-box';
    card.appendChild(box);
    grid.appendChild(card);
    const chart = echarts.init(box);
    chart.setOption(r.isNumeric ? buildNumericOption(r, kSigma) : buildTextOption(r));
    charts.push(chart);
  }
}

function buildNumericOption(r, kSigma) {
  const values = r.values;
  if (!values.length) {
    return {
      title: { text: `${r.name}\nPASS=0  NG=${r.ngCount}`, left: 'center', textStyle: { fontSize: 13 } },
      graphic: { type: 'text', left: 'center', top: 'middle', style: { text: '所选条件下无 PASS 数据', fontSize: 14, fill: '#999' } },
    };
  }
  const n = values.length;
  const mean = meanOf(values);
  const med = medianOf(values);
  const std = stdOf(values, mean);
  const q1 = percentileOf(values, 25), q3 = percentileOf(values, 75);
  const p95 = percentileOf(values, 95), p99 = percentileOf(values, 99);
  const iqr = q3 - q1;
  const cv = mean !== 0 ? std / mean * 100 : NaN;
  let skew = 0;
  if (n > 2 && std > 0) {
    let s3 = 0;
    for (const v of values) s3 += Math.pow(v - mean, 3);
    skew = n * s3 / Math.pow(std, 3) / (n - 1) / (n - 2);
  }
  let kurt = 0;
  if (n > 3 && std > 0) {
    let s4 = 0;
    for (const v of values) s4 += Math.pow(v - mean, 4);
    kurt = s4 / n / Math.pow(std, 4) - 3;
  }
  const lo = mean - kSigma * std, hi = mean + kSigma * std;
  let inK = 0;
  for (const v of values) if (v >= lo && v <= hi) inK++;
  const pctK = inK / n * 100;

  // 直方图分箱
  const min = Math.min.apply(null, values), max = Math.max.apply(null, values);
  const bins = Math.min(80, Math.max(10, Math.floor(Math.sqrt(n))));
  const width = (max - min) / bins || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - min) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx]++;
  }
  const cats = counts.map((_, i) => fmtG(min + i * width));

  return {
    title: {
      text: `${r.name}\nn=${n}(PASS)  NG=${r.ngCount}  均值=${fmtG(mean)}  中位=${fmtG(med)}  σ=${fmtG(std)}  min=${fmtG(min)}  max=${fmtG(max)}\n`
        + `${kSigma}σ区间=[${fmtG(lo)},${fmtG(hi)}] 内${inK}台(${pctK.toFixed(1)}%)  Q1=${fmtG(q1)} Q3=${fmtG(q3)} IQR=${fmtG(iqr)} P95=${fmtG(p95)} P99=${fmtG(p99)} CV=${fmtG(cv)}% 偏度=${fmtG(skew)} 峰度=${fmtG(kurt)}`,
      left: 'center', textStyle: { fontSize: 11, fontWeight: 400, lineHeight: 16 },
    },
    grid: { left: 60, right: 30, top: 78, bottom: 40 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: cats, axisLabel: { interval: Math.ceil(bins / 12), rotate: 30, fontSize: 10 } },
    yAxis: { type: 'value', name: '频数' },
    series: [{
      type: 'bar', data: counts, barCategoryGap: '5%',
      itemStyle: { color: '#4C8BF5', opacity: 0.8 },
      markLine: {
        symbol: 'none',
        label: { fontSize: 10, formatter: '{b}' },
        data: [
          { name: `均值 ${fmtG(mean)}`, xAxis: valueToCat(mean, min, width, bins), lineStyle: { color: 'red', type: 'dashed' } },
          { name: `中位 ${fmtG(med)}`, xAxis: valueToCat(med, min, width, bins), lineStyle: { color: 'orange', type: 'dashed' } },
          { name: `-${kSigma}σ ${fmtG(lo)}`, xAxis: valueToCat(lo, min, width, bins), lineStyle: { color: 'green', type: 'dotted' } },
          { name: `+${kSigma}σ ${fmtG(hi)}`, xAxis: valueToCat(hi, min, width, bins), lineStyle: { color: 'green', type: 'dotted' } },
        ],
      },
    }],
  };
}

function valueToCat(v, min, width, bins) {
  let idx = Math.floor((v - min) / width);
  if (idx < 0) idx = 0;
  if (idx >= bins) idx = bins - 1;
  return idx;
}

function buildTextOption(r) {
  const entries = Object.entries(r.counts).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 30);
  return {
    title: {
      text: `${r.name}\nn=${r.rawCount}(PASS)  NG=${r.ngCount}  共 ${entries.length} 种取值（显示前 ${top.length} 种）`,
      left: 'center', textStyle: { fontSize: 11, fontWeight: 400, lineHeight: 16 },
    },
    grid: { left: 60, right: 30, top: 64, bottom: 90 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: top.map(e => e[0]), axisLabel: { rotate: 40, fontSize: 10, interval: 0 } },
    yAxis: { type: 'value', name: '频次' },
    series: [{ type: 'bar', data: top.map(e => e[1]), itemStyle: { color: '#4C8BF5', opacity: 0.8 } }],
  };
}

// ---------- 列名设置 ----------
async function openMappingModal() {
  const selects = [$('mapSn'), $('mapPass'), $('mapTime')];
  for (const s of selects) s.innerHTML = '<option value="">（自动识别）</option>';
  let headers = [];
  let hint = '';
  if (pickedFiles.length) {
    setStatus('正在扫描所选目录的表头…');
    try {
      const r = await engine.scanHeaders(pickedFiles.slice(0, 20));
      headers = r.columns;
      hint = `已扫描 ${r.filesOk}/${r.filesTotal} 个文件的表头（最多取前 20 个文件）`;
      const g = r.guesses;
      if (g.sn || g.pass || g.time) {
        hint += `；自动识别：SN=${g.sn || '?'} 判定=${g.pass || '?'} 时间=${g.time || '?'}`;
      }
    } catch (e) {
      hint = '表头扫描失败：' + e.message;
    }
  } else {
    const cols = await engine.listColumns();
    headers = cols.map(c => c.name);
    hint = headers.length ? '（使用数据库中已知列名）' : '（未选择目录且数据库为空，无可用列名）';
  }
  for (const s of selects) {
    for (const h of headers) {
      const opt = document.createElement('option');
      opt.value = h; opt.textContent = h;
      s.appendChild(opt);
    }
  }
  const mapping = await engine.loadMapping();
  if (mapping.sn) $('mapSn').value = mapping.sn;
  if (mapping.pass) $('mapPass').value = mapping.pass;
  if (mapping.time) $('mapTime').value = mapping.time;
  $('mappingHint').textContent = hint;
  $('mappingModal').classList.add('show');
  setStatus('就绪');
}

async function saveMapping() {
  const mapping = {};
  if ($('mapSn').value) mapping.sn = $('mapSn').value;
  if ($('mapPass').value) mapping.pass = $('mapPass').value;
  if ($('mapTime').value) mapping.time = $('mapTime').value;
  await engine.saveMapping(mapping);
  $('mappingModal').classList.remove('show');
  setStatus('列名设置已保存，下次解析生效（如需重排已入库数据请执行全量预解析）');
}

// ---------- 初始化 ----------
async function init() {
  try {
    await engine.open();
  } catch (e) {
    setStatus('无法打开浏览器本地数据库（IndexedDB）：' + e.message);
    return;
  }

  // 恢复 UI 设置
  const t = loadUiSetting('time', null);
  if (t) {
    $('timeEnable').checked = !!t.enable;
    $('timeStart').value = t.start || '';
    $('timeEnd').value = t.end || '';
  }
  $('fileInclude').value = loadUiSetting('file_inc', '');
  $('fileExclude').value = loadUiSetting('file_exc', '');
  $('sigmaInput').value = loadUiSetting('sigma', 3);
  for (const c of loadUiSetting('dist_cols', [])) distCols.add(c);
  renderColList();

  // 事件绑定
  $('btnPickDir').onclick = () => $('dirInput').click();
  $('dirInput').onchange = (e) => {
    pickedFiles = Array.from(e.target.files).filter(f => /\.csv$/i.test(f.name));
    const dir = e.target.files.length ? (e.target.files[0].webkitRelativePath || '').split('/')[0] : '';
    $('dirLabel').textContent = pickedFiles.length
      ? `已选目录：${dir || '（所选文件）'}，共 ${pickedFiles.length} 个 CSV`
      : '未选择目录（所选目录中没有 CSV 文件）';
  };
  $('btnFullScan').onclick = () => runScan(true);
  $('btnIncrScan').onclick = () => runScan(false);
  $('btnCancel').onclick = () => { engine.cancel(); setStatus('正在取消…（当前文件处理完成后停止）'); };
  $('btnClearDb').onclick = async () => {
    if (!confirm('确认清空浏览器中已入库的全部数据？（需要重新预解析）')) return;
    await clearAllData(engine.db);
    await refreshStats();
    await refreshColCombo();
    await loadSnHistory();
    $('snTableWrap').innerHTML = '<span class="muted">查询结果将显示在这里</span>';
    $('chartsGrid').innerHTML = '';
    setStatus('数据库已清空');
  };

  $('btnResetTime').onclick = () => {
    $('timeEnable').checked = false;
    $('timeStart').value = '';
    $('timeEnd').value = '';
    saveTimeSetting();
  };
  function saveTimeSetting() {
    saveUiSetting('time', { enable: $('timeEnable').checked, start: $('timeStart').value, end: $('timeEnd').value });
  }
  $('timeEnable').onchange = saveTimeSetting;
  $('timeStart').onchange = saveTimeSetting;
  $('timeEnd').onchange = saveTimeSetting;

  // 顶层标签页（工位录入 / 数据分析）
  document.querySelectorAll('.tabs button[data-tab]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs button[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tabpage').forEach(p => p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab));
    };
  });

  // 数据分析子标签页（SN 号查询 / 动态分布）
  document.querySelectorAll('.tabs button[data-subtab]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tabs button[data-subtab]').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.subtabpage').forEach(p => p.classList.toggle('active', p.id === 'subtab-' + btn.dataset.subtab));
      if (btn.dataset.subtab === 'dist') setTimeout(() => charts.forEach(c => c.resize()), 50);
    };
  });

  // SN 查询
  $('btnSnQuery').onclick = doSnQuery;
  $('snInput').onkeydown = (e) => { if (e.key === 'Enter') doSnQuery(); };
  $('btnExport').onclick = exportSnCsv;

  // 分布
  $('btnAddColInput').onclick = () => { addCol($('colInput').value); $('colInput').value = ''; };
  $('colInput').onkeydown = (e) => { if (e.key === 'Enter') { addCol($('colInput').value); $('colInput').value = ''; } };
  $('btnAddColCombo').onclick = () => { if ($('colCombo').value) addCol($('colCombo').value); };
  $('btnClearCols').onclick = () => { distCols.clear(); renderColList(); saveCols(); };
  $('btnDist').onclick = doDist;
  $('fileInclude').onchange = () => saveUiSetting('file_inc', $('fileInclude').value);
  $('fileExclude').onchange = () => saveUiSetting('file_exc', $('fileExclude').value);
  $('sigmaInput').onchange = () => saveUiSetting('sigma', parseFloat($('sigmaInput').value) || 3);

  // 列名设置
  $('btnMapping').onclick = openMappingModal;
  $('btnMapClose').onclick = () => $('mappingModal').classList.remove('show');
  $('btnMapSave').onclick = saveMapping;

  window.addEventListener('resize', () => charts.forEach(c => c.resize()));

  await refreshStats();
  await refreshColCombo();
  await loadSnHistory();
  setStatus('就绪（数据库已加载，可直接查询；CSV 有更新时重新选择目录后点“增量解析”）');
}

document.addEventListener('DOMContentLoaded', init);

// 暴露给自动化测试
window.App = { engine, runScan, doSnQuery, doDist, get pickedFiles() { return pickedFiles; }, set pickedFiles(v) { pickedFiles = v; } };
