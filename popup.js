const S   = globalThis.CorretorShared;
const AIS = S.AI_ORDER;

/* ══════════════════════════════════════════════════
   i18n — aplica traduções ao DOM
══════════════════════════════════════════════════ */
let currentUiLang = detectUiLang();
const t = () => getT(currentUiLang);

function applyTranslations(uiLang) {
  currentUiLang = uiLang;
  const tr = getT(uiLang);

  document.documentElement.lang = uiLang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const val = tr[el.dataset.i18n];
    if (typeof val === 'string') el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const val = tr[el.dataset.i18nPlaceholder];
    if (typeof val === 'string') el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const val = tr[el.dataset.i18nTitle];
    if (typeof val === 'string') el.title = val;
  });

  const flagEl  = document.getElementById('uiLangFlag');
  const labelEl = document.getElementById('uiLangLabel');
  if (flagEl && labelEl) { flagEl.textContent = tr.flag; labelEl.textContent = tr.label; }

  document.querySelectorAll('.ui-lang-opt').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.uiLang === uiLang);
  });
  renderSiteRow();
}

function updateSilentBanner(active) {
  const banner = document.getElementById('silentBanner');
  if (banner) banner.classList.toggle('show', active);
}

/* ── Tema do popup ── */
function applyPopupTheme(isLight) {
  document.body.classList.toggle('theme-light', isLight);
}

