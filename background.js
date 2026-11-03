// background.js — service worker
// Faz todas as chamadas de rede (LanguageTool e IAs). Assim:
//  - as chaves de API nunca passam pelo content script das páginas;
//  - o CORS do site não bloqueia as chamadas (content scripts no MV3 obedecem ao CORS da página);
//  - o limite de requisições do LanguageTool é controlado num lugar só, para todas as abas.

importScripts('shared.js');
const S = self.CorretorShared;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(code, extra) {
  const e = new Error(code);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/* ══ Migração de dados das versões antigas ══ */
async function migrateStorage() {
  const sync = await chrome.storage.sync.get(null);

  // 1. Chaves de API: saem do storage.sync (sincronizado na conta Google) para o storage.local
  const aiSettings = sync.aiSettings || {};
  const { aiKeys = {} } = await chrome.storage.local.get({ aiKeys: {} });
  let changed = false;
  for (const [ai, cfg] of Object.entries(aiSettings)) {
    if (cfg && typeof cfg.key === 'string') {
      if (cfg.key && !aiKeys[ai]) aiKeys[ai] = cfg.key;
      delete cfg.key;
      changed = true;
    }
  }
  // 2. Apenas uma IA ativa por vez (antes, com várias ligadas, valia uma ordem escondida)
  const enabled = S.AI_ORDER.filter(ai => aiSettings[ai]?.enabled);
  if (enabled.length > 1) {
    const keep = ['groq', 'gemini', 'deepseek', 'openai', 'claude'].find(ai => aiSettings[ai]?.enabled && aiSettings[ai]?.verified) || enabled[0];
    enabled.forEach(ai => { if (ai !== keep) aiSettings[ai].enabled = false; });
    changed = true;
  }
  if (changed) {
    await chrome.storage.local.set({ aiKeys });
    await chrome.storage.sync.set({ aiSettings });
  }

  // 3. Dicionário: de um array único (limite de 8 KB) para blocos
  if (Array.isArray(sync[S.DICT_LEGACY_KEY])) {
    try { await S.saveDictionary(S.wordsFromStorage(sync)); }
    catch (e) { console.warn('[Corretor] Falha ao migrar dicionário:', e); }
  }
}

chrome.runtime.onInstalled.addListener(() => { migrateStorage().catch(e => console.warn('[Corretor] migração:', e)); });

/* ══ LanguageTool ══ */
// Servidor: API pública (padrão) ou um servidor próprio configurado no popup
const LT_CUSTOM_MAX_CHARS = 40000;
let ltServer = '';
const ltServerReady = chrome.storage.sync.get({ ltServer: '' })
  .then(s => { ltServer = S.normalizeLtServer(s.ltServer) || ''; })
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.ltServer) ltServer = S.normalizeLtServer(changes.ltServer.newValue) || '';
});

// Contador de uso da API pública (guardado em storage.session para sobreviver ao service worker dormir)
let ltTimes = [];
let ltBlockedUntil = 0;
const ltUsageReady = chrome.storage.session.get({ ltTimes: [], ltBlockedUntil: 0 })
  .then(s => { ltTimes = Array.isArray(s.ltTimes) ? s.ltTimes : []; ltBlockedUntil = Number(s.ltBlockedUntil) || 0; })
  .catch(() => {});

function pruneLtTimes(now = Date.now()) {
  while (ltTimes.length && now - ltTimes[0] > S.LT_RATE_WINDOW_MS) ltTimes.shift();
}
function persistLtUsage() {
  chrome.storage.session.set({ ltTimes, ltBlockedUntil }).catch(() => {});
}

