const AIS = ['gemini', 'groq', 'deepseek', 'openai', 'claude'];

/* ══════════════════════════════════════════════════
   i18n — aplica traduções ao DOM
══════════════════════════════════════════════════ */
let currentUiLang = 'en-US';

function applyTranslations(uiLang) {
  currentUiLang = uiLang;
  const t = getT(uiLang);

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (typeof t[key] === 'string') el.textContent = t[key];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (typeof t[key] === 'string') el.placeholder = t[key];
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    if (typeof t[key] === 'string') el.title = t[key];
  });

  const flagEl  = document.getElementById('uiLangFlag');
  const labelEl = document.getElementById('uiLangLabel');
  if (flagEl && labelEl) { flagEl.textContent = t.flag; labelEl.textContent = t.label; }

  document.querySelectorAll('.ui-lang-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.uiLang === uiLang);
  });
}

function updateSilentBanner(active) {
  const banner = document.getElementById('silentBanner');
  if (banner) banner.classList.toggle('show', active);
}

/* ── Toast ── */
function showSaved(msg) {
  const el = document.getElementById('savedMsg');
  el.textContent = msg || getT(currentUiLang).savedOk;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

/* ── Navegação ── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ── Storage ── */
function load(keys, cb) { chrome.storage.sync.get(keys, cb); }
function save(obj, cb)  { chrome.storage.sync.set(obj, cb || (() => {})); }

/* ── Dicionário ── */
function loadDict(cb) { load({ ignoredWords: [] }, d => cb(d.ignoredWords)); }
function saveDict(words, cb) { save({ ignoredWords: words }, cb); }

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updateDictCounters(words) {
  const t = getT(currentUiLang);
  const n = words.length;
  document.getElementById('dictCount').textContent      = t.words(n);
  document.getElementById('dictHeaderCount').textContent = n;
}

function renderDictList(words) {
  const t = getT(currentUiLang);
  updateDictCounters(words);
  const list = document.getElementById('dictList');
  if (!words.length) {
    list.innerHTML = `<div class="dict-empty"><span class="dict-empty-icon">📭</span>${t.dictEmpty}</div>`;
    return;
  }
  list.innerHTML = '';
  [...words].sort((a, b) => a.localeCompare(b, 'pt')).forEach(word => {
    const row = document.createElement('div');
    row.className = 'dict-word-row';
    row.innerHTML = `<span class="dict-word-text">${escapeHtml(word)}</span>
      <button class="dict-word-remove" data-word="${escapeHtml(word)}">×</button>`;
    list.appendChild(row);
  });
}

function doAddWord() {
  const input = document.getElementById('dictInput');
  const word  = input.value.trim();
  if (!word) { input.focus(); return; }
  loadDict(words => {
    if (words.some(w => w.toLowerCase() === word.toLowerCase())) { showSaved('⚠ Já existe!'); return; }
    const updated = [...words, word];
    saveDict(updated, () => { renderDictList(updated); input.value = ''; input.focus(); showSaved(`✓ "${word}"`); });
  });
}

/* ── IA ── */
function getAISettings(cb) { load({ aiSettings: {} }, d => cb(d.aiSettings || {})); }
function saveAISettings(settings, cb) { save({ aiSettings: settings }, cb); }

const AI_CONFIG = {
  gemini: { test: async (key) => {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: 'ok' }] }] }) });
    if (!r.ok) { const e = await r.json(); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  }},
  deepseek: { test: async (key) => {
    const r = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'ok' }], max_tokens: 5 }) });
    if (!r.ok) { const e = await r.json(); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  }},
  openai: { test: async (key) => {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'ok' }], max_tokens: 5 }) });
    if (!r.ok) { const e = await r.json(); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  }},
  claude: { test: async (key) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }) });
    if (!r.ok) { const e = await r.json(); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  }},
  groq: { test: async (key) => {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'ok' }], max_tokens: 5 }) });
    if (!r.ok) { const e = await r.json(); throw new Error(e?.error?.message || `HTTP ${r.status}`); }
  }}
};

function setFeedback(ai, type, msg) {
  const fb = document.getElementById(`fb-${ai}`);
  fb.className = `ai-feedback ${type}`;
  fb.textContent = msg;
}

function updateAICard(ai, settings) {
  const cfg = settings[ai] || {};
  const dot = document.getElementById(`dot-${ai}`);
  const toggle = document.getElementById(`toggle-${ai}`);
  const card = document.getElementById(`card-${ai}`);
  const keyInput = document.getElementById(`key-${ai}`);
  const isVerified = !!cfg.verified;
  dot.className = 'ai-status-dot' + (isVerified ? ' ok' : cfg.key ? ' err' : '');
  toggle.checked  = !!cfg.enabled && isVerified;
  toggle.disabled = !isVerified;
  card.classList.toggle('configured', isVerified);
  card.classList.toggle('active-ai', !!cfg.enabled && isVerified);
  if (cfg.key) keyInput.value = cfg.key;
}