/* ── Toast ── */
let savedTimer = null;
function showSaved(msg) {
  const el = document.getElementById('savedMsg');
  el.textContent = msg || t().savedOk;
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ── Navegação ── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

/* ── Storage (com tratamento de erro: cota, contexto inválido etc.) ── */
async function save(obj) {
  try { await chrome.storage.sync.set(obj); return true; }
  catch (e) { console.warn('[Corretor] storage:', e); showSaved(t().saveError); return false; }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ══ Dicionário e regras ignoradas ══ */
let dictWords = [];
let ignoredRules = [];

function updateDictCounters(words) {
  document.getElementById('dictCount').textContent       = t().dictSummary(words.length, ignoredRules.length);
  document.getElementById('dictHeaderCount').textContent = words.length;
  document.getElementById('rulesCount').textContent      = ignoredRules.length;
}

function renderRulesList() {
  updateDictCounters(dictWords);
  const list = document.getElementById('rulesList');
  if (!ignoredRules.length) {
    list.innerHTML = `<div class="dict-empty">${escapeHtml(t().rulesEmpty)}</div>`;
    return;
  }
  list.innerHTML = '';
  ignoredRules.forEach(rule => {
    const row = document.createElement('div');
    row.className = 'dict-word-row';
    row.innerHTML = `<span class="dict-word-text">${escapeHtml(rule.name)}<span class="rule-id">${escapeHtml(rule.id)}</span></span>
      <button class="dict-word-remove" data-rule="${escapeHtml(rule.id)}">×</button>`;
    list.appendChild(row);
  });
}

async function loadIgnoredRules() {
  const { ignoredRules: rules = [] } = await chrome.storage.sync.get({ ignoredRules: [] });
  ignoredRules = Array.isArray(rules) ? rules : [];
  return ignoredRules;
}

function renderDictList(words) {
  updateDictCounters(words);
  const list = document.getElementById('dictList');
  if (!words.length) {
    list.innerHTML = `<div class="dict-empty"><span class="dict-empty-icon">📭</span>${escapeHtml(t().dictEmpty)}</div>`;
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

async function saveDict(words) {
  try {
    dictWords = await S.saveDictionary(words);
    renderDictList(dictWords);
    return true;
  } catch (e) {
    console.warn('[Corretor] dicionário:', e);
    showSaved(/quota/i.test(String(e?.message)) ? t().quotaError : t().saveError);
    return false;
  }
}

async function doAddWord() {
  const input = document.getElementById('dictInput');
  const word  = input.value.trim();
  if (!word) { input.focus(); return; }
  dictWords = await S.loadDictionary();
  if (dictWords.some(w => w.toLowerCase() === word.toLowerCase())) { showSaved(t().wordExists); return; }
  if (await saveDict([...dictWords, word])) {
    input.value = '';
    input.focus();
    showSaved(t().wordAdded(word));
  }
}

/* ══ Site atual (pausar por site) ══ */
let siteHost = '';
let disabledSites = [];

function renderSiteRow() {
  const row    = document.getElementById('siteToggle')?.closest('.picky-row');
  const toggle = document.getElementById('siteToggle');
  const label  = document.getElementById('siteHost');
  if (!row || !toggle || !label) return;
  const builtin = S.isHostDisabled(siteHost, []);
  const usable  = !!siteHost && !builtin;
  row.classList.toggle('disabled', !usable);
  toggle.disabled = !usable;
  toggle.checked  = builtin || (usable && S.isHostDisabled(siteHost, disabledSites));
  label.textContent = siteHost || t().pauseSiteNA;
}

async function loadSiteHost() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url || '');
    siteHost = /^https?:$/.test(url.protocol) ? S.normalizeHost(url.hostname) : '';
  } catch { siteHost = ''; }
  renderSiteRow();
}

/* ══ IA ══ */
async function getAISettings() {
  const { aiSettings = {} } = await chrome.storage.sync.get({ aiSettings: {} });
  return aiSettings;
}
async function getAIKeys() {
  const { aiKeys = {} } = await chrome.storage.local.get({ aiKeys: {} });
  return aiKeys;
}

function setFeedback(ai, type, msg) {
  const fb = document.getElementById(`fb-${ai}`);
  fb.className   = `ai-feedback ${type}`;
  fb.textContent = msg;
}

function updateAICard(ai, settings, keys) {
  const cfg = settings[ai] || {};
  const key = keys[ai] || '';
  const isVerified = !!cfg.verified && !!key;
  document.getElementById(`dot-${ai}`).className = 'ai-status-dot' + (isVerified ? ' ok' : key ? ' err' : '');
  const toggle = document.getElementById(`toggle-${ai}`);
  toggle.checked  = !!cfg.enabled && isVerified;
  toggle.disabled = !isVerified;
  const card = document.getElementById(`card-${ai}`);
  card.classList.toggle('configured', isVerified);
  card.classList.toggle('active-ai', !!cfg.enabled && isVerified);
  const keyInput = document.getElementById(`key-${ai}`);
  if (document.activeElement !== keyInput) keyInput.value = key;
  const modelInput = document.getElementById(`model-${ai}`);
  modelInput.placeholder = S.AI_PROVIDERS[ai].defaultModel;
  if (document.activeElement !== modelInput) modelInput.value = cfg.model || '';
}

function updateAIBadge(settings) {
  const tr     = t();
  const active = S.activeProvider(settings) ? 1 : 0;
  const badge  = document.getElementById('aiActiveBadge');
  const label  = document.getElementById('aiInactiveLabel');
  if (active > 0) {
    badge.textContent = tr.active(active); badge.style.display = '';
    label.style.display = 'none';
  } else {
    badge.style.display = 'none';
    label.textContent = tr.noneActive; label.style.display = '';
  }
}

async function refreshAI() {
  const [settings, keys] = await Promise.all([getAISettings(), getAIKeys()]);
  AIS.forEach(ai => updateAICard(ai, settings, keys));
  updateAIBadge(settings);
}

/* ══ Histórico ══ */
function renderHistPopup(history) {
  const tr   = t();
  const list = document.getElementById('histListPopup');
  document.getElementById('histCount').textContent = tr.items(history.length);
  if (!history.length) {
    list.innerHTML = `<div class="hist-empty-popup"><span class="hist-empty-icon">🕐</span>${escapeHtml(tr.histEmpty)}</div>`;
    return;
  }
  list.innerHTML = '';
  history.forEach((h, i) => {
    const date = new Date(h.date).toLocaleString(currentUiLang, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const original = String(h.original || '');
    const result   = String(h.result || '');
    const item = document.createElement('div');
    item.className = 'hist-item-popup';
    item.innerHTML = `
      <div class="hist-item-meta"><span class="hist-item-ai">${escapeHtml(S.AI_PROVIDERS[h.aiName]?.label || h.aiName || '')}</span><span class="hist-item-date">${escapeHtml(date)}</span></div>
      <div class="hist-item-original"><b>${escapeHtml(tr.histBefore)}</b> ${escapeHtml(original.substring(0, 80))}${original.length > 80 ? '…' : ''}</div>
      <div class="hist-item-result"><b>${escapeHtml(tr.histAfter)}</b> ${escapeHtml(result.substring(0, 120))}${result.length > 120 ? '…' : ''}</div>
      <div class="hist-item-actions"><button class="hist-copy-btn" data-index="${i}">${escapeHtml(tr.copyResult)}</button></div>`;
    list.appendChild(item);
  });
  list.querySelectorAll('.hist-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(history[btn.dataset.index].result).catch(() => {});
      showSaved(t().copied);
    });
  });
}