async function ltSlot() {
  await ltUsageReady;
  for (;;) {
    const now = Date.now();
    if (now < ltBlockedUntil) throw fail('rate', { retryAfterMs: ltBlockedUntil - now });
    pruneLtTimes(now);
    if (ltTimes.length < S.LT_RATE_MAX) { ltTimes.push(now); persistLtUsage(); return; }
    const wait = S.LT_RATE_WINDOW_MS - (now - ltTimes[0]) + 50;
    if (wait > 15000) throw fail('rate', { retryAfterMs: wait });
    await sleep(wait);
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function ltRequest(endpoint, text, language, picky) {
  const isPublic = endpoint === S.LT_API;
  if (isPublic) await ltSlot();
  let res;
  try {
    res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ text, language, level: picky ? 'picky' : 'default' }).toString(),
    });
  } catch {
    if (isPublic) throw fail('network', { retryAfterMs: 15000 });
    const granted = await chrome.permissions.contains({ origins: [S.originPattern(endpoint)] }).catch(() => false);
    throw fail(granted ? 'server-unreachable' : 'server-permission', { retryAfterMs: 15000 });
  }
  if (res.status === 429) {
    const ra = parseRetryAfter(res.headers.get('Retry-After')) || 60000;
    if (isPublic) { ltBlockedUntil = Date.now() + ra; persistLtUsage(); }
    throw fail('rate', { retryAfterMs: ra });
  }
  if (res.status === 413) throw fail('too-long');
  if (res.status >= 500) throw fail('unavailable', { retryAfterMs: 30000 });
  if (!res.ok) throw fail('http', { status: res.status });
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.matches)) throw fail('http', { status: res.status });
  return data.matches.map(S.slimMatch);
}

// Cache por parágrafo: editar um parágrafo só reenvia aquele parágrafo
const ltCache = new Map();
const LT_CACHE_MAX = 400;
function cacheGet(key) {
  const v = ltCache.get(key);
  if (v) { ltCache.delete(key); ltCache.set(key, v); }
  return v;
}
function cacheSet(key, value) {
  if (ltCache.size >= LT_CACHE_MAX) ltCache.delete(ltCache.keys().next().value);
  ltCache.set(key, value);
}

async function ltCheck({ text, language, picky }) {
  if (typeof text !== 'string') throw fail('bad-request');
  await ltServerReady;
  const endpoint = ltServer || S.LT_API;
  const maxChars = ltServer ? LT_CUSTOM_MAX_CHARS : S.LT_MAX_CHARS;
  const lang  = typeof language === 'string' ? language : 'pt-BR';
  const paras = S.splitParagraphs(text, maxChars);
  const keyOf = p => `${endpoint}|${lang}|${picky ? 1 : 0}|${p.text}`;

  const matches = [];
  const pending = [];
  for (const p of paras) {
    const cached = cacheGet(keyOf(p));
    if (cached) matches.push(...cached.map(m => ({ ...m, offset: m.offset + p.start })));
    else pending.push(p);
  }

  for (const batch of S.buildBatches(pending, maxChars)) {
    const found   = await ltRequest(endpoint, batch.text, lang, !!picky);
    const perPart = S.splitBatchMatches(batch, found);
    batch.parts.forEach((part, i) => {
      cacheSet(keyOf(part.para), perPart[i]);
      matches.push(...perPart[i].map(m => ({ ...m, offset: m.offset + part.para.start })));
    });
  }

  matches.sort((a, b) => a.offset - b.offset);
  return { matches };
}

async function ltUsage() {
  await Promise.all([ltUsageReady, ltServerReady]);
  const now = Date.now();
  pruneLtTimes(now);
  return {
    used: ltTimes.length,
    max: S.LT_RATE_MAX,
    blockedForMs: Math.max(0, ltBlockedUntil - now),
    server: ltServer,
  };
}

// Testa um servidor próprio (chamado pelo popup antes de salvar)
async function ltTest({ server }) {
  const endpoint = S.normalizeLtServer(server);
  if (!endpoint) throw fail('server-invalid');
  await ltRequest(endpoint, 'Isto é um teste.', 'pt-BR', false);
  return { endpoint };
}

/* ══ IAs ══ */
function chatCompatible(url, key, model, system, user, maxTokens, tokenField, extra) {
  return {
    url,
    headers: { 'Authorization': `Bearer ${key}` },
    body: {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      [tokenField]: maxTokens,
      ...extra,
    },
    parse: r => ({ text: r.choices?.[0]?.message?.content || '', truncated: r.choices?.[0]?.finish_reason === 'length' }),
  };
}

