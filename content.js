(() => {
  'use strict';

  const LANGUAGETOOL_API = 'https://api.languagetool.org/v2/check';
  const DEBOUNCE_MS = 600;
  const MIN_CHARS   = 4;
  const ERROR_TYPES = new Set(['misspelling', 'grammar', 'typographical', 'duplication', 'whitespace', 'non-conformance']);
  const VERSION     = 'v12';

  const BLOCKED_HOSTNAMES = ['docs.google.com'];
  if (BLOCKED_HOSTNAMES.some(h => location.hostname === h || location.hostname.endsWith('.' + h))) {
    throw new Error('[Corretor PT-BR] Desativado neste site.');
  }

  const SKIP_SELECTORS = [
    'input[type="password"]', 'input[type="email"]', 'input[type="number"]',
    'input[type="tel"]', 'input[type="url"]', 'input[type="search"]',
    'input[type="date"]', 'input[type="time"]', 'input[type="color"]',
    'input[autocomplete="cc-number"]', 'input[autocomplete="cc-exp"]',
    'input[name*="cpf"]', 'input[name*="cnpj"]', 'input[name*="code"]',
    'input[name*="codigo"]', 'input[name*="token"]', 'input[name*="pin"]',
    '[data-no-corretor]',
  ];

  /* ── Settings ── */
  let SETTINGS      = { language: 'pt-BR', picky: true, silentMode: false, theme: 'dark' };
  let IGNORED_WORDS = new Set();
  let AI_SETTINGS   = {};

  chrome.storage.sync.get(
    { language: 'pt-BR', picky: true, silentMode: false, ignoredWords: [], aiSettings: {}, theme: 'dark' },
    s => {
      SETTINGS      = s;
      IGNORED_WORDS = new Set((s.ignoredWords || []).map(w => w.toLowerCase()));
      AI_SETTINGS   = s.aiSettings || {};
      applyThemeToCards();
    }
  );
  chrome.storage.onChanged.addListener(changes => {
    if (changes.language)     SETTINGS.language  = changes.language.newValue;
    if (changes.picky)        SETTINGS.picky      = changes.picky.newValue;
    if (changes.silentMode)   SETTINGS.silentMode = changes.silentMode.newValue;
    if (changes.ignoredWords) IGNORED_WORDS       = new Set(changes.ignoredWords.newValue.map(w => w.toLowerCase()));
    if (changes.aiSettings)   AI_SETTINGS         = changes.aiSettings.newValue || {};
    if (changes.theme)        { SETTINGS.theme = changes.theme.newValue; applyThemeToCards(); }
  });

  function applyThemeToCards() {
    const isDark = SETTINGS.theme !== 'light';
    document.querySelectorAll('.corretor-card, .corretor-indicator, .corretor-ai-btn').forEach(el => {
      el.setAttribute('data-theme', isDark ? 'dark' : 'light');
    });
  }

  function addToIgnored(word) {
    const norm = word.trim();
    if (!norm) return;
    chrome.storage.sync.get({ ignoredWords: [] }, data => {
      if (data.ignoredWords.some(w => w.toLowerCase() === norm.toLowerCase())) return;
      chrome.storage.sync.set({ ignoredWords: [...data.ignoredWords, norm] });
    });
  }

  /* ── Histórico de sugestões IA (máx 10) ── */
  function saveAIHistory(original, result, aiName) {
    chrome.storage.local.get({ aiHistory: [] }, data => {
      const entry   = { original, result, aiName, date: Date.now() };
      const updated = [entry, ...data.aiHistory].slice(0, 10);
      chrome.storage.local.set({ aiHistory: updated });
    });
  }

  /* ── IA ── */
  function getActiveAI() {
    for (const ai of ['groq', 'gemini', 'deepseek', 'openai', 'claude']) {
      const cfg = AI_SETTINGS[ai];
      if (cfg?.enabled && cfg?.verified && cfg?.key) return { ai, key: cfg.key };
    }
    return null;
  }

  async function callAI(ai, key, text, tone = 'default') {
    const toneMap = {
      default: 'Corrija os erros gramaticais e ortográficos, melhore a clareza onde necessário e complete frases incompletas. Preserve ao máximo o estilo, tom e voz original do autor. Faça apenas o mínimo necessário',
      formal:  'Corrija os erros e ajuste sutilmente o tom para mais formal e profissional, preservando o sentido e estrutura original',
      direct:  'Corrija os erros e torne o texto ligeiramente mais direto e objetivo, sem alterar a essência da mensagem',
      short:   'Corrija os erros e remova redundâncias, mantendo o significado completo em menos palavras',
    };
    const instruction = toneMap[tone] || toneMap.default;
    const prompt = `${instruction}. IMPORTANTE: preserve todas as quebras de linha e formatação original do texto. Retorne APENAS o texto corrigido, sem explicações, sem comentários, sem aspas, sem formatação extra:\n\n${text}`;

    const configs = {
      groq:     { url: 'https://api.groq.com/openai/v1/chat/completions',    body: { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], max_tokens: 1000 }, headers: { 'Authorization': `Bearer ${key}` }, path: r => r.choices?.[0]?.message?.content?.trim() },
      gemini:   { url: `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${key}`, body: { contents: [{ parts: [{ text: prompt }] }] }, headers: {}, path: r => r.candidates?.[0]?.content?.parts?.[0]?.text?.trim() },
      deepseek: { url: 'https://api.deepseek.com/chat/completions',          body: { model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 1000 }, headers: { 'Authorization': `Bearer ${key}` }, path: r => r.choices?.[0]?.message?.content?.trim() },
      openai:   { url: 'https://api.openai.com/v1/chat/completions',         body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 1000 }, headers: { 'Authorization': `Bearer ${key}` }, path: r => r.choices?.[0]?.message?.content?.trim() },
      claude:   { url: 'https://api.anthropic.com/v1/messages',              body: { model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [{ role: 'user', content: prompt }] }, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, path: r => r.content?.[0]?.text?.trim() },
    };
    const cfg = configs[ai];
    if (!cfg) throw new Error('IA não configurada');
    const r = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cfg.headers }, body: JSON.stringify(cfg.body) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e?.error?.message || `${ai} HTTP ${r.status}`); }
    return cfg.path(await r.json()) || '';
  }

  /* ── Utilidades ── */
  function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
  function isVisible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }
  function getTextFrom(el)   { return el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || ''); }
  function wordCount(text)   { return text.trim().split(/\s+/).filter(Boolean).length; }
  function charCount(text)   { return text.length; }
  function escapeHtml(str)   { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function shouldSkipField(el) { return SKIP_SELECTORS.some(sel => el.matches?.(sel)); }

  /* ── Cache de resultados ── */
  const resultCache = new Map();
  const CACHE_MAX   = 50;
  function cacheGet(text) { return resultCache.get(text); }
  function cacheSet(text, value) {
    if (resultCache.size >= CACHE_MAX) resultCache.delete(resultCache.keys().next().value);
    resultCache.set(text, value);
  }

  /* ── Cache do fiber React por elemento ── */
  const reactFiberCache = new WeakMap();
  function getReactFiberKey(el) {
    if (reactFiberCache.has(el)) return reactFiberCache.get(el);
    const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')) || null;
    reactFiberCache.set(el, key);
    return key;
  }

  /* ── Setters — FIX #8: preserva quebras de linha ── */
  function setInputText(el, text) {
    const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setContentEditableText(el, text) {
    el.focus();
    // Estratégia 1: innerText — preserva \n nativamente na maioria dos sites
    // É o método mais confiável para manter quebras de linha
    const prev = el.innerText || el.textContent || '';
    if (prev.trim() === text.trim()) return; // nada a fazer

    // Tenta via execCommand (compatível com React/Vue que escutam eventos de input)
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('insertText', false, text);
      if (ok && (el.innerText || el.textContent || '').trim() === text.trim()) return;
    } catch (e) { /* fallback abaixo */ }

    // Fallback: innerText preserva \n → <br> nativamente
    el.innerText = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function triggerReactInput(el, text) {
    const fiberKey = getReactFiberKey(el);
    if (!fiberKey) return false;
    let node = el[fiberKey];
    while (node) {
      const props = node.memoizedProps || node.pendingProps;
      if (props && typeof props.onChange === 'function') {
        el.innerHTML = ''; el.appendChild(document.createTextNode(text));
        props.onChange({ target: el, currentTarget: el, type: 'input',
          nativeEvent: new InputEvent('input', { bubbles: true, data: text }),
          bubbles: true, preventDefault: () => {}, stopPropagation: () => {} });
        return true;
      }
      node = node.return;
    }
    return false;
  }
  function isWhatsApp() { return location.hostname.includes('web.whatsapp.com'); }
  async function setWhatsAppText(el, newText) {
    el.focus(); await sleep(30);
    const reactWorked = triggerReactInput(el, newText);
    if (reactWorked) { await sleep(50); if ((el.innerText || el.textContent || '').trim() === newText.trim()) return; }
    try {
      const range = document.createRange(); range.selectNodeContents(el);
      const sel   = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      await sleep(20); document.execCommand('delete', false, null);
      await sleep(20); document.execCommand('insertText', false, newText);
      await sleep(30); if ((el.innerText || el.textContent || '').trim() === newText.trim()) return;
    } catch(e) {}
    el.innerHTML = ''; el.appendChild(document.createTextNode(newText));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: newText }));
  }
  async function smartSetText(el, text) {
    if (isWhatsApp() && el.isContentEditable) await setWhatsAppText(el, text);
    else if (el.isContentEditable) setContentEditableText(el, text);
    else setInputText(el, text);
  }

  /* ── API LanguageTool ── */
  async function checkText(text, signal) {
    const cached = cacheGet(text);
    if (cached) return cached;
    try {
      const params = {
        text,
        language: SETTINGS.language,
        enabledOnly: 'false',
        picky: 'true',
        level: 'picky'
      };
      const res = await fetch(LANGUAGETOOL_API, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams(params).toString(),
        signal,
      });
      if (!res.ok) {
        let msg = `Erro HTTP ${res.status}`;
        if (res.status === 429) msg = 'Limite de requisições atingido. Aguarde alguns instantes.';
        else if (res.status === 503) msg = 'Serviço indisponível. A API do LanguageTool está fora do ar.';
        return { errors: [], hints: [], apiError: msg };
      }
      const allMatches = (await res.json()).matches || [];
      const matches = allMatches.filter(m => {
        const word = (m.context?.text || '').substring(m.context?.offset || 0, (m.context?.offset || 0) + (m.context?.length || 0));
        return !IGNORED_WORDS.has(word.toLowerCase());
      });
      const result = {
        errors: matches.filter(m =>  ERROR_TYPES.has(m.rule?.issueType)),
        hints:  matches.filter(m => !ERROR_TYPES.has(m.rule?.issueType)),
      };
      cacheSet(text, result);
      return result;
    } catch(e) {
      if (e.name === 'AbortError') return null;
      return { errors: [], hints: [], apiError: 'Sem conexão ou API inacessível.' };
    }
  }

  /* ── Ícones ── */
  const ICONS = {
    ok:          `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 5L4 7.5L8.5 2.5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    loading:     `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1h6M2 9h6M3 1v2.2L5 5l-2 1.8V9M7 1v2.2L5 5l2 1.8V9" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error:       `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2L8 8M8 2L2 8" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    hint:        `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 1C3.6 1 2.5 2.1 2.5 3.5c0 .9.47 1.68 1.18 2.14V7h2.64V5.64C7.03 5.18 7.5 4.4 7.5 3.5 7.5 2.1 6.4 1 5 1z" stroke="white" stroke-width="1.2" stroke-linejoin="round"/><path d="M3.8 8h2.4M4.2 9h1.6" stroke="white" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    'api-error': `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 2v4" stroke="white" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="8" r="0.9" fill="white"/></svg>`,
  };
  const ICON_STAR = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2L12.5 7.5H18L13.5 11L15.5 17L10 13.5L4.5 17L6.5 11L2 7.5H7.5L10 2Z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const ICON_SPIN = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" stroke="white" stroke-width="1.8" stroke-dasharray="22" stroke-dashoffset="8"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.8s" repeatCount="indefinite"/></circle></svg>`;

  const CLICKABLE_STATES = new Set(['error', 'hint', 'api-error']);
  function getIndicatorState(errors, hints) {
    if (errors.length > 0) return 'error';
    if (hints.length  > 0) return 'hint';
    return 'ok';
  }
  function applyIndicatorState(indicator, state, errorMsg) {
    indicator.className    = `corretor-indicator ${state}`;
    indicator.setAttribute('data-theme', SETTINGS.theme !== 'light' ? 'dark' : 'light');
    indicator.innerHTML    = ICONS[state] || ICONS.ok;
    indicator._apiErrorMsg = errorMsg || null;
    indicator.style.removeProperty('pointer-events');
    indicator.style.removeProperty('cursor');
  }

  /* ══════════════════════════════════════════════════════
     SUBLINHADO INLINE — FIX #6: sublinhado mais visual e espesso
  ══════════════════════════════════════════════════════ */
  const underlayMap = new WeakMap();

  function getOrCreateUnderlay(el) {
    if (underlayMap.has(el)) return underlayMap.get(el);
    const overlay = document.createElement('div');
    overlay.className = 'corretor-underlay';
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483640;overflow:hidden;';
    document.body.appendChild(overlay);
    underlayMap.set(el, overlay);
    return overlay;
  }

  function repositionUnderlay(el) {
    const overlay = underlayMap.get(el);
    if (!overlay) return;
    const r = el.getBoundingClientRect();
    overlay.style.left   = r.left + 'px';
    overlay.style.top    = r.top  + 'px';
    overlay.style.width  = r.width  + 'px';
    overlay.style.height = r.height + 'px';
  }

  function clearUnderlay(el) {
    const overlay = underlayMap.get(el);
    if (overlay) overlay.innerHTML = '';
  }

  function removeUnderlay(el) {
    const overlay = underlayMap.get(el);
    if (overlay) { overlay.remove(); underlayMap.delete(el); }
  }

  function drawUnderlines(el, errors, hints) {
    if (!el.isContentEditable) return;

    const overlay = getOrCreateUnderlay(el);
    overlay.innerHTML = '';
    repositionUnderlay(el);

    const elRect     = el.getBoundingClientRect();
    const allMatches = [
      ...errors.map(m => ({ ...m, isHint: false })),
      ...hints.map(m  => ({ ...m, isHint: true  })),
    ];

    const nodeMap = [];
    const walker  = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    let tn;
    while ((tn = walker.nextNode())) {
      for (let i = 0; i < tn.nodeValue.length; i++) {
        nodeMap.push({ node: tn, offset: i });
      }
    }

    for (const match of allMatches) {
      const start = match.offset;
      const end   = match.offset + match.length;
      if (start >= nodeMap.length || end > nodeMap.length || end === 0) continue;

      try {
        const range = document.createRange();
        range.setStart(nodeMap[start].node, nodeMap[start].offset);
        if (end <= nodeMap.length && nodeMap[end - 1]) {
          const endNode   = nodeMap[end - 1].node;
          const endOffset = nodeMap[end - 1].offset + 1;
          range.setEnd(endNode, Math.min(endOffset, endNode.nodeValue.length));
        } else continue;

        // FIX #6: SVG ondulado mais visível, espesso e com glow
        const isHint = match.isHint;
        const color  = isHint ? 'rgba(168,85,247,0.9)' : 'rgba(239,68,68,0.95)';
        const colorEnc = encodeURIComponent(color);
        // Linha ondulada mais espessa (altura 4px, stroke 1.8)
        const svg = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='4'%3E%3Cpath d='M0 3 Q2 0 4 3 Q6 6 8 3' stroke='${colorEnc}' stroke-width='1.8' fill='none'/%3E%3C/svg%3E")`;

        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width < 2) continue;

          // Wrapper com brilho/glow atrás
          const wrapper = document.createElement('div');
          wrapper.style.cssText = `
            position:absolute;
            left:${rect.left - elRect.left}px;
            top:${rect.bottom - elRect.top - 5}px;
            width:${rect.width}px;
            height:8px;
            pointer-events:all;
            cursor:pointer;
          `;

          // Glow layer
          const glow = document.createElement('div');
          const glowColor = isHint ? 'rgba(168,85,247,0.2)' : 'rgba(239,68,68,0.2)';
          glow.style.cssText = `
            position:absolute;
            inset:-2px;
            border-radius:2px;
            background:${glowColor};
            filter:blur(2px);
          `;

          // Underline layer
          const line = document.createElement('div');
          line.style.cssText = `
            position:absolute;
            inset:0;
            background:${svg} repeat-x;
            background-position:0 1px;
          `;

          wrapper.appendChild(glow);
          wrapper.appendChild(line);
          wrapper.addEventListener('click', (e) => {
            e.stopPropagation();
            const state = fieldMap.get(el);
            if (state) openCard(state.indicator, el, state.errors, state.hints);
          });
          overlay.appendChild(wrapper);
        }
      } catch(e) { /* falha silenciosa */ }
    }
  }

  /* ── Estado global ── */
  const fieldMap         = new WeakMap();
  const indicatorToField = new WeakMap();
  let activeCard         = null;
  let activeIndicator    = null;
  let activePreviewCard  = null;

  /* ── Constantes de posicionamento ── */
  const DOT_SIZE      = 24;
  const MARGIN_EDGE   = 4;
  const MARGIN_BOTTOM = 4;

  function hasVerticalScrollbar(el) {
    return el.scrollHeight > el.clientHeight + 2;
  }

  function placeIndicator(indicator, el) {
    const r           = el.getBoundingClientRect();
    const scrollExtra = hasVerticalScrollbar(el) ? 17 : 0;
    const posX = r.left + (r.width * 0.98) - DOT_SIZE - scrollExtra;
    const posY = r.top + (r.height * 0.98) - DOT_SIZE;
    indicator.style.left = Math.max(r.left, posX) + 'px';
    indicator.style.top  = Math.max(r.top, posY) + 'px';
  }

  /* ── Criar indicador — FIX #1 + #2 ── */
  function createIndicator(el) {
    const indicator = document.createElement('div');
    indicator.className       = 'corretor-indicator loading';
    indicator.innerHTML       = ICONS.loading;
    indicator.style.display   = 'none';
    indicator.setAttribute('data-theme', SETTINGS.theme !== 'light' ? 'dark' : 'light');
    document.body.appendChild(indicator);

    let focused = false;
    // FIX #2: flag para só mostrar o dot após o usuário ter digitado algo
    let hasUserTyped = false;

    const onScroll = () => reposition();
    const onResize = () => reposition();

    function reposition() {
      if (!document.body.contains(el)) { cleanup(); return; }
      // FIX #1: verifica se o elemento ainda existe no DOM e está visível
      if (!focused || SETTINGS.silentMode || !isInViewport(el) || !hasUserTyped) {
        indicator.style.display = 'none';
        repositionUnderlay(el);
        return;
      }
      indicator.style.display = 'flex';
      placeIndicator(indicator, el);
      repositionUnderlay(el);
    }

    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize, { passive: true });

    el.addEventListener('focus', () => {
      focused = true;
      // FIX #2: só mostra o dot se já tiver texto E o usuário tiver digitado antes
      if (!SETTINGS.silentMode && isInViewport(el) && hasUserTyped) {
        placeIndicator(indicator, el);
        indicator.style.display = 'flex';
        const st = fieldMap.get(el);
        if (st && (st.errors.length || st.hints.length)) drawUnderlines(el, st.errors, st.hints);
      }
    });

    el.addEventListener('blur', () => {
      setTimeout(() => {
        const active = document.activeElement;
        // FIX #1: valida que o activeElement não é o próprio indicator
        if (active === indicator || indicator.contains(active) || (activeCard && activeCard.contains(active))) return;
        focused = false;
        indicator.style.display = 'none';
        clearUnderlay(el);
      }, 150);
    });

    // FIX #2: marca que o usuário começou a digitar
    el.addEventListener('input', () => {
      hasUserTyped = true;
    }, { once: false });

    // FIX #1: ao clicar no indicator, garante que ele não some prematuramente
    indicator.addEventListener('mousedown', (e) => {
      e.preventDefault(); // evita que o campo perca foco antes do click ser processado
    });

    indicator.addEventListener('click', e => {
      e.stopPropagation();
      if (indicator._apiErrorMsg) { showApiErrorToast(indicator._apiErrorMsg); return; }
      const state = fieldMap.get(el);
      if (!state) return;
      openCard(indicator, el, state.errors, state.hints);
    });

    function cleanup() {
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      indicator.remove();
      removeUnderlay(el);
    }
    indicator._cleanup = cleanup;

    indicatorToField.set(indicator, el);
    return indicator;
  }

  function removeIndicator(el) {
    const state = fieldMap.get(el);
    if (state?.indicator?._cleanup) state.indicator._cleanup();
    else if (state?.indicator) state.indicator.remove();
    if (state?.aiBtn?._cleanup) state.aiBtn._cleanup();
    else if (state?.aiBtn) state.aiBtn.remove();
    removeUnderlay(el);
    fieldMap.delete(el);
  }

  /* ── Card de erros — FIX #3 (posicionamento) + #4 (tema) + #5 (fecha ao corrigir) + #9 (título) ── */
  function openCard(indicator, el, errors, hints) {
    closeCard(null);
    activeIndicator = indicator;
    const card = document.createElement('div');
    card.className = 'corretor-card';
    card.setAttribute('data-theme', SETTINGS.theme !== 'light' ? 'dark' : 'light');

    const text = getTextFrom(el);
    const wc   = wordCount(text);
    const cc   = charCount(text);
    const badges = [];
    if (errors.length) badges.push(`<span class="corretor-badge badge-error">${errors.length} erro${errors.length !== 1 ? 's' : ''}</span>`);
    if (hints.length)  badges.push(`<span class="corretor-badge badge-hint">${hints.length} dica${hints.length !== 1 ? 's' : ''}</span>`);

    const header = document.createElement('div');
    header.className = 'corretor-card-header';
    // FIX #9: Removido "By JRM" do card — agora só no popup/manifest
    header.innerHTML = `
      <div class="corretor-card-title"><span class="dot-red"></span> Corretor PT-BR</div>
      <div style="display:flex;align-items:center;gap:8px">
        ${badges.join('')}
        <button class="corretor-card-close" title="Fechar (Esc)">×</button>
      </div>`;
    card.appendChild(header);

    const counter = document.createElement('div');
    counter.className   = 'corretor-word-count';
    counter.textContent = `${wc} ${wc === 1 ? 'palavra' : 'palavras'} · ${cc} caracteres`;
    card.appendChild(counter);

    header.querySelector('.corretor-card-close').addEventListener('click', () => closeCard(el));

    let panelErrors, panelHints;
    if (errors.length && hints.length) {
      const tabs  = document.createElement('div');
      tabs.className = 'corretor-tabs';
      const tabErr  = document.createElement('button');
      tabErr.className   = 'corretor-tab active';
      tabErr.textContent  = `🔴 Erros (${errors.length})`;
      const tabHint = document.createElement('button');
      tabHint.className  = 'corretor-tab';
      tabHint.textContent = `💡 Dicas (${hints.length})`;
      tabs.appendChild(tabErr); tabs.appendChild(tabHint);
      card.appendChild(tabs);
      tabErr.addEventListener('click', () => {
        tabErr.classList.add('active'); tabHint.classList.remove('active');
        panelErrors.style.display = 'flex'; panelHints.style.display = 'none';
      });
      tabHint.addEventListener('click', () => {
        tabHint.classList.add('active'); tabErr.classList.remove('active');
        panelHints.style.display = 'flex'; panelErrors.style.display = 'none';
      });
    }
    if (errors.length) { panelErrors = buildPanel(el, errors, 'error'); card.appendChild(panelErrors); }
    if (hints.length)  { panelHints  = buildPanel(el, hints,  'hint');  if (errors.length) panelHints.style.display = 'none'; card.appendChild(panelHints); }

    if (!errors.length && !hints.length) {
      const empty = document.createElement('div');
      empty.className = 'corretor-panel';
      empty.style.padding = '20px';
      empty.style.textAlign = 'center';
      empty.style.color = '#94a3b8';
      empty.innerHTML = `
        <div style="font-size: 24px; margin-bottom: 10px;">✨</div>
        <div>Nenhum erro encontrado no texto analisado.</div>
      `;
      card.appendChild(empty);
    }

    document.body.appendChild(card);
    activeCard = card;
    // FIX #3: posicionamento mais próximo e previsível do dot
    positionCard(card, indicator, el);
    // FIX #4: animação de entrada
    card.style.transformOrigin = 'bottom right';
    setTimeout(() => document.addEventListener('click', outsideClickHandler), 50);
  }

  function buildPanel(el, matches, type) {
    const panel = document.createElement('div');
    panel.className = 'corretor-panel';

    if (type === 'error' && matches.filter(m => m.replacements?.length).length > 0) {
      const fixAllBtn = document.createElement('button');
      fixAllBtn.className  = 'corretor-fix-all-btn';
      fixAllBtn.innerHTML  = `<span>⚡</span> Corrigir tudo automaticamente`;
      let running = false;
      fixAllBtn.addEventListener('click', async () => {
        if (running) return;
        running = true;
        closeCard(el);
        await fixAll(el, matches);
        // FIX #5: card fecha automaticamente e re-analisa
      });
      panel.appendChild(fixAllBtn);
    }

    const div = document.createElement('div');
    div.className = 'corretor-divider';
    div.innerHTML = `<span>${type === 'error' ? 'Corrigir palavra por palavra' : 'Sugestões de melhoria'}</span>`;
    panel.appendChild(div);

    const list = document.createElement('div');
    list.className = 'corretor-errors-list';

    matches.forEach(match => {
      const text   = getTextFrom(el);
      const before = text.substring(Math.max(0, match.offset - 15), match.offset);
      const wrong  = text.substring(match.offset, match.offset + match.length);
      const after  = text.substring(match.offset + match.length, match.offset + match.length + 15);

      const item = document.createElement('div');
      item.className = `corretor-error-item${type === 'hint' ? ' hint-item' : ''}`;

      const hlClass = type === 'hint' ? 'highlight-hint' : 'highlight-error';
      const phrase  = document.createElement('div');
      phrase.className = 'corretor-error-phrase';
      phrase.innerHTML = `…${escapeHtml(before)}<strong class="${hlClass}">${escapeHtml(wrong)}</strong>${escapeHtml(after)}…`;

      const cat = document.createElement('div');
      cat.className   = 'corretor-category';
      cat.textContent = match.rule?.category?.name || match.rule?.issueType || '';

      const msg = document.createElement('div');
      msg.className   = 'corretor-error-message';
      msg.textContent = match.message;

      const suggs = document.createElement('div');
      suggs.className = 'corretor-suggestions';
      const reps  = (match.replacements || []).slice(0, 4);
      if (!reps.length) {
        const ns = document.createElement('span');
        ns.style.cssText = 'font-size:11px;color:#475569';
        ns.textContent   = 'Sem sugestões automáticas';
        suggs.appendChild(ns);
      } else {
        reps.forEach(rep => {
          const btn = document.createElement('button');
          btn.className   = `corretor-suggestion-btn${type === 'hint' ? ' hint-btn' : ''}`;
          btn.textContent  = rep.value;
          btn.addEventListener('click', async () => {
            const currentText  = getTextFrom(el);
            const currentWrong = currentText.substring(match.offset, match.offset + match.length);
            if (currentWrong !== wrong) {
              showToast('⚠ Texto foi alterado. Re-analisando…');
              const state = fieldMap.get(el);
              if (state) { state.lastText = ''; analyzeField(el); }
              return;
            }
            item.style.opacity       = '0.3';
            item.style.pointerEvents = 'none';
            await applySingleFix(el, match, rep.value);
            // FIX #5: fecha o card automaticamente após corrigir
            closeCard(el);
            const state = fieldMap.get(el);
            if (state) {
              clearTimeout(state.debounceTimer);
              state.debounceTimer = setTimeout(() => analyzeField(el), 800);
            }
          });
          suggs.appendChild(btn);
        });
      }

      const ignoreRow = document.createElement('div');
      ignoreRow.style.marginTop = '4px';
      const ignoreBtn = document.createElement('button');
      ignoreBtn.className   = 'corretor-ignore-btn';
      ignoreBtn.textContent = '🚫 Ignorar sempre';
      ignoreBtn.addEventListener('click', () => {
        addToIgnored(wrong);
        item.style.opacity       = '0.3';
        item.style.pointerEvents = 'none';
        showToast(`"${wrong}" adicionado ao dicionário!`);
        const state = fieldMap.get(el);
        if (state) { state.lastText = ''; setTimeout(() => analyzeField(el), 300); }
      });
      ignoreRow.appendChild(ignoreBtn);

      item.appendChild(phrase); item.appendChild(cat);
      item.appendChild(msg); item.appendChild(suggs); item.appendChild(ignoreRow);
      list.appendChild(item);
    });

    panel.appendChild(list);
    return panel;
  }

  /* FIX #3: Card posicionado logo acima/abaixo do dot, alinhado a ele */
  function positionCard(card, indicator, el) {
    // Força layout para medir o card
    card.style.visibility = 'hidden';
    card.style.display    = 'flex';

    const ir  = indicator.getBoundingClientRect();
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;
    const cw  = card.offsetWidth  || 340;
    const ch  = card.offsetHeight || 400;

    // Alinha o lado direito do card com o lado direito do dot
    let left = ir.right - cw;
    if (left < 8) left = 8;
    if (left + cw > vw - 8) left = vw - cw - 8;

    // Preferencialmente acima do dot
    let top = ir.top - ch - 8;
    if (top < 8) {
      // Se não couber acima, coloca abaixo
      top = ir.bottom + 8;
    }
    if (top + ch > vh - 8) top = vh - ch - 8;
    if (top < 8) top = 8;

    card.style.left       = left + 'px';
    card.style.top        = top  + 'px';
    card.style.visibility = '';
  }

  function outsideClickHandler(e) {
    if (activeCard && !activeCard.contains(e.target) && e.target !== activeIndicator) closeCard(null);
  }
  function closeCard(returnFocusTo) {
    if (activeCard) { activeCard.remove(); activeCard = null; }
    document.removeEventListener('click', outsideClickHandler);
    if (returnFocusTo) setTimeout(() => returnFocusTo.focus(), 50);
  }

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (activePreviewCard) { activePreviewCard.remove(); activePreviewCard = null; }
    else if (activeCard)   { closeCard(null); }
  });

  /* ── Correções — FIX #8: preserva formatação ── */
  async function fixAll(el, errors) {
    let text = getTextFrom(el);
    // Ordena do fim para o início para não deslocar offsets
    [...errors]
      .sort((a, b) => b.offset - a.offset)
      .forEach(err => {
        const rep = err.replacements?.[0]?.value;
        if (!rep) return;
        text = text.substring(0, err.offset) + rep + text.substring(err.offset + err.length);
      });
    // FIX #8: smartSetText agora preserva \n
    await smartSetText(el, text);
    showToast(`✓ ${errors.length} correção${errors.length !== 1 ? 'ões' : ''} aplicada${errors.length !== 1 ? 's' : ''}!`);
    const state = fieldMap.get(el);
    if (state) {
      state.errors   = [];
      state.lastText = text.trim();
      applyIndicatorState(state.indicator, getIndicatorState([], state.hints));
      clearUnderlay(el);
    }
  }

  async function applySingleFix(el, match, replacement) {
    let text = getTextFrom(el);
    text = text.substring(0, match.offset) + replacement + text.substring(match.offset + match.length);
    // FIX #8: preserva formatação ao aplicar correção individual
    await smartSetText(el, text);
    showToast(`✓ "${replacement}" aplicado!`);
  }

  /* ── Análise ── */
  async function analyzeField(el) {
    if (SETTINGS.silentMode) return;
    const state = fieldMap.get(el);
    if (!state) return;

    if (state.abortController) state.abortController.abort();
    state.abortController = new AbortController();

    const text = getTextFrom(el).trim();
    if (text === state.lastText) return;
    state.lastText = text;

    if (text.length < MIN_CHARS) {
      state.errors = []; state.hints = [];
      // FIX #2: só mostra loading se o usuário já digitou
      if (state._hasUserTyped) {
        applyIndicatorState(state.indicator, 'loading');
      }
      clearUnderlay(el);
      return;
    }

    applyIndicatorState(state.indicator, 'loading');
    const result = await checkText(text, state.abortController.signal);
    if (result === null) return;

    if (!fieldMap.has(el)) return;
    const { errors, hints, apiError } = result;
    if (apiError) { applyIndicatorState(state.indicator, 'api-error', apiError); return; }

    state.errors = errors;
    state.hints  = hints;
    applyIndicatorState(state.indicator, getIndicatorState(errors, hints));

    if (document.activeElement === el || isWhatsApp()) {
      drawUnderlines(el, errors, hints);
    }
  }

  /* ── Botão de IA ── */
  function createAIButton(el) {
    const btn = document.createElement('div');
    btn.className         = 'corretor-ai-btn';
    btn.title             = 'Melhorar texto com IA (Ctrl+Shift+Space)';
    btn.innerHTML         = ICON_STAR;
    btn.style.display     = 'none';
    btn.style.pointerEvents = 'none';
    btn.setAttribute('data-theme', SETTINGS.theme !== 'light' ? 'dark' : 'light');
    document.body.appendChild(btn);

    let focused = false;
    const onScroll = () => reposition();
    const onResize = () => reposition();

    function reposition() {
      if (!focused || !isInViewport(el) || !getActiveAI() || SETTINGS.silentMode) {
        btn.style.display = 'none'; return;
      }
      const r = el.getBoundingClientRect();
      const scrollExtra = hasVerticalScrollbar(el) ? 17 : 0;
      btn.style.left          = Math.max(0, r.right - DOT_SIZE - MARGIN_EDGE - scrollExtra - DOT_SIZE - 4) + 'px';
      btn.style.top           = Math.max(0, r.bottom - DOT_SIZE - MARGIN_BOTTOM) + 'px';
      btn.style.display       = 'flex';
      btn.style.pointerEvents = 'all';
    }

    el.addEventListener('focus', () => { focused = true; reposition(); });
    el.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement === btn || (activePreviewCard && activePreviewCard.contains(document.activeElement))) return;
        focused = false; btn.style.display = 'none';
      }, 150);
    });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize, { passive: true });

    btn.addEventListener('mousedown', (e) => e.preventDefault());

    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const active = getActiveAI();
      if (!active) { showToast('⚠ Configure uma IA no popup da extensão'); return; }
      const text = getTextFrom(el).trim();
      if (!text || text.length < 5) { showToast('⚠ Escreva algo primeiro'); return; }
      btn.classList.add('loading'); btn.innerHTML = ICON_SPIN;
      try {
        const result = await callAI(active.ai, active.key, text);
        if (result) openAIPreviewCard(btn, el, result, text, active.ai);
      } catch(err) { showToast(`⚠ ${err.message}`); }
      finally      { btn.classList.remove('loading'); btn.innerHTML = ICON_STAR; }
    });

    btn._cleanup = () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('resize', onResize);
      btn.remove();
    };

    return btn;
  }

  /* ── Card preview IA ── */
  function openAIPreviewCard(anchorBtn, el, result, originalText, aiName) {
    if (activePreviewCard) { activePreviewCard.remove(); activePreviewCard = null; }

    const aiLabel = aiName.charAt(0).toUpperCase() + aiName.slice(1);
    const card    = document.createElement('div');
    card.className = 'corretor-card corretor-ai-preview';
    card.setAttribute('data-theme', SETTINGS.theme !== 'light' ? 'dark' : 'light');

    const header = document.createElement('div');
    header.className = 'corretor-card-header';
    header.innerHTML = `
      <div class="corretor-card-title"><span style="font-size:14px">✨</span> Sugestão da IA</div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="corretor-badge badge-hint">${aiLabel}</span>
        <button class="corretor-card-close" title="Fechar (Esc)">×</button>
      </div>`;
    card.appendChild(header);

    const toneBar = document.createElement('div');
    toneBar.className = 'ai-tone-bar';
    toneBar.innerHTML = `
      <span class="ai-tone-label">Tom:</span>
      <button class="ai-tone-btn active" data-tone="default">Padrão</button>
      <button class="ai-tone-btn" data-tone="formal">Formal</button>
      <button class="ai-tone-btn" data-tone="direct">Direto</button>
      <button class="ai-tone-btn" data-tone="short">Resumido</button>`;
    card.appendChild(toneBar);

    const body    = document.createElement('div');
    body.className = 'ai-preview-body';
    const label   = document.createElement('div');
    label.className = 'ai-preview-label'; label.textContent = 'Como ficaria:';
    const textEl  = document.createElement('div');
    textEl.className = 'ai-preview-text'; textEl.textContent = result;
    const wc      = wordCount(result);
    const wcEl    = document.createElement('div');
    wcEl.className = 'ai-preview-wordcount';
    wcEl.textContent = `${wc} ${wc === 1 ? 'palavra' : 'palavras'} · ${charCount(result)} caracteres`;

    const actions   = document.createElement('div');
    actions.className = 'ai-preview-actions';
    const applyBtn  = document.createElement('button'); applyBtn.className = 'ai-preview-apply';  applyBtn.textContent = '✓ Substituir texto';
    const copyBtn   = document.createElement('button'); copyBtn.className  = 'ai-preview-copy';   copyBtn.textContent  = '⎘ Copiar';
    const histBtn   = document.createElement('button'); histBtn.className  = 'ai-preview-hist';   histBtn.title        = 'Ver histórico'; histBtn.textContent = '🕐';
    const cancelBtn = document.createElement('button'); cancelBtn.className = 'ai-preview-cancel'; cancelBtn.textContent = '✕';

    actions.append(applyBtn, copyBtn, histBtn, cancelBtn);
    body.append(label, textEl, wcEl, actions);
    card.appendChild(body);
    document.body.appendChild(card);
    activePreviewCard = card;

    // FIX #3: posiciona próximo ao botão de IA
    const br  = anchorBtn.getBoundingClientRect();
    const vw  = window.innerWidth;
    const cw  = card.offsetWidth || 340;
    const ch  = card.offsetHeight || 360;
    let left  = br.right - cw;
    if (left < 8) left = 8;
    if (left + cw > vw - 8) left = vw - cw - 8;
    let top = br.top - ch - 8;
    if (top < 8) top = br.bottom + 8;
    card.style.left = left + 'px'; card.style.top = top + 'px';

    const closePreview = () => { card.remove(); activePreviewCard = null; };
    header.querySelector('.corretor-card-close').addEventListener('click', closePreview);
    cancelBtn.addEventListener('click', closePreview);

    let currentResult = result;
    toneBar.addEventListener('click', async e => {
      const toneBtn = e.target.closest('.ai-tone-btn');
      if (!toneBtn) return;
      toneBar.querySelectorAll('.ai-tone-btn').forEach(b => b.classList.remove('active'));
      toneBtn.classList.add('active');
      const tone = toneBtn.dataset.tone;
      if (tone === 'default' && toneBtn.classList.contains('active')) return;
      textEl.style.opacity = '0.4'; label.textContent = 'Regenerando...';
      const active = getActiveAI(); if (!active) return;
      try {
        const newResult  = await callAI(active.ai, active.key, originalText, tone);
        currentResult    = newResult; textEl.textContent = newResult;
        const nwc        = wordCount(newResult);
        wcEl.textContent = `${nwc} ${nwc === 1 ? 'palavra' : 'palavras'} · ${charCount(newResult)} caracteres`;
      } catch(e) { showToast(`⚠ ${e.message}`); }
      finally { textEl.style.opacity = '1'; label.textContent = 'Como ficaria:'; }
    });

    applyBtn.addEventListener('click', async () => {
      closePreview();
      await smartSetText(el, currentResult);
      saveAIHistory(originalText, currentResult, aiName);
      showToast(`✓ Texto substituído!`);
      const state = fieldMap.get(el);
      if (state) { state.lastText = ''; setTimeout(() => analyzeField(el), 500); }
      el.focus();
    });

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(currentResult).then(() => showToast('✓ Copiado!')).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = currentResult; ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        showToast('✓ Copiado!');
      });
    });

    histBtn.addEventListener('click', () => openHistoryCard(card));

    setTimeout(() => {
      const outsideHandler = e => {
        if (activePreviewCard && !activePreviewCard.contains(e.target) && e.target !== anchorBtn) {
          closePreview(); document.removeEventListener('click', outsideHandler);
        }
      };
      document.addEventListener('click', outsideHandler);
    }, 50);
  }

  /* ── Card histórico IA ── */
  function openHistoryCard(anchorCard) {
    const existing = document.querySelector('.corretor-history-card');
    if (existing) { existing.remove(); return; }

    chrome.storage.local.get({ aiHistory: [] }, data => {
      const card = document.createElement('div');
      card.className = 'corretor-card corretor-history-card';
      card.setAttribute('data-theme', SETTINGS.theme !== 'light' ? 'dark' : 'light');

      if (!data.aiHistory.length) {
        card.innerHTML = `
          <div class="corretor-card-header">
            <div class="corretor-card-title">🕐 Histórico</div>
            <button class="corretor-card-close">×</button>
          </div>
          <div style="padding:24px 18px;text-align:center;color:#475569;font-size:12px">Nenhuma sugestão ainda.</div>`;
      } else {
        const listHtml = data.aiHistory.map((h, i) => {
          const date = new Date(h.date).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
          return `<div class="hist-item" data-index="${i}">
            <div class="hist-meta">${h.aiName} · ${date}</div>
            <div class="hist-text">${escapeHtml(h.result.substring(0, 120))}${h.result.length > 120 ? '…' : ''}</div>
            <button class="hist-copy" data-index="${i}">⎘ Copiar</button>
          </div>`;
        }).join('');
        card.innerHTML = `
          <div class="corretor-card-header">
            <div class="corretor-card-title">🕐 Histórico</div>
            <button class="corretor-card-close">×</button>
          </div>
          <div class="hist-list">${listHtml}</div>`;
        card.querySelectorAll('.hist-copy').forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            const h = data.aiHistory[btn.dataset.index];
            navigator.clipboard.writeText(h.result).catch(() => {});
            showToast('✓ Copiado do histórico!');
          });
        });
      }

      document.body.appendChild(card);
      const ar = anchorCard.getBoundingClientRect();
      card.style.left = (ar.left - 350) + 'px'; card.style.top = ar.top + 'px';
      if (parseFloat(card.style.left) < 8) { card.style.left = '8px'; card.style.top = (ar.bottom + 8) + 'px'; }
      card.querySelector('.corretor-card-close').addEventListener('click', () => card.remove());
      setTimeout(() => {
        const h = e => { if (!card.contains(e.target)) { card.remove(); document.removeEventListener('click', h); } };
        document.addEventListener('click', h);
      }, 50);
    });
  }

  /* ── Registro de campos — FIX #2 ── */
  function registerField(el) {
    if (fieldMap.has(el)) return;
    if (!isVisible(el)) return;
    if (shouldSkipField(el)) return;

    const indicator = createIndicator(el);
    const aiBtn     = createAIButton(el);
    const state     = { indicator, aiBtn, errors: [], hints: [], lastText: '', debounceTimer: null, abortController: null, _hasUserTyped: false };
    fieldMap.set(el, state);

    let debounceTimer = null;
    const debouncedAnalyze = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => analyzeField(el), DEBOUNCE_MS);
      state.debounceTimer = debounceTimer;
    };

    el.addEventListener('input', () => {
      // FIX #2: marca que o usuário digitou e mostra o dot
      state._hasUserTyped = true;
      indicator._hasUserTyped = true;
      // Garante que o dot aparece após o usuário começar a digitar
      if (!SETTINGS.silentMode && isInViewport(el) && document.activeElement === el) {
        indicator.style.display = 'flex';
        placeIndicator(indicator, el);
      }
      clearUnderlay(el);
      debouncedAnalyze();
    });
    el.addEventListener('paste', () => {
      // Marca que houve interação (paste = usuário colou) e dispara análise
      state._hasUserTyped = true;
      indicator._hasUserTyped = true;
      setTimeout(() => {
        if (!SETTINGS.silentMode && isInViewport(el)) {
          indicator.style.display = 'flex';
          placeIndicator(indicator, el);
        }
        debouncedAnalyze();
      }, 150);
    });

    el.addEventListener('focus', () => {
      const text = getTextFrom(el).trim();
      if (text.length >= MIN_CHARS && text !== state.lastText) debouncedAnalyze();
    });
  }

  /* ── Descoberta de campos ── */
  const FIELD_SELECTOR = 'input[type="text"], input:not([type]), textarea, [contenteditable="true"], [contenteditable=""]';

  function scanNodes(nodes) {
    if (SETTINGS.silentMode) return;
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.(FIELD_SELECTOR) && !node.readOnly && !node.disabled) {
        if (!node.closest?.('.corretor-card') && !node.classList?.contains('corretor-indicator')) registerField(node);
      }
      node.querySelectorAll?.(FIELD_SELECTOR).forEach(el => {
        if (el.readOnly || el.disabled) return;
        if (el.closest?.('.corretor-card') || el.classList?.contains('corretor-indicator')) return;
        registerField(el);
      });
    }
  }

  scanNodes([document.body]);
  new MutationObserver(mutations => {
    const added = mutations.flatMap(m => [...m.addedNodes]);
    if (added.length) scanNodes(added);
  }).observe(document.body, { childList: true, subtree: true });

  /* ── Atalho Ctrl+Shift+Space ── */
  document.addEventListener('keydown', async e => {
    if (!e.ctrlKey || !e.shiftKey || e.code !== 'Space') return;
    e.preventDefault();
    const active = getActiveAI();
    if (!active) { showToast('⚠ Configure uma IA no popup da extensão'); return; }
    const focused = document.activeElement;
    if (!focused || (!focused.isContentEditable && focused.tagName !== 'INPUT' && focused.tagName !== 'TEXTAREA')) {
      showToast('⚠ Clique em um campo de texto primeiro'); return;
    }
    const text = getTextFrom(focused).trim();
    if (!text || text.length < 5) { showToast('⚠ Escreva algo primeiro'); return; }
    showToast('✨ Processando...');
    try {
      const result = await callAI(active.ai, active.key, text);
      if (result) {
        const st  = fieldMap.get(focused);
        openAIPreviewCard(st?.aiBtn || focused, focused, result, text, active.ai);
      }
    } catch(err) { showToast(`⚠ ${err.message}`); }
  });

  /* ── Toasts ── */
  function showToast(msg) {
    let t = document.querySelector('.corretor-toast');
    if (!t) { t = document.createElement('div'); t.className = 'corretor-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2500);
  }
  function showApiErrorToast(msg) {
    let t = document.querySelector('.corretor-api-error-toast');
    if (!t) { t = document.createElement('div'); t.className = 'corretor-api-error-toast'; document.body.appendChild(t); }
    t.textContent = '⚠ ' + msg; t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 4000);
  }

})();