async function refreshHistCount() {
  const { aiHistory = [] } = await chrome.storage.local.get({ aiHistory: [] });
  document.getElementById('histCount').textContent = t().items(aiHistory.length);
  return aiHistory;
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

uiLangDropdown.addEventListener('click', async e => {
  const btn = e.target.closest('.ui-lang-opt');
  if (!btn) return;
  const lang = btn.dataset.uiLang;
  uiLangCurrent.classList.remove('open');
  uiLangDropdown.classList.remove('open');
  if (!(await save({ uiLang: lang }))) return;
  applyTranslations(lang);
  updateDictCounters(dictWords);
  refreshHistCount();
  updateAIBadge(await getAISettings());
  showSaved(getT(lang).uiLangSaved);
});

/* ══ Init ══ */
(async () => {
  const s = await chrome.storage.sync.get({ language: 'pt-BR', picky: true, silentMode: false, theme: 'dark', uiLang: '', disabledSites: [] });
  disabledSites = s.disabledSites || [];
  applyTranslations(s.uiLang || detectUiLang());

  const manifest = chrome.runtime.getManifest();
  document.getElementById('versionLink').textContent = `v${manifest.version} · by jrmaciel131 ↗`;

  document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === s.language));
  document.getElementById('pickyToggle').checked  = !!s.picky;
  document.getElementById('silentToggle').checked = !!s.silentMode;
  const isLight = s.theme === 'light';
  document.getElementById('themeToggle').checked = isLight;
  applyPopupTheme(isLight);
  updateSilentBanner(!!s.silentMode);

  dictWords = await S.loadDictionary();
  await loadIgnoredRules();
  updateDictCounters(dictWords);
  refreshHistCount();
  refreshAI();
  loadSiteHost();
  refreshUsage();
  setInterval(refreshUsage, 2000);
})();

/* ══ Contador de uso / servidor LanguageTool ══ */
async function refreshUsage() {
  let u;
  try { u = await chrome.runtime.sendMessage({ type: 'lt-usage' }); } catch { return; }
  if (!u?.ok) return;
  const tr   = t();
  const dot  = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  const mode = document.getElementById('ltServerMode');
  dot.className = 'status-dot';
  if (u.server) {
    let host = u.server;
    try { host = new URL(u.server).host; } catch { /* mantém o endereço */ }
    text.textContent = tr.usageCustom(host);
    dot.classList.add('custom');
    mode.textContent = tr.ltServerCustom;
  } else if (u.blockedForMs > 0) {
    text.textContent = tr.usageBlocked(Math.ceil(u.blockedForMs / 1000));
    dot.classList.add('block');
    mode.textContent = tr.ltServerPublic;
  } else {
    text.textContent = tr.usagePublic(u.used, u.max);
    if (u.used >= u.max - 3) dot.classList.add('warn');
    mode.textContent = tr.ltServerPublic;
  }
}

function setLtFeedback(type, msg) {
  const fb = document.getElementById('fb-lt');
  fb.className   = `ai-feedback ${type}`;
  fb.textContent = msg;
}

function ltErrorText(err = {}) {
  const tr = t();
  switch (err.code) {
    case 'server-invalid':     return tr.ltServerInvalid;
    case 'server-permission':  return tr.ltServerPermDenied;
    case 'server-unreachable': return tr.cErrServerUnreachable;
    case 'http':               return tr.cErrHttp(err.status);
    default:                   return err.message || tr.cErrUnknown;
  }
}

// Pede permissão para a origem do servidor. Precisa rodar direto no clique (gesto do usuário).
function requestServerPermission(endpoint) {
  return chrome.permissions.request({ origins: [S.originPattern(endpoint)] }).catch(() => false);
}

async function testLtServer(endpoint) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'lt-test', server: endpoint });
    return res?.ok ? null : (res?.error || {});
  } catch (e) {
    return { message: String(e?.message || e) };
  }
}

document.getElementById('openLtBtn').addEventListener('click', async () => {
  const { ltServer = '' } = await chrome.storage.sync.get({ ltServer: '' });
  document.getElementById('ltServerInput').value = ltServer;
  setLtFeedback('', '');
  showScreen('screenLt');
});
document.getElementById('backFromLt').addEventListener('click', () => { refreshUsage(); showScreen('screenMain'); });

