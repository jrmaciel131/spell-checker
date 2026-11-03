# PT-BR Spell Checker — by jrmaciel13 · v13

> 🌐 [English](#-english) · [Português Brasil](#-português-brasil) · [Español](#-español) · [Português Portugal](#-português-portugal) · [Français](#-français)

---

## 🇺🇸 English

### What is it?
A Chrome extension that adds spell-checking and style correction to text fields on the web, using the free LanguageTool API.

### Features
- 🔴 **Red dot** when errors are detected — click to see suggestions
- 💡 **Purple dot** for style tips (can be turned off)
- 〰️ **Wavy underline** in any text field (Gmail, WhatsApp Web, `textarea`, `input`). It scrolls with the text and doesn't block clicks; click an underlined word to open its card.
- ⛔ **Ignore a whole rule** (grammar/style), not just a word — manage ignored rules in the popup
- 🖥 **Own LanguageTool server** (optional): by default the free public API is used; point to your own server for no limits
- 📊 **Usage counter** in the popup (requests in the last minute)
- ✨ **AI button** to rewrite with Gemini, Groq, Claude, ChatGPT or DeepSeek (one active at a time; the model is configurable). The preview highlights what changed.
- 📖 **Personal dictionary** of ignored words (synced with your Chrome account)
- ⏸ **Pause on this site** and 🔇 **silent mode**
- 🔒 Skips password, e-mail, card, CPF, login and one-time-code fields
- ☀️ **Light/dark theme**, 🌐 **interface in 6 languages**

### Installation
1. Download the `.zip` file and extract the folder
2. Open `chrome://extensions` in Chrome (version 105 or newer)
3. Enable **Developer mode** (top right corner)
4. Click **Load unpacked** and select the extracted folder

### Keyboard shortcut
`Ctrl + Shift + Space` opens the AI suggestion on the active field. You can change it at `chrome://extensions/shortcuts`.

### Own LanguageTool server (optional)
```bash
docker run -d -p 8081:8010 erikvl87/languagetool
```
In the popup, open **LanguageTool server**, enter `http://localhost:8081`, click **Test** and **Save and use**. Chrome asks for permission to access that address. **Back to the public API** undoes it.

### Privacy
- The text you type in checked fields is sent to the LanguageTool public API (or to your own server, if configured). Use **Pause on this site** for sensitive sites.
- AI keys are stored **only on this computer** (`chrome.storage.local`, not synced). They are sent only to the AI provider you choose.
- See [PRIVACY.md](PRIVACY.md).

---

## 🇧🇷 Português Brasil

### O que é?
Extensão do Chrome que adiciona correção ortográfica e de estilo em campos de texto da web, usando a API gratuita do LanguageTool.

### Recursos
- 🔴 **Ponto vermelho** ao detectar erros — clique para ver as sugestões
- 💡 **Ponto roxo** para dicas de estilo (pode ser desligado)
- 〰️ **Sublinhado ondulado** em qualquer campo de texto (Gmail, WhatsApp Web, `textarea`, `input`). Ele rola junto com o texto e não bloqueia cliques; clique numa palavra sublinhada para abrir o card dela.
- ⛔ **Ignorar uma regra inteira** (gramática/estilo), não só a palavra — dá para reativar no popup
- 🖥 **Servidor LanguageTool próprio** (opcional): por padrão usa a API pública gratuita; aponte para o seu servidor para não ter limite
- 📊 **Contador de uso** no popup (verificações no último minuto)
- ✨ **Botão de IA** para reescrever com Gemini, Groq, Claude, ChatGPT ou DeepSeek (uma ativa por vez; o modelo é configurável). A prévia destaca o que mudou.
- 📖 **Dicionário pessoal** de palavras ignoradas (sincronizado com a sua conta do Chrome)
- ⏸ **Pausar neste site** e 🔇 **modo silencioso**
- 🔒 Ignora campos de senha, e-mail, cartão, CPF, login e código de verificação
- ☀️ **Tema claro/escuro**, 🌐 **interface em 6 idiomas**

### Instalação
1. Baixe o arquivo `.zip` e extraia a pasta
2. Abra `chrome://extensions` no Chrome (versão 105 ou mais nova)
3. Ative o **Modo do desenvolvedor** (canto superior direito)
4. Clique em **Carregar sem compactação** e selecione a pasta extraída

### Atalho de teclado
`Ctrl + Shift + Space` abre a sugestão de IA no campo ativo. Dá para trocar em `chrome://extensions/shortcuts`.

### Servidor LanguageTool próprio (opcional)
```bash
docker run -d -p 8081:8010 erikvl87/languagetool
```
No popup, abra **Servidor LanguageTool**, digite `http://localhost:8081`, clique em **Testar** e em **Salvar e usar**. O Chrome pede permissão para acessar esse endereço. **Voltar para a API pública** desfaz.

### Privacidade
- O texto digitado nos campos verificados é enviado à API pública do LanguageTool (ou ao seu servidor, se configurado). Use **Pausar neste site** em sites sensíveis.
- As chaves de IA ficam **só neste computador** (`chrome.storage.local`, sem sincronizar). Elas são enviadas apenas ao provedor de IA que você escolher.
- Veja [PRIVACY.md](PRIVACY.md).

---

## 🇪🇸 Español

Extensión de Chrome que añade corrección ortográfica y de estilo a los campos de texto de la web, usando la API gratuita de LanguageTool.

- 🔴 Punto rojo con errores · 💡 punto morado con consejos de estilo
- 〰️ Subrayado ondulado en cualquier campo de texto (Gmail, WhatsApp Web, `textarea`, `input`)
- ⛔ Ignorar una regla entera · 🖥 servidor LanguageTool propio (opcional) · 📊 contador de uso
- ✨ Botón de IA (Gemini, Groq, Claude, ChatGPT, DeepSeek) · 📖 diccionario personal · ⏸ pausar en este sitio
- Instalación: `chrome://extensions` → **Modo desarrollador** → **Cargar descomprimida** (Chrome 105+)
- Atajo: `Ctrl + Shift + Space` (se puede cambiar en `chrome://extensions/shortcuts`)

---

## 🇵🇹 Português Portugal

Extensão do Chrome que adiciona correcção ortográfica e de estilo aos campos de texto da web, usando a API gratuita do LanguageTool.

- 🔴 Ponto vermelho com erros · 💡 ponto roxo com dicas de estilo
- 〰️ Sublinhado ondulado em qualquer campo de texto (Gmail, WhatsApp Web, `textarea`, `input`)
- ⛔ Ignorar uma regra inteira · 🖥 servidor LanguageTool próprio (opcional) · 📊 contador de uso
- ✨ Botão de IA (Gemini, Groq, Claude, ChatGPT, DeepSeek) · 📖 dicionário pessoal · ⏸ pausar neste site
- Instalação: `chrome://extensions` → **Modo de programador** → **Carregar sem compressão** (Chrome 105+)
- Atalho: `Ctrl + Shift + Space` (pode ser alterado em `chrome://extensions/shortcuts`)

---

## 🇫🇷 Français

Extension Chrome qui ajoute la correction orthographique et stylistique aux champs de texte du web, avec l'API gratuite de LanguageTool.

- 🔴 Point rouge en cas d'erreur · 💡 point violet pour les conseils de style
- 〰️ Soulignement ondulé dans tous les champs de texte (Gmail, WhatsApp Web, `textarea`, `input`)
- ⛔ Ignorer une règle entière · 🖥 serveur LanguageTool personnel (facultatif) · 📊 compteur d'utilisation
- ✨ Bouton IA (Gemini, Groq, Claude, ChatGPT, DeepSeek) · 📖 dictionnaire personnel · ⏸ pause sur ce site
- Installation : `chrome://extensions` → **Mode développeur** → **Charger l'extension non empaquetée** (Chrome 105+)
- Raccourci : `Ctrl + Shift + Space` (modifiable dans `chrome://extensions/shortcuts`)

---

## 📁 Files

| File | Description |
|---|---|
| `manifest.json` | Extension configuration (Manifest V3) |
| `background.js` | Service worker: all network calls (LanguageTool — public or own server — and AIs), rate limiting and usage counter, cache, data migration, keyboard shortcut |
| `content.js` | Checker in the page: field detection, underline (native highlight in rich editors, mirror layer in `textarea`/`input`), cards, fixes, AI preview with changes |
| `shared.js` | Code shared by content script, popup and service worker (dictionary and ignored rules, text batching, server URL, word diff, AI prompt) |
| `ui.css` | Styles for dots, cards and the `textarea`/`input` underline (loaded inside a Shadow DOM) |
| `highlight.css` | Underline style (`::highlight`) injected in the page |
| `popup.html` / `popup.js` | Popup interface |
| `i18n.js` | Interface translations |
| `tests/` | Unit tests (`node --test tests/shared.test.js`) and a manual test page (`tests/pagina-teste.html`) |
| `icons/` | Extension icons |

## 🧪 Development

```bash
node --test tests/shared.test.js
```

To test in the browser, load the extension and open `tests/pagina-teste.html`. To open it as a file, enable **Allow access to file URLs** for the extension in `chrome://extensions`.

---

## ⚠️ Powered by LanguageTool

This extension uses the [LanguageTool](https://languagetool.org) public API for spell and grammar checking.

- The free public API has usage limits (20 requests/IP/minute, ~20 KB per request) and no uptime guarantees. The extension spaces out requests, only resends the paragraphs that changed, and retries automatically after a limit error.
- Limits and behavior may change at any time without notice.
- For high-volume or commercial use, consider hosting [your own LanguageTool instance](https://dev.languagetool.org/http-server) or purchasing an [Enterprise plan](https://languagetool.org/enterprise).

---

*PT-BR Spell Checker · by [jrmaciel13](https://github.com/jrmaciel131) · v13*
