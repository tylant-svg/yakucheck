'use strict';

// ──────────────────────────────────────────────────────────────
//  State
// ──────────────────────────────────────────────────────────────
let medications = [];
let cameraStream = null;
let qrScanner   = null;
let claudeApiKey = '';


// ──────────────────────────────────────────────────────────────
//  Boot
// ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadApiKey();
  renderMedList();
  bindEvents();
  registerSW();
});

function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ──────────────────────────────────────────────────────────────
//  Event binding
// ──────────────────────────────────────────────────────────────
function bindEvents() {
  document.querySelectorAll('.tab').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );
  document.getElementById('med-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addFromInput();
  });
  document.getElementById('add-btn').addEventListener('click', addFromInput);
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('camera-btn').addEventListener('click', openCamera);
  document.getElementById('barcode-btn').addEventListener('click', openScanner);
  document.getElementById('analyze-btn').addEventListener('click', runAnalysis);
  document.getElementById('shutter-btn').addEventListener('click', capturePhoto);
  document.getElementById('close-camera-btn').addEventListener('click', closeCamera);
  document.getElementById('close-scanner-btn').addEventListener('click', closeScanner);
  document.getElementById('ocr-close-btn').addEventListener('click', closeOCRDialog);
  document.getElementById('ocr-confirm-btn').addEventListener('click', confirmOCRDrugs);
  document.getElementById('save-api-btn').addEventListener('click', () =>
    saveApiKey(document.getElementById('api-key-input').value)
  );
}

// ──────────────────────────────────────────────────────────────
//  Tabs
// ──────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
  document.querySelectorAll('.section').forEach(s =>
    s.classList.toggle('active', s.id === `section-${name}`)
  );
  document.querySelector('.analyze-bar').style.display = name === 'input' ? '' : 'none';
}

// ──────────────────────────────────────────────────────────────
//  Medication list
// ──────────────────────────────────────────────────────────────
function addFromInput() {
  const el = document.getElementById('med-input');
  const name = el.value.trim();
  if (!name) return;
  addMed(name);
  el.value = '';
  el.focus();
}

function addMed(name) {
  name = name.substring(0, 120);
  if (!name) return;
  if (medications.some(m => m.toLowerCase() === name.toLowerCase())) {
    toast('既に追加されています');
    return;
  }
  medications.push(name);
  renderMedList();
  updateAnalyzeBtn();
}

function removeMed(idx) {
  medications.splice(idx, 1);
  renderMedList();
  updateAnalyzeBtn();
}

function clearAll() {
  if (medications.length === 0) return;
  if (!confirm(`登録された${medications.length}種類の薬を全て削除しますか？`)) return;
  medications = [];
  renderMedList();
  updateAnalyzeBtn();
}

function renderMedList() {
  const wrap  = document.getElementById('med-list-wrap');
  const badge = document.getElementById('med-count');
  badge.textContent = medications.length;

  if (medications.length === 0) {
    wrap.innerHTML = `<div class="empty-state"><div class="e-icon">💊</div><p>薬を追加してください</p></div>`;
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'med-list';
  medications.forEach((name, i) => {
    const li = document.createElement('li');
    li.className = 'med-item';
    li.innerHTML = `<span class="med-name">💊 ${esc(name)}</span><button class="btn-remove" aria-label="削除">✕</button>`;
    li.querySelector('.btn-remove').addEventListener('click', () => removeMed(i));
    ul.appendChild(li);
  });
  wrap.innerHTML = '';
  wrap.appendChild(ul);
}

function updateAnalyzeBtn() {
  const btn = document.getElementById('analyze-btn');
  btn.disabled = medications.length === 0;
  btn.textContent = medications.length > 0
    ? `🔍 ${medications.length}種類の薬を解析する`
    : '薬を追加してください';
}

// ──────────────────────────────────────────────────────────────
//  Camera
// ──────────────────────────────────────────────────────────────
async function openCamera() {
  document.getElementById('camera-modal').style.display = 'flex';
  document.getElementById('cam-canvas').style.display = 'none';
  document.getElementById('cam-video').style.display = 'block';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } }
    });
    document.getElementById('cam-video').srcObject = cameraStream;
  } catch {
    toast('カメラにアクセスできません');
    closeCamera();
  }
}