['ltServerTestBtn', 'ltServerSaveBtn'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => {
    const endpoint = S.normalizeLtServer(document.getElementById('ltServerInput').value);
    if (!endpoint) { setLtFeedback('err', t().ltServerInvalid); return; }
    const btn = document.getElementById(id);
    const permission = requestServerPermission(endpoint); // antes de qualquer await
    (async () => {
      if (!(await permission)) { setLtFeedback('err', t().ltServerPermDenied); return; }
      btn.disabled = true;
      setLtFeedback('', '');
      const err = await testLtServer(endpoint);
      btn.disabled = false;
      if (err) { setLtFeedback('err', `✗ ${ltErrorText(err)}`); return; }
      if (id === 'ltServerTestBtn') { setLtFeedback('ok', t().ltServerOk); return; }
      document.getElementById('ltServerInput').value = endpoint;
      if (await save({ ltServer: endpoint })) { setLtFeedback('ok', t().ltServerSaved); refreshUsage(); }
    })();
  });
});

document.getElementById('ltServerResetBtn').addEventListener('click', async () => {
  document.getElementById('ltServerInput').value = '';
  if (await save({ ltServer: '' })) { setLtFeedback('ok', t().ltServerResetDone); refreshUsage(); }
});

/* ── Idioma de verificação ── */
document.getElementById('langGrid').addEventListener('click', async e => {
  const btn = e.target.closest('.lang-btn');
  if (!btn) return;
  document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b === btn));
  if (await save({ language: btn.dataset.lang })) showSaved(t().langSaved);
});

document.getElementById('pickyToggle').addEventListener('change', async e => {
  if (await save({ picky: e.target.checked })) showSaved(t().savedOk);
});

document.getElementById('silentToggle').addEventListener('change', async e => {
  const active = e.target.checked;
  if (await save({ silentMode: active })) { updateSilentBanner(active); showSaved(active ? t().silentOn : t().silentOff); }
});

document.getElementById('themeToggle').addEventListener('change', async e => {
  const isLight = e.target.checked;
  applyPopupTheme(isLight);
  if (await save({ theme: isLight ? 'light' : 'dark' })) showSaved(isLight ? t().themeLight : t().themeDark);
});

document.getElementById('siteToggle').addEventListener('change', async e => {
  if (!siteHost) return;
  const pause = e.target.checked;
  const list  = disabledSites.filter(h => S.normalizeHost(h) !== siteHost);
  if (pause) list.push(siteHost);
  if (await save({ disabledSites: list })) {
    disabledSites = list;
    showSaved(pause ? t().pausedOn(siteHost) : t().resumedOn(siteHost));
  }
  renderSiteRow();
});

/* ── Navegação ── */
document.getElementById('openDictBtn').addEventListener('click', async () => {
  dictWords = await S.loadDictionary();
  await loadIgnoredRules();
  renderDictList(dictWords);
  renderRulesList();
  showScreen('screenDict');
});

document.getElementById('rulesList').addEventListener('click', async e => {
  const btn = e.target.closest('.dict-word-remove');
  if (!btn) return;
  const rules = (await loadIgnoredRules()).filter(r => r.id !== btn.dataset.rule);
  if (await save({ ignoredRules: rules })) {
    ignoredRules = rules;
    renderRulesList();
    showSaved(t().ruleRemoved);
  }
});
document.getElementById('backFromDict').addEventListener('click', () => {
  updateDictCounters(dictWords);
  showScreen('screenMain');
});
document.getElementById('openAIBtn').addEventListener('click', () => { refreshAI(); showScreen('screenAI'); });
document.getElementById('backFromAI').addEventListener('click', async () => {
  updateAIBadge(await getAISettings());
  showScreen('screenMain');
});

/* ── Histórico ── */
document.getElementById('openHistBtn').addEventListener('click', async () => {
  renderHistPopup(await refreshHistCount());
  showScreen('screenHist');
});
document.getElementById('backFromHist').addEventListener('click', () => {
  refreshHistCount();
  showScreen('screenMain');
});
document.getElementById('clearHistBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ aiHistory: [] });
  renderHistPopup([]);
  showSaved(t().histCleared);
});

/* ── Dicionário ── */
document.getElementById('dictAddBtn').addEventListener('click', doAddWord);
document.getElementById('dictInput').addEventListener('keydown', e => { if (e.key === 'Enter') doAddWord(); });

