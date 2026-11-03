# Política de privacidade — Corretor Ortográfico PT-BR

*Última atualização: novembro de 2026 · versão 13*

## O que a extensão envia, e para onde

| Dado | Para onde vai | Quando |
|---|---|---|
| Texto digitado no campo em foco | API pública do [LanguageTool](https://languagetool.org/legal/privacy) (`api.languagetool.org`) ou, se você configurar, o **seu** servidor LanguageTool | Quando você para de digitar num campo verificado |
| Texto do campo | O provedor de IA que **você** ativou (Google Gemini, Groq, DeepSeek, OpenAI ou Anthropic) | Só quando você clica no botão ✨ ou usa o atalho |

A extensão não tem servidor próprio. Ela não coleta estatísticas, não usa rastreadores e não vende nem compartilha dados.

## O que **não** é verificado

- Campos de senha, e-mail, telefone, número, URL, busca e data
- Campos de cartão, CPF/CNPJ, login/usuário, token e código de verificação (detectados pelo tipo, `autocomplete` e nome do campo)
- Campos com o atributo `data-no-corretor`
- Sites que você pausou no popup (**Pausar neste site**), além do Google Docs

## O que fica guardado no seu navegador

| Dado | Onde | Sincroniza? |
|---|---|---|
| Preferências (idioma, tema, sites pausados, IA ativa e modelo, servidor LanguageTool) | `chrome.storage.sync` | Sim, com a sua conta do Chrome |
| Regras ignoradas | `chrome.storage.sync` | Sim |
| Dicionário de palavras ignoradas | `chrome.storage.sync` | Sim |
| Chaves de API das IAs | `chrome.storage.local` | **Não**, ficam só neste computador |
| Histórico das últimas 10 sugestões da IA | `chrome.storage.local` | Não |
| Horários das verificações do último minuto (para o contador de uso) | `chrome.storage.session` | Não; apagado ao fechar o Chrome |

Para apagar tudo, remova a extensão em `chrome://extensions`.

## Permissões

- `storage`: guardar as preferências acima
- `activeTab`: mostrar no popup o site atual, para o botão **Pausar neste site**
- Acesso aos domínios das APIs (LanguageTool e IAs): fazer as chamadas a partir do service worker da extensão
- Acesso opcional a outro endereço: só é pedido quando você configura um servidor LanguageTool próprio, e só para aquele endereço
- Script em todas as páginas: encontrar os campos de texto e mostrar o corretor