function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  document.getElementById('camera-modal').style.display = 'none';
}

async function capturePhoto() {
  const video  = document.getElementById('cam-video');
  const canvas = document.getElementById('cam-canvas');
  const ctx    = canvas.getContext('2d');
  const MAX = 1200;
  let w = video.videoWidth, h = video.videoHeight;
  if (Math.max(w, h) > MAX) { const r = MAX / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r); }
  canvas.width = w; canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  canvas.style.display = 'block';
  video.style.display  = 'none';
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  closeCamera();
  await runOCR(canvas);
}

// ──────────────────────────────────────────────────────────────
//  Tesseract.js OCR
// ──────────────────────────────────────────────────────────────
async function runOCR(imageSource) {
  switchTab('results');
  showProgress('OCR処理中…（初回は言語データのダウンロードに約30秒かかります）', 0);

  try {
    if (typeof Tesseract === 'undefined') {
      showProgress('Tesseract.js を読み込み中…', 5);
      await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
    }
    const { data: { text: rawText } } = await Tesseract.recognize(imageSource, 'jpn', {
      logger: m => {
        const pct = Math.round((m.progress || 0) * 100);
        if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract') {
          showProgress('Tesseract を初期化中…', 5);
        } else if (m.status === 'loading language traineddata') {
          showProgress(`日本語データを読み込み中… ${pct}%（初回は約30MB）`, Math.round(pct * 0.6));
        } else if (m.status === 'downloading') {
          showProgress(`日本語データをダウンロード中… ${pct}%（初回のみ）`, Math.round(pct * 0.6));
        } else if (m.status === 'initializing api') {
          showProgress('OCR エンジンを準備中…', 65);
        } else if (m.status === 'recognizing text') {
          showProgress(`テキストを認識中… ${pct}%`, 65 + Math.round(pct * 0.35));
        }
      }
    });
    // 半角カタカナを全角に正規化してからすべての処理に使用
    const text = normalizeOcrText(rawText);
    showProgress('ローカルDBと照合中…', 96);
    const dbMatched = matchDrugsInText(text);

    let aiDrugs = null;
    if (claudeApiKey) {
      showProgress('🤖 Claude AIで薬名を識別中…', 98);
      aiDrugs = await identifyDrugsWithClaude(text);
    }
    const candidates = extractDrugCandidates(text);
    showOCRDialog(text, candidates, aiDrugs, dbMatched);
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed')) {
      showError('日本語データのダウンロードに失敗しました。インターネット接続を確認して再試行してください。\n\nエラー: ' + msg);
    } else {
      showError('OCRに失敗しました: ' + msg);
    }
  }
}

// ──────────────────────────────────────────────────────────────
//  半角カタカナ → 全角カタカナ 正規化
// ──────────────────────────────────────────────────────────────
function normalizeOcrText(text) {
  // 濁点・半濁点の2文字結合を先に処理（ｶﾞ→ガ 等）
  const dakuten = [
    ['ｶﾞ','ガ'],['ｷﾞ','ギ'],['ｸﾞ','グ'],['ｹﾞ','ゲ'],['ｺﾞ','ゴ'],
    ['ｻﾞ','ザ'],['ｼﾞ','ジ'],['ｽﾞ','ズ'],['ｾﾞ','ゼ'],['ｿﾞ','ゾ'],
    ['ﾀﾞ','ダ'],['ﾁﾞ','ヂ'],['ﾂﾞ','ヅ'],['ﾃﾞ','デ'],['ﾄﾞ','ド'],
    ['ﾊﾞ','バ'],['ﾋﾞ','ビ'],['ﾌﾞ','ブ'],['ﾍﾞ','ベ'],['ﾎﾞ','ボ'],['ｳﾞ','ヴ'],
    ['ﾊﾟ','パ'],['ﾋﾟ','ピ'],['ﾌﾟ','プ'],['ﾍﾟ','ペ'],['ﾎﾟ','ポ'],
  ];
  let s = text;
  for (const [h, z] of dakuten) s = s.split(h).join(z);

  // 残りの単体半角カタカナ → 全角カタカナ
  const map = {
    'ｦ':'ヲ','ｧ':'ァ','ｨ':'ィ','ｩ':'ゥ','ｪ':'ェ','ｫ':'ォ',
    'ｬ':'ャ','ｭ':'ュ','ｮ':'ョ','ｯ':'ッ','ｰ':'ー',
    'ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ',
    'ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ',
    'ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ',
    'ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト',
    'ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ',
    'ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ',
    'ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ',
    'ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ',
    'ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ',
    'ﾜ':'ワ','ﾝ':'ン','ﾞ':'゛','ﾟ':'゜',
  };
  s = s.split('').map(c => map[c] ?? c).join('');

  // OCRで日本語文字間にスペースが挿入される問題を修正（「ア ム ロ」→「アムロ」）
  let prev;
  do {
    prev = s;
    s = s.replace(/([ぁ-ヿ一-龥])[ \t]+([ぁ-ヿ一-龥])/g, '$1$2');
  } while (s !== prev);

  return s;
}