document.getElementById('exportDictBtn').addEventListener('click', async () => {
  const words = await S.loadDictionary();
  const blob  = new Blob([JSON.stringify({ version: S.VERSION, words, exported: new Date().toISOString() }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'corretor-dicionario.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  showSaved(t().exported);
});

document.getElementById('importDictBtn').addEventListener('click', () => document.getElementById('importDictFile').click());
document.getElementById('importDictFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    let words;
    try {
      const text = String(ev.target.result);
      if (file.name.toLowerCase().endsWith('.json')) {
        const p = JSON.parse(text);
        words = Array.isArray(p) ? p : p?.words;
        if (!Array.isArray(words)) throw new Error('formato');
      } else {
        words = text.split(/\r?\n/);
      }
    } catch {
      showSaved(t().importError);
      return;
    }
    const existing = await S.loadDictionary();
    const merged   = S.normalizeWords([...existing, ...words]);
    const added    = merged.length - existing.length;
    if (await saveDict(merged)) showSaved(t().imported(added));
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('dictList').addEventListener('click', async e => {
  const btn = e.target.closest('.dict-word-remove');
  if (!btn) return;
  const word  = btn.dataset.word;
  const words = (await S.loadDictionary()).filter(w => w !== word);
  if (await saveDict(words)) showSaved(t().wordRemoved(word));
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

// Clicar no interruptor não abre/fecha o painel (antes era um onclick inline, bloqueado pelo CSP do MV3)
document.querySelectorAll('.ai-toggle').forEach(label => label.addEventListener('click', e => e.stopPropagation()));

// Só uma IA ativa por vez: ligar uma desliga as outras
document.querySelectorAll('.ai-toggle input').forEach(toggle => {
  toggle.addEventListener('change', async () => {
    const ai = toggle.dataset.ai;
    const settings = await getAISettings();
    if (toggle.checked) AIS.forEach(other => { if (other !== ai && settings[other]) settings[other].enabled = false; });
    settings[ai] = { ...(settings[ai] || {}), enabled: toggle.checked };
    if (await save({ aiSettings: settings })) showSaved(toggle.checked ? t().aiOn : t().aiOff);
    refreshAI();
  });
});

AIS.forEach(ai => {
  const keyInput   = document.getElementById(`key-${ai}`);
  const modelInput = document.getElementById(`model-${ai}`);
  const testBtn    = document.getElementById(`test-${ai}`);

  testBtn.addEventListener('click', async () => {
    const key   = keyInput.value.trim();
    const model = modelInput.value.trim();
    if (!key) { setFeedback(ai, 'err', t().keyPasteFirst); return; }
    testBtn.disabled = true;
    testBtn.textContent = '...';
    setFeedback(ai, '', '');
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'ai-test', provider: ai, key, model });
    } catch (e) {
      res = { ok: false, error: { message: String(e?.message || e) } };
    }
    const keys     = await getAIKeys();
    const settings = await getAISettings();
    if (res?.ok) {
      setFeedback(ai, 'ok', t().keyValid);
      keys[ai] = key;
      settings[ai] = { ...(settings[ai] || {}), verified: true, model };
      await chrome.storage.local.set({ aiKeys: keys });
      await save({ aiSettings: settings });
    } else {
      const err = res?.error || {};
      setFeedback(ai, 'err', `✗ ${err.code === 'network' ? t().cErrNetwork : (err.message || t().cErrUnknown)}`);
      if (settings[ai]) { settings[ai].verified = false; settings[ai].enabled = false; await save({ aiSettings: settings }); }
    }
    testBtn.disabled = false;
    testBtn.textContent = t().aiTest;
    refreshAI();
  });

  document.getElementById(`save-${ai}`).addEventListener('click', async () => {
    const key   = keyInput.value.trim();
    const model = modelInput.value.trim();
    if (!key) { setFeedback(ai, 'err', t().keyTypeFirst); return; }
    const keys     = await getAIKeys();
    const settings = await getAISettings();
    const prev     = settings[ai] || {};
    // Trocar a chave ou o modelo exige testar de novo
    const stillOk  = keys[ai] === key && (prev.model || '') === model && !!prev.verified;
    keys[ai] = key;
    settings[ai] = { ...prev, model, verified: stillOk, enabled: stillOk ? !!prev.enabled : false };
    await chrome.storage.local.set({ aiKeys: keys });
    if (await save({ aiSettings: settings })) {
      if (stillOk) showSaved(t().savedOk);
      else setFeedback(ai, 'ok', t().keySavedRetest);
    }
    refreshAI();
  });
});
