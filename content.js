(() => {
  'use strict';

  // Evita rodar duas vezes no mesmo frame
  if (globalThis.__corretorPtBrLoaded) return;
  globalThis.__corretorPtBrLoaded = true;

  const S = globalThis.CorretorShared;
  if (!S) return;

  const DEBOUNCE_MS    = 800;
  const MIN_CHARS      = 4;
  const RETRY_MIN_MS   = 5000;
  const MAX_CARD_ITEMS = 60;
  const DOT_SIZE       = 24;
  const DOT_GAP        = 4;
  const ERROR_TYPES    = new Set(['misspelling', 'grammar', 'typographical', 'duplication', 'whitespace', 'non-conformance']);
  const CODE_EDITORS   = '.CodeMirror, .cm-editor, .monaco-editor, .ace_editor';

  // Mesmo conteúdo de highlight.css — usado em campos dentro de Shadow DOM, onde o CSS da página não chega
  const HIGHLIGHT_CSS = `
    ::highlight(corretor-error) { text-decoration: underline wavy rgba(239,68,68,0.95); text-decoration-thickness: 1.5px; text-underline-offset: 3px; background-color: rgba(239,68,68,0.10); }
    ::highlight(corretor-hint)  { text-decoration: underline wavy rgba(168,85,247,0.95); text-decoration-thickness: 1.5px; text-underline-offset: 3px; background-color: rgba(168,85,247,0.08); }`;

  /* ══ Configurações ══ */
  const settings = {
    language: 'pt-BR', picky: true, silentMode: false, theme: 'dark', uiLang: '',
    disabledSites: [], aiSettings: {}, ignoredRules: [], ltServer: '',
  };
  let ignored = new Set();
  let ignoredRuleIds = new Set();
  let T = getT(settings.uiLang);

  const ready = (async () => {
    try {
      Object.assign(settings, await chrome.storage.sync.get({ ...settings }));
      T = getT(settings.uiLang);
      ignored = toIgnoredSet(await S.loadDictionary());
      ignoredRuleIds = S.ruleIdSet(settings.ignoredRules);
    } catch { /* contexto da extensão invalidado */ }
  })();

  function toIgnoredSet(words) { return new Set(words.map(w => w.toLowerCase())); }

  function pageHost() {
    if (location.hostname) return location.hostname;
    try { return new URL(location.ancestorOrigins?.[0] || '').hostname; } catch { return ''; }
  }

  function isEnabled() {
    return !settings.silentMode && !S.isHostDisabled(pageHost(), settings.disabledSites);
  }

  let dictReloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let recheck = false;
    for (const k of ['language', 'picky', 'ltServer']) {
      if (changes[k]) { settings[k] = changes[k].newValue; recheck = true; }
    }
    if (changes.ignoredRules) {
      settings.ignoredRules = changes.ignoredRules.newValue || [];
      ignoredRuleIds = S.ruleIdSet(settings.ignoredRules);
      if (current) refilter(current);
    }
    if (changes.silentMode)    settings.silentMode    = !!changes.silentMode.newValue;
    if (changes.disabledSites) settings.disabledSites = changes.disabledSites.newValue || [];
    if (changes.aiSettings)    settings.aiSettings    = changes.aiSettings.newValue || {};
    if (changes.theme)         { settings.theme = changes.theme.newValue; applyTheme(); }
    if (changes.uiLang)        { settings.uiLang = changes.uiLang.newValue; T = getT(settings.uiLang); if (ui) ui.aiBtn.title = T.cAiBtnTitle; }
    if (S.isDictionaryChange(changes)) {
      clearTimeout(dictReloadTimer);
      dictReloadTimer = setTimeout(async () => {
        try { ignored = toIgnoredSet(await S.loadDictionary()); } catch { return; }
        if (current) refilter(current);
      }, 200);
    }
    if (!isEnabled()) { detach(); return; }
    if (recheck && current) forceRecheck(current, 0);
    schedulePosition();
  });

  /* ══ Utilidades ══ */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function h(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
  function themeAttr() { return settings.theme === 'light' ? 'light' : 'dark'; }
  function sameText(a, b) { return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim(); }

  async function send(msg) {
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r || { ok: false, error: { code: 'unknown' } };
    } catch (e) {
      const m = String(e?.message || e);
      return { ok: false, error: { code: /context invalidated/i.test(m) ? 'context' : 'unknown', message: m } };
    }
  }

  function errorText(err = {}) {
    switch (err.code) {
      case 'rate':         return T.cErrRate;
      case 'unavailable':  return T.cErrUnavailable;
      case 'network':      return T.cErrNetwork;
      case 'too-long':     return T.cErrTooLong;
      case 'http':         return T.cErrHttp(err.status);
      case 'context':      return T.cErrContext;
      case 'server-unreachable': return T.cErrServerUnreachable;
      case 'server-permission':  return T.cErrServerPermission;
      case 'no-ai':        return T.cConfigureAI;
      case 'ai-too-long':  return T.cErrAiTooLong(err.max || S.AI_MAX_CHARS);
      case 'ai-truncated': return T.cErrAiTruncated;
      case 'ai-empty':     return T.cErrAiEmpty;
      case 'ai-http':      return err.message || T.cErrUnknown;
      default:             return T.cErrUnknown;
    }
  }

  /* ══ Texto do campo ══
     Para contenteditable, montamos o texto e, ao mesmo tempo, o mapa texto → nós do DOM.
     O texto enviado ao LanguageTool é exatamente este, então os offsets batem com o DOM
     (antes era innerText, que conta quebras de linha que o mapa não contava). */
  const BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN',
    'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

  function buildTextModel(root) {
    let text = '';
    const segs = [];
    const breakLine = () => { if (text && !text.endsWith('\n')) text += '\n'; };
    (function walk(node) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === Node.TEXT_NODE) {
          const v = child.nodeValue;
          if (!v) continue;
          segs.push({ node: child, start: text.length, end: text.length + v.length });
          text += v;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tag = child.tagName;
          if (tag === 'BR') { text += '\n'; continue; }
          if (SKIP_TAGS.has(tag)) continue;
          const block = BLOCK_TAGS.has(tag);
          if (block) breakLine();
          walk(child);
          if (block) breakLine();
        }
      }
    })(root);
    return { text, segs };
  }

  function getFieldText(el) {
    return el.isContentEditable ? buildTextModel(el).text : (el.value || '');
  }

  function positionAt(model, offset, isEnd) {
    const segs = model.segs;
    let lo = 0, hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segs[mid];
      if (offset < s.start) hi = mid - 1;
      else if (offset > s.end || (offset === s.end && !isEnd)) lo = mid + 1;
      else return { node: s.node, offset: offset - s.start };
    }
    return null;
  }

  function rangeFor(model, offset, length) {
    const a = positionAt(model, offset, false);
    const b = positionAt(model, offset + length, true);
    if (!a || !b) return null;
    try {
      const r = document.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      return r;
    } catch { return null; }
  }

  /* ══ Sublinhado: CSS Custom Highlight API ══
     O próprio navegador pinta o sublinhado no texto. Ele rola junto, é cortado na borda da caixa,
     acompanha mudanças de layout e não bloqueia cliques. */
  const HL = (() => {
    try {
      if (!CSS.highlights || typeof Highlight !== 'function') return null;
      const error = new Highlight();
      const hint  = new Highlight();
      error.priority = 1;
      CSS.highlights.set('corretor-error', error);
      CSS.highlights.set('corretor-hint', hint);
      return { error, hint };
    } catch { return null; }
  })();

  const styledRoots = new WeakSet();
  function ensureHighlightStyle(el) {
    const root = el.getRootNode();
    if (!(root instanceof ShadowRoot) || styledRoots.has(root)) return;
    styledRoots.add(root);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(HIGHLIGHT_CSS);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    } catch { /* sem sublinhado neste campo */ }
  }

  const rangeOf = new WeakMap(); // match → Range vivo (acompanha edições no DOM)

  function clearHighlights() {
    if (HL) { HL.error.clear(); HL.hint.clear(); }
    hideMirror();
  }

  function renderHighlights(el) {
    clearHighlights();
    if (el !== current) return;
    if (!el.isContentEditable) { renderMirror(el); return; }
    if (!HL) return;
    const st = getState(el);
    const model = buildTextModel(el);
    const unchanged = model.text === st.text;
    for (const m of [...st.errors, ...st.hints]) {
      const off = unchanged ? m.offset : S.relocate(model.text, m.wrong, m.offset, 200);
      if (off < 0) continue;
      const r = rangeFor(model, off, m.length);
      if (!r) continue;
      rangeOf.set(m, r);
      (ERROR_TYPES.has(m.issueType) ? HL.error : HL.hint).add(r);
    }
  }

  /* ══ Sublinhado em textarea/input: camada espelho ══
     Esses campos não deixam marcar o texto por dentro. Desenhamos uma cópia transparente do texto,
     com os mesmos estilos e a mesma rolagem, por cima do campo; só o sublinhado fica visível.
     A camada não recebe cliques, então o campo continua funcionando normalmente. */
  const MIRROR_PROPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize',
    'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch', 'fontKerning', 'fontFeatureSettings', 'lineHeight',
    'letterSpacing', 'wordSpacing', 'textTransform', 'textIndent', 'textAlign', 'direction', 'tabSize', 'wordBreak'];
  let mirror = null;      // { clip, box }
  let mirrorSpans = [];   // [{ off, len, m }] posições atuais dos erros no valor do campo

  function ensureMirror() {
    const u = ensureUI();
    if (mirror && mirror.clip.isConnected) return mirror;
    const clip = h('div', 'corretor-mirror-clip');
    const box  = h('div', 'corretor-mirror');
    clip.appendChild(box);
    u.root.insertBefore(clip, u.indicator); // abaixo do ponto e dos cards
    mirror = { clip, box };
    return mirror;
  }

  function hideMirror() {
    mirrorSpans = [];
    if (!mirror) return;
    mirror.clip.style.display = 'none';
    mirror.box.textContent = '';
  }

  function renderMirror(el) {
    hideMirror();
    const st = getState(el);
    const marks = [...st.errors, ...st.hints];
    if (!marks.length) return;
    const text = el.value || '';
    const unchanged = text === st.text;
    const spans = [];
    for (const m of marks) {
      const off = unchanged ? m.offset : S.relocate(text, m.wrong, m.offset, 200);
      if (off >= 0) spans.push({ off, len: m.length, m });
    }
    if (!spans.length) return;
    spans.sort((a, b) => a.off - b.off);

    const { box } = ensureMirror();
    let pos = 0;
    for (const s of spans) {
      if (s.off < pos) continue;
      if (s.off > pos) box.appendChild(document.createTextNode(text.slice(pos, s.off)));
      const hint = !ERROR_TYPES.has(s.m.issueType);
      box.appendChild(h('span', hint ? 'corretor-mark-hint' : 'corretor-mark-error', text.substr(s.off, s.len)));
      pos = s.off + s.len;
      mirrorSpans.push(s);
    }
    box.appendChild(document.createTextNode(text.slice(pos) + '​')); // mantém a altura da última linha vazia

    const cs = getComputedStyle(el);
    for (const p of MIRROR_PROPS) box.style[p] = cs[p];
    if (el.tagName === 'INPUT') {
      // input: uma linha, centralizada na vertical
      const contentH = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      box.style.whiteSpace   = 'pre';
      box.style.overflowWrap = 'normal';
      box.style.lineHeight   = contentH + 'px';
    } else {
      box.style.whiteSpace   = 'pre-wrap';
      box.style.overflowWrap = 'break-word';
    }
    syncMirror(el);
  }

  // Acompanha posição, tamanho e rolagem do campo (chamado a cada quadro de scroll/resize)
  function syncMirror(el) {
    if (!mirror || !mirrorSpans.length || el.isContentEditable) return;
    const vr = visibleRect(el);
    if (!vr) { mirror.clip.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    const { clip, box } = mirror;
    clip.style.display = 'block';
    clip.style.left    = vr.left + 'px';
    clip.style.top     = vr.top + 'px';
    clip.style.width   = (vr.right - vr.left) + 'px';
    clip.style.height  = (vr.bottom - vr.top) + 'px';
    box.style.left     = (r.left + el.clientLeft - vr.left) + 'px';
    box.style.top      = (r.top + el.clientTop - vr.top) + 'px';
    box.style.width    = el.clientWidth + 'px';
    box.style.height   = el.clientHeight + 'px';
    box.scrollTop      = el.scrollTop;
    box.scrollLeft     = el.scrollLeft;
  }

  // Durante a digitação, tira só os sublinhados cujo trecho foi editado
  function pruneStaleHighlights(el) {
    if (!el.isContentEditable) { renderMirror(el); return; }
    if (!HL) return;
    const st = getState(el);
    for (const m of [...st.errors, ...st.hints]) {
      const r = rangeOf.get(m);
      if (r && (r.collapsed || r.toString() !== m.wrong)) {
        HL.error.delete(r); HL.hint.delete(r); rangeOf.delete(m);
      }
    }
  }

  /* ══ Estado por campo ══ */
  const states = new WeakMap();
  function getState(el) {
    let st = states.get(el);
    if (!st) {
      st = { gen: 0, lastKey: null, text: '', matches: [], errors: [], hints: [], status: 'ok',
             apiError: null, typed: false, debounce: null, retry: null };
      states.set(el, st);
    }
    return st;
  }

  let current = null;       // campo focado
  let clipAncestors = [];   // ancestrais com overflow que recortam o campo

  /* ══ Descoberta de campos (delegação de foco, sem varrer a página) ══ */
  function resolveField(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.tagName;
    if (tag === 'TEXTAREA') return node;
    if (tag === 'INPUT') return (node.type || 'text').toLowerCase() === 'text' ? node : null;
    if (node.isContentEditable) {
      let host = node;
      while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
      return host;
    }
    return null;
  }

  function isEligible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.closest('[data-no-corretor]') || el.closest(CODE_EDITORS)) return false;
    return !S.isSensitiveField({
      tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'), id: el.id,
      autocomplete: el.getAttribute('autocomplete'), inputmode: el.getAttribute('inputmode'),
    });
  }

  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function isFieldFocused(el) {
    const a = el.getRootNode().activeElement;
    return !!a && (a === el || el.contains(a));
  }

  function isOwnUI(e) {
    return !!ui && e.composedPath().includes(ui.host);
  }

  function computeClipAncestors(el) {
    const list = [];
    let node = el.parentElement || el.getRootNode().host;
    for (let depth = 0; node && node !== document.documentElement && depth < 40; depth++) {
      const cs = getComputedStyle(node);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') list.push(node);
      node = node.parentElement || (node.getRootNode() instanceof ShadowRoot ? node.getRootNode().host : null);
    }
    return list;
  }

  const resizeObs = new ResizeObserver(() => schedulePosition());

  function attach(el) {
    if (current === el) { schedulePosition(); return; }
    detach();
    current = el;
    clipAncestors = computeClipAncestors(el);
    ensureHighlightStyle(el);
    resizeObs.observe(el);
    renderHighlights(el);
    if (getFieldText(el).trim().length >= MIN_CHARS) scheduleCheck(el, 300);
    schedulePosition();
  }

  function detach() {
    if (!current) return;
    const st = states.get(current);
    if (st) { clearTimeout(st.debounce); clearTimeout(st.retry); }
    resizeObs.unobserve(current);
    clearHighlights();
    closeAllCards();
    current = null;
    clipAncestors = [];
    hideUI();
  }

  async function onFocusIn(e) {
    if (isOwnUI(e)) return;
    const field = resolveField(e.composedPath()[0]);
    if (!field) return;
    await ready;
    if (!isEnabled() || !isEligible(field)) return;
    attach(field);
  }

  function onFocusOut(e) {
    if (!current || !e.composedPath().includes(current)) return;
    const el = current;
    setTimeout(() => {
      if (current !== el || isFieldFocused(el) || anyCardOpen()) return;
      detach();
    }, 150);
  }

  function onInput(e) {
    if (isOwnUI(e)) return;
    const path = e.composedPath();
    if (!current || !path.includes(current)) {
      const f = resolveField(path[0]);
      if (!f || !isEnabled() || !isEligible(f)) return;
      attach(f);
    }
    const st = getState(current);
    st.typed = true;
    pruneStaleHighlights(current);
    scheduleCheck(current);
    schedulePosition();
  }

  // Clique numa palavra sublinhada abre o card daquele erro (sem impedir o cursor de ir para lá)
  function onDocClick(e) {
    if (!current || isOwnUI(e) || !e.composedPath().includes(current)) return;
    if (!current.isContentEditable) {
      // textarea/input: o cursor já foi para o ponto clicado; vê se caiu dentro de um erro
      const el = current;
      setTimeout(() => {
        if (el !== current || el.selectionStart !== el.selectionEnd) return;
        const pos = el.selectionStart;
        const hit = mirrorSpans.find(s => pos > s.off && pos < s.off + s.len);
        if (hit) openErrorsCard(el, hit.m);
      }, 0);
      return;
    }
    if (!HL) return;
    const st = getState(current);
    const root = current.getRootNode();
    let pos = null;
    try {
      if (document.caretPositionFromPoint) {
        const p = root instanceof ShadowRoot
          ? document.caretPositionFromPoint(e.clientX, e.clientY, { shadowRoots: [root] })
          : document.caretPositionFromPoint(e.clientX, e.clientY);
        if (p) pos = { node: p.offsetNode, offset: p.offset };
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(e.clientX, e.clientY);
        if (r) pos = { node: r.startContainer, offset: r.startOffset };
      }
    } catch { return; }
    if (!pos) return;
    const hit = [...st.errors, ...st.hints].find(m => {
      const r = rangeOf.get(m);
      try { return r && !r.collapsed && r.isPointInRange(pos.node, pos.offset); } catch { return false; }
    });
    if (hit) openErrorsCard(current, hit);
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape' || !anyCardOpen()) return;
    // Fecha só o nosso card, sem fechar junto o que o site trata com Esc
    e.stopPropagation();
    e.preventDefault();
    closeTopCard();
  }

  function onDocMouseDown(e) {
    if (!anyCardOpen() || isOwnUI(e)) return;
    closeAllCards();
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousedown', onDocMouseDown, true);
  window.addEventListener('scroll', () => schedulePosition(), { capture: true, passive: true });
  window.addEventListener('resize', () => schedulePosition(), { passive: true });

  // Campo que já estava focado antes do script carregar (autofocus)
  ready.then(() => {
    const f = resolveField(deepActiveElement());
    if (f && isEnabled() && isEligible(f)) attach(f);
  });

  /* ══ Análise ══ */
  function scheduleCheck(el, delay = DEBOUNCE_MS) {
    const st = getState(el);
    clearTimeout(st.debounce);
    st.debounce = setTimeout(() => analyze(el), delay);
  }

  function forceRecheck(el, delay = 300) {
    getState(el).lastKey = null;
    scheduleCheck(el, delay);
  }

  async function analyze(el) {
    if (el !== current || !isEnabled()) return;
    const st = getState(el);
    clearTimeout(st.retry);

    const text = getFieldText(el);
    const key  = `${settings.language}|${settings.picky ? 1 : 0}|${text}`;
    if (key === st.lastKey) return;
    st.lastKey = key;
    const gen = ++st.gen;

    if (text.trim().length < MIN_CHARS) {
      st.text = text; st.matches = []; st.apiError = null;
      refilter(el);
      return;
    }

    setStatus(el, 'loading');
    const res = await send({ type: 'lt-check', text, language: settings.language, picky: !!settings.picky });
    if (gen !== st.gen) return; // chegou uma análise mais nova

    if (!res.ok) {
      st.lastKey  = null; // permite tentar de novo com o mesmo texto
      st.apiError = errorText(res.error);
      setStatus(el, 'api-error');
      if (!['context', 'too-long', 'server-permission'].includes(res.error.code)) {
        st.retry = setTimeout(() => analyze(el), Math.max(RETRY_MIN_MS, res.error.retryAfterMs || 15000));
      }
      return;
    }

    st.apiError = null;
    st.text     = text;
    st.matches  = res.matches.map(m => ({ ...m, wrong: text.substr(m.offset, m.length) }));
    refilter(el);
  }

  // Aplica dicionário e opção de dicas sem nova requisição
  function refilter(el) {
    const st = getState(el);
    const visible = st.matches.filter(m => !ignored.has(m.wrong.toLowerCase()) && !ignoredRuleIds.has(m.ruleId));
    st.errors = visible.filter(m => ERROR_TYPES.has(m.issueType));
    st.hints  = settings.picky ? visible.filter(m => !ERROR_TYPES.has(m.issueType)) : [];
    if (!st.apiError) setStatus(el, st.errors.length ? 'error' : st.hints.length ? 'hint' : 'ok');
    renderHighlights(el);
    if (cards.errors && cards.errors.el === el) openErrorsCard(el);
  }

  /* ══ Interface (Shadow DOM: o CSS do site não afeta a extensão e vice-versa) ══ */
  const ICONS = {
    ok:          `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 5L4 7.5L8.5 2.5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    loading:     `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 1h6M2 9h6M3 1v2.2L5 5l-2 1.8V9M7 1v2.2L5 5l2 1.8V9" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error:       `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2L8 8M8 2L2 8" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    hint:        `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 1C3.6 1 2.5 2.1 2.5 3.5c0 .9.47 1.68 1.18 2.14V7h2.64V5.64C7.03 5.18 7.5 4.4 7.5 3.5 7.5 2.1 6.4 1 5 1z" stroke="white" stroke-width="1.2" stroke-linejoin="round"/><path d="M3.8 8h2.4M4.2 9h1.6" stroke="white" stroke-width="1.2" stroke-linecap="round"/></svg>`,
    'api-error': `<svg viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 2v4" stroke="white" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="8" r="0.9" fill="white"/></svg>`,
  };
  const ICON_STAR = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 2L12.5 7.5H18L13.5 11L15.5 17L10 13.5L4.5 17L6.5 11L2 7.5H7.5L10 2Z" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  const ICON_SPIN = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7" stroke="white" stroke-width="1.8" stroke-dasharray="22" stroke-dashoffset="8"><animateTransform attributeName="transform" type="rotate" from="0 10 10" to="360 10 10" dur="0.8s" repeatCount="indefinite"/></circle></svg>`;

  let ui = null;

  function isScrollbarClick(e) {
    const t = e.composedPath()[0];
    return t instanceof Element && t.clientWidth > 0 && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight);
  }

  function ensureUI() {
    if (ui && ui.host.isConnected) return ui;
    if (ui) { document.documentElement.appendChild(ui.host); return ui; }
    const host = document.createElement('corretor-ptbr-ui');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    try { link.href = chrome.runtime.getURL('ui.css'); } catch { /* extensão recarregada */ }
    root.appendChild(link);

    const indicator = h('div', 'corretor-indicator ok');
    const aiBtn     = h('div', 'corretor-ai-btn');
    const toastEl   = h('div', 'corretor-toast');
    const errToast  = h('div', 'corretor-api-error-toast');
    indicator.style.display = 'none';
    aiBtn.style.display     = 'none';
    aiBtn.innerHTML = ICON_STAR;
    aiBtn.title     = T.cAiBtnTitle;
    root.append(indicator, aiBtn, toastEl, errToast);

    // Clicar na interface não tira o foco do campo
    root.addEventListener('mousedown', e => { if (!isScrollbarClick(e)) e.preventDefault(); });
    indicator.addEventListener('click', onIndicatorClick);
    aiBtn.addEventListener('click', () => { if (current) runAI(current); });

    document.documentElement.appendChild(host);
    ui = { host, root, indicator, aiBtn, toastEl, errToast };
    applyTheme();
    return ui;
  }

  function applyTheme() {
    if (!ui) return;
    ui.root.querySelectorAll('.corretor-indicator, .corretor-ai-btn, .corretor-card').forEach(n => n.setAttribute('data-theme', themeAttr()));
  }

  function hideUI() {
    if (!ui) return;
    ui.indicator.style.display = 'none';
    ui.aiBtn.style.display     = 'none';
  }

  function setStatus(el, status) {
    const st = getState(el);
    st.status = status;
    if (el !== current || !ui) { schedulePosition(); return; }
    ui.indicator.className = `corretor-indicator ${status}`;
    ui.indicator.setAttribute('data-theme', themeAttr());
    ui.indicator.innerHTML = ICONS[status] || ICONS.ok;
    schedulePosition();
  }

  function setAILoading(on) {
    if (!ui) return;
    ui.aiBtn.classList.toggle('loading', on);
    ui.aiBtn.innerHTML = on ? ICON_SPIN : ICON_STAR;
  }

  // Parte do campo realmente visível (recortada pela janela e pelas caixas com rolagem)
  function visibleRect(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    let left = Math.max(r.left, 0), top = Math.max(r.top, 0);
    let right = Math.min(r.right, window.innerWidth), bottom = Math.min(r.bottom, window.innerHeight);
    for (const a of clipAncestors) {
      const ar = a.getBoundingClientRect();
      left = Math.max(left, ar.left); top = Math.max(top, ar.top);
      right = Math.min(right, ar.right); bottom = Math.min(bottom, ar.bottom);
    }
    if (right - left < 4 || bottom - top < 4) return null;
    return { left, top, right, bottom };
  }

  let rafPending = false;
  function schedulePosition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; positionUI(); });
  }

  function positionUI() {
    const el = current;
    if (!el) { hideUI(); return; }
    if (!el.isConnected) { detach(); return; }
    const st = getState(el);
    syncMirror(el);
    const vr = visibleRect(el);
    const showDot = !!vr && (st.typed || st.errors.length > 0 || st.hints.length > 0 || st.status === 'api-error');
    const showAI  = !!vr && !!S.activeProvider(settings.aiSettings);
    if (!showDot && !showAI) { hideUI(); return; }
    const u = ensureUI();

    const scrollbar = el.scrollHeight > el.clientHeight + 2 ? Math.min(20, el.offsetWidth - el.clientWidth) : 0;
    const x = Math.max(vr.left, vr.right - DOT_SIZE - DOT_GAP - scrollbar);
    const y = Math.max(vr.top, vr.bottom - DOT_SIZE - DOT_GAP);

    if (showDot) {
      if (!u.indicator.classList.contains(st.status)) setStatus(el, st.status);
      u.indicator.style.left    = x + 'px';
      u.indicator.style.top     = y + 'px';
      u.indicator.style.display = 'flex';
    } else {
      u.indicator.style.display = 'none';
    }
    if (showAI) {
      u.aiBtn.style.left    = Math.max(0, (showDot ? x - DOT_SIZE - DOT_GAP : x)) + 'px';
      u.aiBtn.style.top     = y + 'px';
      u.aiBtn.style.display = 'flex';
    } else {
      u.aiBtn.style.display = 'none';
    }
    repositionCards();
  }

  function onIndicatorClick() {
    if (!current) return;
    const st = getState(current);
    if (st.status === 'api-error' && st.apiError) { errorToast(st.apiError); return; }
    openErrorsCard(current);
  }

  /* ══ Toasts ══ */
  function toast(msg) {
    const u = ensureUI();
    u.toastEl.textContent = msg;
    u.toastEl.classList.add('show');
    clearTimeout(u.toastEl._timer);
    u.toastEl._timer = setTimeout(() => u.toastEl.classList.remove('show'), 2500);
  }
  function errorToast(msg) {
    const u = ensureUI();
    u.errToast.textContent = '⚠ ' + msg;
    u.errToast.classList.add('show');
    clearTimeout(u.errToast._timer);
    u.errToast._timer = setTimeout(() => u.errToast.classList.remove('show'), 4500);
  }

  /* ══ Cards ══ */
  const cards = { errors: null, preview: null, history: null }; // { node, el, anchor }

  function anyCardOpen() { return !!(cards.errors || cards.preview || cards.history); }

  function closeCard(name) {
    const c = cards[name];
    if (c) { c.node.remove(); cards[name] = null; }
  }
  function closeAllCards() { closeCard('history'); closeCard('preview'); closeCard('errors'); }
  function closeTopCard() {
    if (cards.history) closeCard('history');
    else if (cards.preview) closeCard('preview');
    else closeCard('errors');
    detachIfIdle();
  }
  // O campo perdeu o foco enquanto um card estava aberto: ao fechar o último card, solta o campo
  function detachIfIdle() {
    setTimeout(() => { if (current && !anyCardOpen() && !isFieldFocused(current)) detach(); }, 0);
  }

  function newCard(extraClass) {
    const card = h('div', 'corretor-card' + (extraClass ? ' ' + extraClass : ''));
    card.setAttribute('data-theme', themeAttr());
    return card;
  }

  function cardHeader(titleHtml, badgesHtml, onClose) {
    const header = h('div', 'corretor-card-header');
    header.innerHTML = `
      <div class="corretor-card-title">${titleHtml}</div>
      <div class="corretor-card-actions">${badgesHtml || ''}<button class="corretor-card-close" title="${escapeHtml(T.cClose)}">×</button></div>`;
    header.querySelector('.corretor-card-close').addEventListener('click', () => { onClose(); detachIfIdle(); });
    return header;
  }

  // Posiciona o card acima (ou abaixo) do ponto de ancoragem, alinhado à direita
  function placeCard(card, anchorRect) {
    card.style.visibility = 'hidden';
    const vw = window.innerWidth, vh = window.innerHeight;
    const cw = card.offsetWidth || 340, ch = card.offsetHeight || 400;
    let left = anchorRect.right - cw;
    left = Math.min(Math.max(8, left), vw - cw - 8);
    let top = anchorRect.top - ch - 8;
    if (top < 8) top = anchorRect.bottom + 8;
    if (top + ch > vh - 8) top = vh - ch - 8;
    card.style.left = Math.max(8, left) + 'px';
    card.style.top  = Math.max(8, top) + 'px';
    card.style.visibility = '';
  }

  function anchorRectFor(name) {
    if (!ui) return null;
    const btn = name === 'preview' ? ui.aiBtn : ui.indicator;
    if (btn.style.display !== 'none') return btn.getBoundingClientRect();
    if (current) {
      const vr = visibleRect(current);
      if (vr) return { left: vr.right - 1, right: vr.right, top: vr.bottom - 1, bottom: vr.bottom };
    }
    return null;
  }

  function repositionCards() {
    for (const name of ['errors', 'preview']) {
      const c = cards[name];
      if (!c) continue;
      const r = anchorRectFor(name);
      if (r) placeCard(c.node, r);
    }
  }

  function openErrorsCard(el, focusMatch) {
    const st = getState(el);
    const prevScroll = cards.errors?.node.querySelector('.corretor-errors-list')?.scrollTop || 0;
    closeCard('errors');
    closeCard('history');
    closeCard('preview');
    const u = ensureUI();
    const card = newCard();
    const { errors, hints } = st;

    const badges = [];
    if (errors.length) badges.push(`<span class="corretor-badge badge-error">${escapeHtml(T.cErrors(errors.length))}</span>`);
    if (hints.length)  badges.push(`<span class="corretor-badge badge-hint">${escapeHtml(T.cHints(hints.length))}</span>`);
    card.appendChild(cardHeader(`<span class="dot-red"></span> ${escapeHtml(T.appName)}`, badges.join(''), () => closeCard('errors')));

    const text = getFieldText(el);
    const wc   = S.wordCount(text);
    card.appendChild(h('div', 'corretor-word-count', `${T.words(wc)} · ${T.cChars(text.length)}`));

    let panelErrors = null, panelHints = null;
    const showHintsFirst = focusMatch && !ERROR_TYPES.has(focusMatch.issueType);
    if (errors.length && hints.length) {
      const tabs    = h('div', 'corretor-tabs');
      const tabErr  = h('button', 'corretor-tab' + (showHintsFirst ? '' : ' active'), T.cTabErrors(errors.length));
      const tabHint = h('button', 'corretor-tab' + (showHintsFirst ? ' active' : ''), T.cTabHints(hints.length));
      tabs.append(tabErr, tabHint);
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
    if (errors.length) { panelErrors = buildPanel(el, errors, 'error', focusMatch); card.appendChild(panelErrors); }
    if (hints.length) {
      panelHints = buildPanel(el, hints, 'hint', focusMatch);
      if (errors.length) panelHints.style.display = showHintsFirst ? 'flex' : 'none';
      if (errors.length && showHintsFirst) panelErrors.style.display = 'none';
      card.appendChild(panelHints);
    }
    if (!errors.length && !hints.length) {
      const empty = h('div', 'corretor-panel corretor-empty');
      empty.innerHTML = `<div class="corretor-empty-icon">✨</div><div>${escapeHtml(T.cNoErrors)}</div>`;
      card.appendChild(empty);
    }

    u.root.appendChild(card);
    cards.errors = { node: card, el };
    const r = anchorRectFor('errors');
    if (r) placeCard(card, r);

    const focused = card.querySelector('.corretor-error-item.focused');
    if (focused) focused.scrollIntoView({ block: 'nearest' });
    else { const list = card.querySelector('.corretor-errors-list'); if (list) list.scrollTop = prevScroll; }
  }

  function buildPanel(el, matches, type, focusMatch) {
    const st = getState(el);
    const panel = h('div', 'corretor-panel');

    if (type === 'error' && matches.some(m => m.replacements.length)) {
      const fixAllBtn = h('button', 'corretor-fix-all-btn');
      fixAllBtn.innerHTML = `<span>⚡</span> ${escapeHtml(T.cFixAll)}`;
      fixAllBtn.addEventListener('click', () => fixAll(el, matches), { once: true });
      panel.appendChild(fixAllBtn);
    }

    const div = h('div', 'corretor-divider');
    div.appendChild(h('span', null, type === 'error' ? T.cFixEach : T.cSuggestions));
    panel.appendChild(div);

    const list = h('div', 'corretor-errors-list');
    matches.slice(0, MAX_CARD_ITEMS).forEach(match => {
      const before = st.text.substring(Math.max(0, match.offset - 15), match.offset);
      const after  = st.text.substring(match.offset + match.length, match.offset + match.length + 15);

      const item = h('div', `corretor-error-item${type === 'hint' ? ' hint-item' : ''}${match === focusMatch ? ' focused' : ''}`);
      const phrase = h('div', 'corretor-error-phrase');
      phrase.innerHTML = `…${escapeHtml(before)}<strong class="${type === 'hint' ? 'highlight-hint' : 'highlight-error'}">${escapeHtml(match.wrong)}</strong>${escapeHtml(after)}…`;

      const suggs = h('div', 'corretor-suggestions');
      const reps  = match.replacements.slice(0, 4);
      if (!reps.length) {
        suggs.appendChild(h('span', 'corretor-no-suggestions', T.cNoSuggestions));
      } else {
        reps.forEach(rep => {
          const btn = h('button', `corretor-suggestion-btn${type === 'hint' ? ' hint-btn' : ''}`, rep);
          btn.addEventListener('click', () => applySuggestion(el, match, rep), { once: true });
          suggs.appendChild(btn);
        });
      }

      const ignoreRow = h('div', 'corretor-ignore-row');
      const ignoreBtn = h('button', 'corretor-ignore-btn', T.cIgnore);
      ignoreBtn.addEventListener('click', () => ignoreWord(match.wrong, item), { once: true });
      ignoreRow.appendChild(ignoreBtn);
      // Regra inteira: só para gramática/estilo (desligar a regra de ortografia desligaria tudo)
      if (match.ruleId && match.issueType !== 'misspelling') {
        const ruleBtn = h('button', 'corretor-ignore-btn', T.cIgnoreRule);
        ruleBtn.title = match.ruleId;
        ruleBtn.addEventListener('click', () => ignoreRule(match, item), { once: true });
        ignoreRow.appendChild(ruleBtn);
      }

      item.append(phrase, h('div', 'corretor-category', match.category || match.issueType),
        h('div', 'corretor-error-message', match.message), suggs, ignoreRow);
      list.appendChild(item);
    });
    if (matches.length > MAX_CARD_ITEMS) list.appendChild(h('div', 'corretor-more', T.cMoreItems(matches.length - MAX_CARD_ITEMS)));

    panel.appendChild(list);
    return panel;
  }

  /* ══ Correções ══ */
  function replaceInInput(el, start, len, value) {
    el.focus({ preventScroll: true });
    const before = el.value;
    el.setSelectionRange(start, start + len);
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch { /* fallback */ }
    // execCommand mantém o desfazer (Ctrl+Z) e avisa React/Vue; se não funcionou, troca direto
    if (!ok || el.value === before) {
      if (el.value !== before) return;
      el.setRangeText(value, start, start + len, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  // Troca só o trecho do erro (preserva negrito, links, menções e a posição do cursor)
  function replaceRangeCE(el, range, value) {
    el.focus({ preventScroll: true });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch { /* fallback */ }
    if (ok) return true;
    try {
      range.deleteContents();
      range.insertNode(document.createTextNode(value));
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      return true;
    } catch { return false; }
  }

  function replaceMatch(el, m, value) {
    if (el.isContentEditable) {
      const live = rangeOf.get(m);
      let range = live && !live.collapsed && live.toString() === m.wrong ? live.cloneRange() : null;
      if (!range) {
        const model = buildTextModel(el);
        const off = S.relocate(model.text, m.wrong, m.offset);
        if (off < 0) return false;
        range = rangeFor(model, off, m.length);
      }
      return !!range && replaceRangeCE(el, range, value);
    }
    const off = S.relocate(el.value, m.wrong, m.offset);
    if (off < 0) return false;
    replaceInInput(el, off, m.length, value);
    return true;
  }

  async function applySuggestion(el, m, value) {
    closeCard('errors');
    if (!replaceMatch(el, m, value)) {
      toast(T.cTextChanged);
      forceRecheck(el);
      return;
    }
    toast(T.cFixApplied(value));
    forceRecheck(el, 400);
  }

  async function fixAll(el, matches) {
    closeCard('errors');
    // Do fim para o início: corrigir um erro não desloca os anteriores
    const edits = S.nonOverlappingDesc(matches
      .filter(m => m.replacements.length)
      .map(m => ({ m, offset: m.offset, length: m.length, value: m.replacements[0] })));
    let applied = 0;
    for (const e of edits) {
      if (replaceMatch(el, e.m, e.value)) applied++;
      await sleep(16); // editores como Lexical/ProseMirror atualizam o DOM de forma assíncrona
    }
    toast(applied ? T.cFixesApplied(applied) : T.cTextChanged);
    forceRecheck(el, 400);
  }

  async function ignoreWord(word, item) {
    item.style.opacity = '0.3';
    item.style.pointerEvents = 'none';
    ignored.add(word.toLowerCase());
    if (current) refilter(current); // efeito imediato, sem esperar o storage
    try {
      await S.addWordToDictionary(word);
      toast(T.cIgnored(word));
    } catch {
      errorToast(T.cDictFull);
    }
  }

  async function ignoreRule(match, item) {
    item.style.opacity = '0.3';
    item.style.pointerEvents = 'none';
    ignoredRuleIds.add(match.ruleId);
    if (current) refilter(current);
    const name = match.message || match.category || match.ruleId;
    try {
      const { ignoredRules = [] } = await chrome.storage.sync.get({ ignoredRules: [] });
      await chrome.storage.sync.set({ ignoredRules: S.addIgnoredRule(ignoredRules, { id: match.ruleId, name }) });
      toast(T.cRuleIgnored);
    } catch {
      errorToast(T.cDictFull);
    }
  }

  // Substitui o texto inteiro (IA)
  async function replaceAll(el, value) {
    el.focus({ preventScroll: true });
    if (!el.isContentEditable) { replaceInInput(el, 0, el.value.length, value); return; }

    const selectAll = () => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    };
    const before = getFieldText(el);

    // 1) Colar: editores ricos (Lexical/WhatsApp, Draft, Slate, ProseMirror) tratam o paste mantendo as quebras de linha
    selectAll();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', value);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
      el.dispatchEvent(ev);
      if (ev.defaultPrevented) {
        await sleep(60);
        if (!sameText(getFieldText(el), before)) return;
      }
    } catch { /* segue */ }

    // 2) insertText (campos contenteditable simples)
    selectAll();
    let ok = false;
    try { ok = document.execCommand('insertText', false, value); } catch { /* segue */ }
    if (ok) return;

    // 3) Último recurso
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
  }

  /* ══ IA ══ */
  async function runAI(el) {
    if (!S.activeProvider(settings.aiSettings)) { toast(T.cConfigureAI); return; }
    const text = getFieldText(el);
    if (text.trim().length < MIN_CHARS) { toast(T.cWriteFirst); return; }
    if (ui?.aiBtn.classList.contains('loading')) return;
    setAILoading(true);
    if (!ui || ui.aiBtn.style.display === 'none') toast(T.cProcessing);
    const res = await send({ type: 'ai-improve', text, tone: 'default' });
    setAILoading(false);
    if (!res.ok) { errorToast(errorText(res.error)); return; }
    if (current !== el) return;
    openPreviewCard(el, text, res.text, res.provider);
  }

  function saveAIHistory(original, result, aiName) {
    chrome.storage.local.get({ aiHistory: [] }, data => {
      const entry = { original, result, aiName, date: Date.now() };
      chrome.storage.local.set({ aiHistory: [entry, ...(data.aiHistory || [])].slice(0, 10) });
    });
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* fallback */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.documentElement.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    current?.focus({ preventScroll: true });
  }

  function openPreviewCard(el, originalText, result, provider) {
    closeCard('preview');
    closeCard('history');
    closeCard('errors');
    const u = ensureUI();
    const label = S.AI_PROVIDERS[provider]?.label || provider;
    const card  = newCard('corretor-ai-preview');

    card.appendChild(cardHeader(`<span class="corretor-ai-spark">✨</span> ${escapeHtml(T.cAiSuggestion)}`,
      `<span class="corretor-badge badge-hint">${escapeHtml(label)}</span>`, () => closeCard('preview')));

    const toneBar = h('div', 'ai-tone-bar');
    toneBar.appendChild(h('span', 'ai-tone-label', T.cTone));
    const tones = [['default', T.cToneDefault], ['formal', T.cToneFormal], ['direct', T.cToneDirect], ['short', T.cToneShort]];
    for (const [tone, name] of tones) {
      const b = h('button', 'ai-tone-btn' + (tone === 'default' ? ' active' : ''), name);
      b.dataset.tone = tone;
      toneBar.appendChild(b);
    }
    card.appendChild(toneBar);

    const body    = h('div', 'ai-preview-body');
    const labelRow = h('div', 'ai-preview-label-row');
    const labelEl  = h('div', 'ai-preview-label', T.cPreview);
    const viewBar  = h('div', 'ai-view-bar');
    const viewDiff = h('button', 'ai-view-btn active', T.cShowChanges);
    const viewFull = h('button', 'ai-view-btn', T.cShowFinal);
    viewBar.append(viewDiff, viewFull);
    labelRow.append(labelEl, viewBar);
    const textEl  = h('div', 'ai-preview-text');
    const wcEl    = h('div', 'ai-preview-wordcount');
    let showDiff  = true;
    let shownText = result;

    // Mostra o que a IA mudou: riscado o que saiu, em verde o que entrou
    const renderPreview = () => {
      const parts = showDiff ? S.wordDiff(originalText, shownText) : null;
      viewDiff.classList.toggle('active', showDiff);
      viewFull.classList.toggle('active', !showDiff);
      textEl.textContent = '';
      if (!parts) { textEl.textContent = shownText; return; }
      for (const p of parts) {
        if (p.type === 'same') textEl.appendChild(document.createTextNode(p.text));
        else textEl.appendChild(h(p.type === 'add' ? 'ins' : 'del', p.type === 'add' ? 'diff-add' : 'diff-del', p.text));
      }
    };
    const setResult = r => {
      shownText = r;
      wcEl.textContent = `${T.words(S.wordCount(r))} · ${T.cChars(r.length)}`;
      renderPreview();
    };
    viewDiff.addEventListener('click', () => { showDiff = true; renderPreview(); });
    viewFull.addEventListener('click', () => { showDiff = false; renderPreview(); });
    setResult(result);

    const actions   = h('div', 'ai-preview-actions');
    const applyBtn  = h('button', 'ai-preview-apply', T.cReplace);
    const copyBtn   = h('button', 'ai-preview-copy', T.cCopy);
    const histBtn   = h('button', 'ai-preview-hist', '🕐');
    const cancelBtn = h('button', 'ai-preview-cancel', '✕');
    histBtn.title = T.cHistory;
    actions.append(applyBtn, copyBtn, histBtn, cancelBtn);
    body.append(labelRow, textEl, wcEl, actions);
    card.appendChild(body);

    u.root.appendChild(card);
    cards.preview = { node: card, el };
    const r = anchorRectFor('preview');
    if (r) placeCard(card, r);

    const results = { default: result };
    let currentResult = result;
    let currentTone   = 'default';
    let requestId     = 0;

    toneBar.addEventListener('click', async e => {
      const btn = e.target.closest('.ai-tone-btn');
      if (!btn || btn.dataset.tone === currentTone) return;
      const tone = btn.dataset.tone;
      currentTone = tone;
      toneBar.querySelectorAll('.ai-tone-btn').forEach(b => b.classList.toggle('active', b === btn));
      if (results[tone]) { currentResult = results[tone]; setResult(currentResult); return; }

      const id = ++requestId; // descarta respostas de cliques anteriores
      textEl.style.opacity = '0.4';
      labelEl.textContent  = T.cRegenerating;
      applyBtn.disabled    = true;
      const res = await send({ type: 'ai-improve', text: originalText, tone });
      if (id !== requestId || cards.preview?.node !== card) return;
      textEl.style.opacity = '1';
      labelEl.textContent  = T.cPreview;
      applyBtn.disabled    = false;
      if (!res.ok) { errorToast(errorText(res.error)); return; }
      results[tone] = res.text;
      if (currentTone === tone) { currentResult = res.text; setResult(currentResult); }
    });

    applyBtn.addEventListener('click', async () => {
      closeCard('preview');
      await replaceAll(el, currentResult);
      saveAIHistory(originalText, currentResult, provider);
      toast(T.cReplaced);
      forceRecheck(el, 500);
    });
    copyBtn.addEventListener('click', async () => { await copyText(currentResult); toast(T.cCopied); });
    histBtn.addEventListener('click', () => openHistoryCard(card));
    cancelBtn.addEventListener('click', () => closeCard('preview'));
  }

  function openHistoryCard(anchorCard) {
    if (cards.history) { closeCard('history'); return; }
    chrome.storage.local.get({ aiHistory: [] }, data => {
      const u = ensureUI();
      const history = data.aiHistory || [];
      const card = newCard('corretor-history-card');
      card.appendChild(cardHeader(escapeHtml(T.cHistTitle), '', () => closeCard('history')));

      if (!history.length) {
        card.appendChild(h('div', 'hist-empty', T.cHistEmpty));
      } else {
        const list = h('div', 'hist-list');
        history.forEach(entry => {
          const date = new Date(entry.date).toLocaleString(navigator.language, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const item = h('div', 'hist-item');
          const res  = String(entry.result || '');
          item.append(
            h('div', 'hist-meta', `${S.AI_PROVIDERS[entry.aiName]?.label || entry.aiName} · ${date}`),
            h('div', 'hist-text', res.substring(0, 120) + (res.length > 120 ? '…' : '')),
          );
          const copy = h('button', 'hist-copy', T.cCopy);
          copy.addEventListener('click', async () => { await copyText(res); toast(T.cCopiedHist); });
          item.appendChild(copy);
          list.appendChild(item);
        });
        card.appendChild(list);
      }

      u.root.appendChild(card);
      cards.history = { node: card };
      const ar = anchorCard.getBoundingClientRect();
      let left = ar.left - card.offsetWidth - 8;
      let top  = ar.top;
      if (left < 8) { left = Math.min(ar.left, window.innerWidth - card.offsetWidth - 8); top = ar.bottom + 8; }
      if (top + card.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - card.offsetHeight - 8);
      card.style.left = Math.max(8, left) + 'px';
      card.style.top  = Math.max(8, top) + 'px';
    });
  }

  /* ══ Atalho de teclado (chrome.commands, via service worker) ══ */
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'command-ai-improve' || !document.hasFocus()) return;
    const active = document.activeElement;
    if (active && (active.tagName === 'IFRAME' || active.tagName === 'FRAME')) return; // o frame interno responde
    (async () => {
      await ready;
      if (!isEnabled()) return;
      if (!current) {
        const f = resolveField(deepActiveElement());
        if (f && isEligible(f)) attach(f);
      }
      if (!current) { toast(T.cClickField); return; }
      runAI(current);
    })();
  });
})();