function extractDrugCandidates(text) {
  const katakana = /[゠-ヿ]{3,}/g;
  const found = new Set(text.match(katakana) || []);
  const common = ['アドレナリン','ノルアドレナリン','ドパミン','セロトニン','コレステロール',
    'タンパク','カルシウム','ナトリウム','カリウム','マグネシウム'];
  return [...found].filter(c => c.length >= 3 && !common.includes(c)).slice(0, 30);
}

function matchDrugsInText(text) {
  const results = [];
  const normText = normalizeName(text);
  const textNoSp = text.replace(/\s/g, '');      // 全スペース除去（OCR文字間スペース対策）
  const normNoSp = normalizeName(textNoSp);
  const seen = new Set();

  for (const entry of DRUGDB) {
    for (const kw of entry.keywords) {
      if (kw.length < 3) continue;
      const kwNorm = normalizeName(kw);
      const dedup  = entry.keywords[0];

      // ① 元テキストで直接マッチ → 剤形・容量ごと抽出
      const idx = text.indexOf(kw);
      if (idx !== -1) {
        const token = text.slice(idx).match(/^\S+/)?.[0] ?? kw;
        if (!seen.has(dedup)) { seen.add(dedup); results.push(token); }
        break;
      }

      // ② 正規化マッチ
      if (kwNorm.length >= 3 && normText.includes(kwNorm)) {
        if (!seen.has(dedup)) { seen.add(dedup); results.push(kw); }
        break;
      }

      // ③ スペース除去正規化マッチ（文字間スペースが残っている場合の追加対策）
      if (kwNorm.length >= 3 && normNoSp.includes(kwNorm)) {
        if (!seen.has(dedup)) { seen.add(dedup); results.push(kw); }
        break;
      }
    }
  }

  // ④ 部分一致：OCRテキストの4文字以上カタカナトークンがDBキーワードに含まれているか確認
  //    （「アムロジ」→「アムロジピン」のような途中切れにも対応）
  const tokens = [...new Set((textNoSp.match(/[ァ-ヿ]{4,}/g) || []))];
  for (const entry of DRUGDB) {
    const dedup = entry.keywords[0];
    if (seen.has(dedup)) continue;
    outer: for (const kw of entry.keywords) {
      if (kw.length < 4) continue;
      const kwNorm = normalizeName(kw);
      if (kwNorm.length < 4) continue;
      for (const token of tokens) {
        if (kwNorm.includes(token)) {
          seen.add(dedup);
          results.push(kw);
          break outer;
        }
      }
    }
  }

  return results;
}