function updateAIBadge(settings) {
  const t      = getT(currentUiLang);
  const active = AIS.filter(ai => settings[ai]?.enabled && settings[ai]?.verified).length;
  const badge  = document.getElementById('aiActiveBadge');
  const label  = document.getElementById('aiInactiveLabel');
  if (active > 0) {
    badge.textContent = t.active(active); badge.style.display = '';
    label.style.display = 'none';
  } else {
    badge.style.display = 'none';
    label.textContent = t.noneActive; label.style.display = '';
  }
}

/* ══ Dropdown idioma da interface ══ */
const uiLangCurrent  = document.getElementById('uiLangCurrent');
const uiLangDropdown = document.getElementById('uiLangDropdown');

uiLangCurrent.addEventListener('click', e => {
  e.stopPropagation();
  const isOpen = uiLangDropdown.classList.contains('open');
  uiLangCurrent.classList.toggle('open', !isOpen);
  uiLangDropdown.classList.toggle('open', !isOpen);
});

document.addEventListener('click', () => {
  uiLangCurrent.classList.remove('open');
  uiLangDropdown.classList.remove('open');
});

uiLangDropdown.addEventListener('click', e => {
  const btn = e.target.closest('.ui-lang-opt');
  if (!btn) return;
  const lang = btn.dataset.uiLang;
  uiLangCurrent.classList.remove('open');
  uiLangDropdown.classList.remove('open');
  save({ uiLang: lang }, () => {
    applyTranslations(lang);
    loadDict(words => updateDictCounters(words));
    chrome.storage.local.get({ aiHistory: [] }, h => {
      document.getElementById('histCount').textContent = getT(lang).items(h.aiHistory.length);
    });
    getAISettings(s => updateAIBadge(s));
    showSaved(getT(lang).uiLangSaved);
  });
});

/* ══ Init ══ */
load({ language: 'pt-BR', picky: true, ignoredWords: [], aiSettings: {}, silentMode: false, theme: 'dark', uiLang: 'en-US' }, s => {
  const uiLang = s.uiLang || 'en-US';
  applyTranslations(uiLang);
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === s.language));
  document.getElementById('pickyToggle').checked  = s.picky;
  document.getElementById('silentToggle').checked = !!s.silentMode;
  document.getElementById('themeToggle').checked  = s.theme === 'light';
  updateSilentBanner(!!s.silentMode);
  updateDictCounters(s.ignoredWords || []);
  chrome.storage.local.get({ aiHistory: [] }, h => {
    document.getElementById('histCount').textContent = getT(uiLang).items(h.aiHistory.length);
  });
  const aiCfg = s.aiSettings || {};
  AIS.forEach(ai => updateAICard(ai, aiCfg));
  updateAIBadge(aiCfg);
});

/* ── Idioma de verificação ── */
document.getElementById('langGrid').addEventListener('click', e => {
  const btn = e.target.closest('.lang-btn');
  if (!btn) return;
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  save({ language: btn.dataset.lang }, () => showSaved(getT(currentUiLang).langSaved));
});

document.getElementById('pickyToggle').addEventListener('change', e => {
  save({ picky: e.target.checked }, () => showSaved(getT(currentUiLang).savedOk));
});

document.getElementById('silentToggle').addEventListener('change', e => {
  const active = e.target.checked;
  const t = getT(currentUiLang);
  save({ silentMode: active }, () => { updateSilentBanner(active); showSaved(active ? t.silentOn : t.silentOff); });
});

document.getElementById('themeToggle').addEventListener('change', e => {
  const theme = e.target.checked ? 'light' : 'dark';
  const t = getT(currentUiLang);
  save({ theme }, () => showSaved(theme === 'light' ? t.themeLight : t.themeDark));
});

/* ── Navegação ── */
document.getElementById('openDictBtn').addEventListener('click', () => {
  loadDict(words => { renderDictList(words); showScreen('screenDict'); });
});
document.getElementById('backFromDict').addEventListener('click', () => {
  loadDict(words => { updateDictCounters(words); showScreen('screenMain'); });
});
document.getElementById('openAIBtn').addEventListener('click',  () => showScreen('screenAI'));
document.getElementById('backFromAI').addEventListener('click', () => {
  getAISettings(s => { updateAIBadge(s); showScreen('screenMain'); });
});

/* ── Histórico ── */
function renderHistPopup(history) {
  const t    = getT(currentUiLang);
  const list = document.getElementById('histListPopup');
  document.getElementById('histCount').textContent = t.items(history.length);
  if (!history.length) {
    list.innerHTML = `<div class="hist-empty-popup"><span class="hist-empty-icon">🕐</span>${t.histEmpty}</div>`;
    return;
  }
  list.innerHTML = '';
  history.forEach((h, i) => {
    const date = new Date(h.date).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    const item = document.createElement('div');
    item.className = 'hist-item-popup';
    item.innerHTML = `
      <div class="hist-item-meta"><span class="hist-item-ai">${h.aiName}</span><span class="hist-item-date">${date}</span></div>
      <div class="hist-item-original">${escapeHtml((h.original||'').substring(0,80))}${(h.original||'').length>80?'…':''}</div>
      <div class="hist-item-result">${escapeHtml(h.result.substring(0,120))}${h.result.length>120?'…':''}</div>
      <div class="hist-item-actions"><button class="hist-copy-btn" data-index="${i}">⎘ Copiar resultado</button></div>`;
    list.appendChild(item);
  });
  list.querySelectorAll('.hist-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(history[btn.dataset.index].result).catch(()=>{});
      showSaved('✓ Copiado!');
    });
  });
}