function buildRequest(provider, key, model, system, user, maxTokens) {
  switch (provider) {
    case 'groq':
      return chatCompatible('https://api.groq.com/openai/v1/chat/completions', key, model, system, user, maxTokens,
        'max_completion_tokens', /gpt-oss/.test(model) ? { reasoning_effort: 'low' } : {});
    case 'deepseek':
      return chatCompatible('https://api.deepseek.com/chat/completions', key, model, system, user,
        Math.min(maxTokens, 8192), 'max_tokens');
    case 'openai':
      return chatCompatible('https://api.openai.com/v1/chat/completions', key, model, system, user, maxTokens,
        'max_completion_tokens', /^(gpt-5|o\d)/.test(model) ? { reasoning_effort: 'low' } : {});
    case 'gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { 'x-goog-api-key': key },   // no header, não na URL (URLs vão parar em logs)
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        },
        parse: r => {
          const c = r.candidates?.[0];
          const text = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          return { text, truncated: c?.finishReason === 'MAX_TOKENS' };
        },
      };
    case 'claude':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: { model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] },
        parse: r => ({
          text: (r.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
          truncated: r.stop_reason === 'max_tokens',
        }),
      };
    default:
      throw fail('no-ai');
  }
}

async function callProvider(provider, key, model, system, user, maxTokens) {
  const req = buildRequest(provider, key, model, system, user, maxTokens);
  let res;
  try {
    res = await fetch(req.url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...req.headers },
      body:    JSON.stringify(req.body),
    });
  } catch {
    throw fail('network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw fail('ai-http', { status: res.status, message: `${S.AI_PROVIDERS[provider].label}: ${message}` });
  }
  return req.parse(data);
}

async function getAIConfig() {
  const { aiSettings = {} } = await chrome.storage.sync.get({ aiSettings: {} });
  const { aiKeys = {} }     = await chrome.storage.local.get({ aiKeys: {} });
  const provider = S.activeProvider(aiSettings);
  if (!provider || !aiKeys[provider]) return null;
  const model = (aiSettings[provider].model || '').trim() || S.AI_PROVIDERS[provider].defaultModel;
  return { provider, key: aiKeys[provider], model };
}

async function aiImprove({ text, tone }) {
  if (typeof text !== 'string' || !text.trim()) throw fail('bad-request');
  if (text.length > S.AI_MAX_CHARS) throw fail('ai-too-long', { max: S.AI_MAX_CHARS });
  const cfg = await getAIConfig();
  if (!cfg) throw fail('no-ai');
  const { system, user } = S.buildAIPrompt(text, tone);
  const out = await callProvider(cfg.provider, cfg.key, cfg.model, system, user, S.estimateMaxTokens(text));
  // Resposta cortada pelo limite de tokens: nunca devolver (o "Substituir" apagaria o resto do texto)
  if (out.truncated) throw fail('ai-truncated');
  const cleaned = S.cleanAIOutput(out.text);
  if (!cleaned) throw fail('ai-empty');
  return { text: cleaned, provider: cfg.provider };
}

async function aiTest({ provider, key, model }) {
  if (!S.AI_PROVIDERS[provider] || typeof key !== 'string' || !key.trim()) throw fail('bad-request');
  const m = (model || '').trim() || S.AI_PROVIDERS[provider].defaultModel;
  await callProvider(provider, key.trim(), m, 'Responda apenas: ok', 'ok', 256);
  return {};
}

/* ══ Mensagens ══ */
const HANDLERS = {
  'lt-check':   msg => ltCheck(msg),
  'ai-improve': msg => aiImprove(msg),
  // Só o popup pode testar chaves (mensagens vindas de abas não têm acesso)
  'ai-test':    (msg, sender) => sender.tab ? Promise.reject(fail('forbidden')) : aiTest(msg),
  'lt-test':    (msg, sender) => sender.tab ? Promise.reject(fail('forbidden')) : ltTest(msg),
  'lt-usage':   () => ltUsage(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  handler(msg, sender).then(
    result => sendResponse({ ok: true, ...result }),
    err    => sendResponse({ ok: false, error: { code: err.code || 'unknown', message: err.code ? err.message : String(err), status: err.status, retryAfterMs: err.retryAfterMs, max: err.max } }),
  );
  return true;
});

/* ══ Atalho de teclado (configurável em chrome://extensions/shortcuts) ══ */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'ai-improve' || tab?.id == null) return;
  chrome.tabs.sendMessage(tab.id, { type: 'command-ai-improve' }).catch(() => {});
});