function showProgress(msg, pct) {
  document.getElementById('results-content').innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p>${esc(msg)}</p>
      <div class="progress-bar-wrap">
        <div class="progress-bar" style="width:${pct}%"></div>
      </div>
    </div>`;
}

function showOCRDialog(rawText, candidates, aiDrugs = null, dbMatched = []) {
  let html = '';
  const shownSet = new Set();

  // ① ローカルDB確認済み（緑・自動選択）
  if (dbMatched.length > 0) {
    html += '<div class="ocr-label" style="margin-bottom:6px">✅ ローカルDB確認済み（自動選択）</div><div class="ocr-chips">';
    html += dbMatched.map(c => {
      shownSet.add(c.toLowerCase());
      return `<button class="ocr-chip ocr-chip-db selected" data-name="${esc(c)}">${esc(c)}</button>`;
    }).join('');
    html += '</div>';
  }

  // ② Claude AI識別（青・自動選択）※APIキーがある場合のみ
  const aiNew = (aiDrugs || []).filter(c => !shownSet.has(c.toLowerCase()));
  if (aiNew.length > 0) {
    html += '<div class="ocr-label" style="margin-top:12px;margin-bottom:6px">🤖 Claude AIが識別した薬名（自動選択）</div><div class="ocr-chips">';
    html += aiNew.map(c => {
      shownSet.add(c.toLowerCase());
      return `<button class="ocr-chip ocr-chip-ai selected" data-name="${esc(c)}">${esc(c)}</button>`;
    }).join('');
    html += '</div>';
  } else if (aiDrugs !== null && aiDrugs.length === 0) {
    html += '<div style="font-size:12px;color:var(--text-sub);margin-top:8px;margin-bottom:4px">🤖 Claude AI：追加の薬名は見つかりませんでした</div>';
  }

  // ③ その他のカタカナ候補（未選択）
  const remaining = candidates.filter(c => !shownSet.has(c.toLowerCase()));
  if (remaining.length > 0) {
    const hasAny = dbMatched.length > 0 || aiNew.length > 0;
    html += `<div class="ocr-label" style="margin-top:${hasAny ? '12px' : '0'};margin-bottom:6px">${hasAny ? 'その他の候補' : '薬名の候補（タップして選択）'}</div><div class="ocr-chips">`;
    html += remaining.map(c =>
      `<button class="ocr-chip" data-name="${esc(c)}">${esc(c)}</button>`
    ).join('');
    html += '</div>';
  }

  if (!html) {
    html = '<span style="color:var(--text-sub);font-size:13px">候補が見つかりませんでした。下のテキストから薬名を確認してください。</span>';
  }

  document.getElementById('ocr-raw-text').value = rawText;
  document.getElementById('ocr-candidates').innerHTML = html;
  document.getElementById('ocr-selected-list').innerHTML = '';
  document.getElementById('ocr-modal').style.display = 'flex';

  document.querySelectorAll('.ocr-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('selected');
      updateOCRSelectedList();
    });
  });

  updateOCRSelectedList();
}

function updateOCRSelectedList() {
  const selected = [...document.querySelectorAll('.ocr-chip.selected')].map(b => b.dataset.name);
  const wrap = document.getElementById('ocr-selected-list');
  wrap.innerHTML = selected.length
    ? `<div style="margin-top:8px;font-size:12px;color:var(--text-sub)">選択中: ${selected.map(s => `<strong>${esc(s)}</strong>`).join('、')}</div>`
    : '';
}

function confirmOCRDrugs() {
  const selected = [...document.querySelectorAll('.ocr-chip.selected')].map(b => b.dataset.name);
  const manual   = document.getElementById('ocr-manual-input').value.trim();
  selected.forEach(name => addMed(name));
  if (manual) addMed(manual);
  closeOCRDialog();
  if (medications.length > 0) {
    toast(`${selected.length + (manual ? 1 : 0)}種類の薬を追加しました`);
    switchTab('input');
  }
}

function closeOCRDialog() {
  document.getElementById('ocr-modal').style.display = 'none';
  document.getElementById('ocr-manual-input').value = '';
}

// ──────────────────────────────────────────────────────────────
//  QR / Barcode scanner
// ──────────────────────────────────────────────────────────────
async function openScanner() {
  document.getElementById('scanner-modal').style.display = 'flex';
  try {
    if (typeof Html5Qrcode === 'undefined') {
      await loadScript('https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js');
    }
    qrScanner = new Html5Qrcode('qr-reader');
    await qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      onScanSuccess, () => {}
    );
  } catch (err) {
    toast('スキャナーを起動できません: ' + err.message);
    closeScanner();
  }
}

async function closeScanner() {
  if (qrScanner) { try { await qrScanner.stop(); } catch { /* ignored */ } qrScanner = null; }
  document.getElementById('scanner-modal').style.display = 'none';
}

function onScanSuccess(text) {
  closeScanner();
  if (text.startsWith('JAHIS') || /RP\d/i.test(text)) {
    const names = parseJAHIS(text);
    if (names.length) { names.forEach(n => addMed(n)); toast(`${names.length}種類の薬を追加しました`); return; }
  }
  if (confirm(`スキャン結果:\n${text.substring(0, 200)}\n\nこれを薬名として追加しますか？`)) addMed(text.substring(0, 120));
}

function parseJAHIS(text) {
  const names = [];
  text.split(/\r?\n/).forEach(line => {
    if (/^RP\d/i.test(line)) { const p = line.split(';'); if (p[2]) names.push(p[2].trim()); }
  });
  return names;
}

// ──────────────────────────────────────────────────────────────
//  Claude API — AI薬名識別
// ──────────────────────────────────────────────────────────────
function loadApiKey() {
  claudeApiKey = localStorage.getItem('claude_api_key') || '';
  updateApiStatus();
}

function saveApiKey(key) {
  claudeApiKey = key.trim();
  if (claudeApiKey) {
    localStorage.setItem('claude_api_key', claudeApiKey);
    toast('✅ APIキーを保存しました');
  } else {
    localStorage.removeItem('claude_api_key');
    toast('APIキーを削除しました');
  }
  updateApiStatus();
}

function updateApiStatus() {
  const dot   = document.getElementById('api-dot');
  const label = document.getElementById('api-label');
  const input = document.getElementById('api-key-input');
  if (claudeApiKey) {
    dot.style.background = 'var(--green)';
    label.textContent = 'Claude AI 有効';
    if (input) input.value = claudeApiKey;
  } else {
    dot.style.background = '#ccc';
    label.textContent = 'AIキー未設定';
  }
}

async function identifyDrugsWithClaude(text) {
  if (!claudeApiKey) return null;
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 15000);
    const res  = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': claudeApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-allow-browser': 'true'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `以下はお薬手帳のOCRテキストです。薬品名（医薬品名）だけを抽出し、JSON配列で返してください。病院名・日付・住所・用法・数量・一般語は含めないでください。薬品名が見つからない場合は [] を返してください。\n\nテキスト:\n${text.substring(0, 2000)}\n\n返答（JSONのみ）: ["薬品名1","薬品名2"]`
        }]
      })
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data  = await res.json();
    const raw   = data.content?.[0]?.text || '';
    const match = raw.match(/\[[\s\S]*?\]/);
    if (!match) return null;
    const names = JSON.parse(match[0]);
    return Array.isArray(names) ? names.filter(n => typeof n === 'string' && n.trim()) : null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
//  Main analysis — Local DB
// ──────────────────────────────────────────────────────────────
async function runAnalysis() {
  if (medications.length === 0) { toast('薬を追加してください'); return; }
  switchTab('results');

  const results = [];
  const total   = medications.length;

  for (let i = 0; i < total; i++) {
    const name = medications[i];
    showProgress(`${esc(name)} を確認中… (${i + 1}/${total})`, Math.round((i / total) * 90));

    const res = await lookupDrug(name);
    results.push({ inputName: name, ...res });
  }

  showProgress('結果をまとめています…', 95);
  renderResults(results);
}

async function lookupDrug(name) {
  const local = searchLocalDB(name);
  if (local.drug) {
    return {
      source:   'local',
      category: local.drug.category,
      purpose:  local.drug.purpose,
      diseases: local.drug.diseases,
      emergency:local.drug.emergency,
    };
  }
  return { source: 'unknown', category: null, purpose: null, diseases: [], emergency: null };
}

// ──────────────────────────────────────────────────────────────
//  Render results
// ──────────────────────────────────────────────────────────────
function renderResults(results) {
  // Collect all diseases and emergency notes
  const allDiseases = [];
  const emergencies = [];
  let foundCount = 0;

  for (const r of results) {
    if (r.source !== 'unknown') foundCount++;
    (r.diseases || []).forEach(d => { if (!allDiseases.includes(d)) allDiseases.push(d); });
    if (r.emergency) emergencies.push({ drug: r.inputName, note: r.emergency });
  }

  let h = '';

  // ── Found/not-found banner
  const unknownCount = results.length - foundCount;
  h += `<div class="summary-box" style="border-left-color:var(--green)">
    ${results.length}種類の薬を確認しました。
    <strong>${foundCount}種類</strong>が薬剤データベースで見つかりました。
    ${unknownCount > 0 ? `<span style="color:var(--red)">${unknownCount}種類は不明です（医療機関または薬剤師に確認してください）。</span>` : ''}
  </div>`;

  // ── Emergency alerts
  if (emergencies.length > 0) {
    const items = emergencies.map(e => `<li><strong>${esc(e.drug)}：</strong>${esc(e.note)}</li>`).join('');
    h += `<div class="alert alert-red">
      <span class="alert-icon">🚨</span>
      <div class="alert-body"><strong>救急対応 — 注意事項</strong><ul>${items}</ul></div>
    </div>`;
  }

  // ── Inferred conditions
  if (allDiseases.length > 0) {
    const tags = allDiseases.map(d => `<span class="tag tag-blue">${esc(d)}</span>`).join('');
    h += `<div class="result-section-title">🏥 推定される既往歴・疾患</div>
          <div style="margin-bottom:14px">${tags}</div>`;
  }

  // ── Per-drug
  h += `<div class="result-section-title">💊 薬剤詳細 (${results.length}種類)</div>`;
  for (const r of results) {
    const hasCrit = !!r.emergency;
    const isUnknown = r.source === 'unknown';
    const sourceLabel = isUnknown ? '● 未登録' : '● ローカルDB';
    const sourceColor = isUnknown ? '#999' : 'var(--green)';
    const pmdaUrl = `https://www.pmda.go.jp/PmdaSearch/iyakuSearch/#k=${encodeURIComponent(r.inputName)}&tab=0`;
    h += `<div class="drug-item ${hasCrit ? 'has-alert' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
        <div class="drug-name">${esc(r.inputName)}</div>
        <span style="font-size:10px;color:${sourceColor};white-space:nowrap">${sourceLabel}</span>
      </div>
      <div class="drug-category">${esc(r.category || (isUnknown ? 'DBに未登録' : '分類不明'))}</div>
      <div class="drug-detail">
        ${isUnknown
          ? `<span style="color:var(--text-sub);font-size:13px">ローカルDBに未登録の薬剤です。</span><br>
             <a href="${pmdaUrl}" target="_blank" rel="noopener"
                style="font-size:12px;color:var(--primary);text-decoration:none">
               🔎 PMDAで「${esc(r.inputName)}」を検索 →
             </a>`
          : `<strong>目　的</strong><br>${esc(r.purpose || '情報なし')}<br>
             ${r.diseases?.length ? `<strong style="margin-top:6px;display:block">対象疾患</strong>${r.diseases.map(d => `<span class="tag tag-blue" style="margin-top:4px">${esc(d)}</span>`).join('')}` : ''}
             ${hasCrit ? `<div class="drug-alert-note">⚠️ ${esc(r.emergency)}</div>` : ''}`
        }
      </div>
    </div>`;
  }

  // ── Data source note
  h += `<div class="alert alert-blue" style="margin-top:12px">
    <span class="alert-icon">ℹ️</span>
    <div class="alert-body">
      <strong>データソース</strong>
      <p>ローカル薬剤DB（国内主要処方薬 約500種・オフライン対応）。未登録薬は <a href="https://www.pmda.go.jp/PmdaSearch/iyakuSearch/" target="_blank" rel="noopener" style="color:inherit">PMDA 医薬品検索</a> で確認できます。</p>
    </div>
  </div>`;

  h += `<hr><p class="disclaimer">本情報はAIや医薬品データベースによる参考情報です。医療診断・治療判断の代替にはなりません。正確な情報は最新の添付文書・医師の判断に従ってください。</p>`;

  document.getElementById('results-content').innerHTML = h;
}

function showError(msg) {
  document.getElementById('results-content').innerHTML = `
    <div class="alert alert-red">
      <span class="alert-icon">⚠️</span>
      <div class="alert-body"><strong>エラーが発生しました</strong><p>${esc(msg)}</p></div>
    </div>`;
}

// ──────────────────────────────────────────────────────────────
//  Utilities
// ──────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error(`スクリプトの読み込みに失敗: ${src}`));
    document.head.appendChild(s);
  });
}