document.getElementById('openHistBtn').addEventListener('click', () => {
  chrome.storage.local.get({ aiHistory: [] }, data => { renderHistPopup(data.aiHistory); showScreen('screenHist'); });
});
document.getElementById('backFromHist').addEventListener('click', () => {
  chrome.storage.local.get({ aiHistory: [] }, data => {
    document.getElementById('histCount').textContent = getT(currentUiLang).items(data.aiHistory.length);
    showScreen('screenMain');
  });
});
document.getElementById('clearHistBtn').addEventListener('click', () => {
  chrome.storage.local.set({ aiHistory: [] }, () => { renderHistPopup([]); showSaved('✓ OK!'); });
});

/* ── Dicionário ── */
document.getElementById('dictAddBtn').addEventListener('click', doAddWord);
document.getElementById('dictInput').addEventListener('keydown', e => { if (e.key === 'Enter') doAddWord(); });

document.getElementById('exportDictBtn').addEventListener('click', () => {
  loadDict(words => {
    const blob = new Blob([JSON.stringify({ version: '11.0', words, exported: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'corretor-dicionario.json';
    a.click(); showSaved('✓ Exportado!');
  });
});

document.getElementById('importDictBtn').addEventListener('click', () => document.getElementById('importDictFile').click());
document.getElementById('importDictFile').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      let words = [];
      const text = ev.target.result;
      if (file.name.endsWith('.json')) { const p = JSON.parse(text); words = Array.isArray(p) ? p : (p.words || []); }
      else words = text.split('\n').map(w => w.trim()).filter(Boolean);
      loadDict(existing => { const merged = [...new Set([...existing, ...words])]; saveDict(merged, () => { renderDictList(merged); showSaved(`✓ ${words.length}`); }); });
    } catch { showSaved('⚠ Erro'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('dictList').addEventListener('click', e => {
  const btn = e.target.closest('.dict-word-remove');
  if (!btn) return;
  const word = btn.dataset.word;
  loadDict(words => { const u = words.filter(w => w !== word); saveDict(u, () => { renderDictList(u); showSaved(`✓ "${word}" removido!`); }); });
});

/* ── Integrações ── */
document.querySelectorAll('.ai-card-header').forEach(header => {
  header.addEventListener('click', () => {
    const panel  = document.getElementById(`panel-${header.dataset.ai}`);
    const isOpen = panel.classList.contains('open');
    document.querySelectorAll('.ai-panel').forEach(p => p.classList.remove('open'));
    if (!isOpen) panel.classList.add('open');
  });
});

document.querySelectorAll('.ai-toggle input').forEach(toggle => {
  toggle.addEventListener('change', () => {
    const ai = toggle.dataset.ai;
    getAISettings(settings => {
      settings[ai] = settings[ai] || {};
      settings[ai].enabled = toggle.checked;
      saveAISettings(settings, () => { updateAICard(ai, settings); updateAIBadge(settings); showSaved(toggle.checked ? '✓ IA ativada!' : 'IA desativada'); });
    });
  });
});

AIS.forEach(ai => {
  document.getElementById(`test-${ai}`).addEventListener('click', async () => {
    const key = document.getElementById(`key-${ai}`).value.trim();
    if (!key) { setFeedback(ai, 'err', '⚠ Cole a chave antes de testar.'); return; }
    const btn = document.getElementById(`test-${ai}`);
    btn.disabled = true; btn.textContent = '...';
    setFeedback(ai, '', '');
    try {
      await AI_CONFIG[ai].test(key);
      setFeedback(ai, 'ok', '✓ Chave válida!');
      getAISettings(settings => {
        settings[ai] = { ...(settings[ai]||{}), key, verified: true };
        saveAISettings(settings, () => updateAICard(ai, settings));
      });
    } catch (e) {
      setFeedback(ai, 'err', `✗ ${e.message}`);
      getAISettings(settings => { if (settings[ai]) { settings[ai].verified = false; saveAISettings(settings, () => updateAICard(ai, settings)); } });
    } finally { btn.disabled = false; btn.textContent = getT(currentUiLang).aiTest; }
  });

  document.getElementById(`save-${ai}`).addEventListener('click', () => {
    const key = document.getElementById(`key-${ai}`).value.trim();
    if (!key) { setFeedback(ai, 'err', '⚠ Digite a chave antes de salvar.'); return; }
    getAISettings(settings => {
      const wasOk = settings[ai]?.key === key && settings[ai]?.verified;
      settings[ai] = { ...(settings[ai]||{}), key, verified: wasOk ? true : false };
      saveAISettings(settings, () => { updateAICard(ai, settings); showSaved(getT(currentUiLang).aiSave + ' ✓'); });
    });
  });
});
