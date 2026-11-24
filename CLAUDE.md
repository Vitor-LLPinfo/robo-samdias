# CLAUDE.md — robo-samdias

## Visão geral
Robô de primeiro contato e follow-up de leads da **Sam Dias Imóveis**: lê negócios no **Apresenta.me** e manda WhatsApp pelo **ClikChat**.
- Etapa *Lead* → mensagem inicial (`templates/mensagem_template.txt`, com link do imóvel em samdias.com.br) → move para *Follow-up*.
- Sem resposta: tentativa 2 (≥24 h), tentativa 3 (≥48 h), encerramento (≥72 h); após ≥96 h marca o negócio como `lost` no Apresenta.me.
- Cliente respondeu → move para *Atendimento*. Lead fora do horário comercial fica `pendente` e é enviado no próximo ciclo em horário.
- Stack: **Node.js 20 puro** (só módulos nativos, sem `package.json`/dependências). Tudo em `robo.js`.
- Repo **público** `Vitor-LLPinfo/robo-samdias` — nunca commitar segredos, `config.json`, logs ou estado.

## Estrutura
| Arquivo | Função |
|---|---|
| `robo.js` | Robô inteiro: config, estado, APIs Apresenta.me/ClikChat, ciclo |
| `templates/*.txt` | Textos das mensagens; variáveis `{PROP_URL}`, `{NOME}` |
| `config.example.json` | Modelo do `config.json` (uso local/VPS) |
| `setup.sh` | Instalação legada como serviço systemd em VPS (`/opt/robo-samdias`) |
| `Dockerfile` | `node:20-alpine`, usuário `node`, `RUN_ONCE=1` |
| `.github/workflows/imagem.yml` | Build/push da imagem no GHCR |
| `CHANGELOG.md` | Seção `[Não publicado]` — registrar cada mudança |

Gerados em execução (no `.gitignore`): `config.json`, `robo_log.csv`, `robo_processados.json`, `.env`.

## Configuração (só nomes — valores nunca no repo)
Variáveis de ambiente têm prioridade sobre `config.json`; a partida aborta (exit 1) se faltar obrigatória.
- Obrigatórias: `APRESENTAME_EMAIL`, `APRESENTAME_PASSWORD`, `APRESENTAME_STEP_LEAD`, `APRESENTAME_STEP_FOLLOWUP`, `APRESENTAME_STEP_ATENDIMENTO`, `CLIKCHAT_EMAIL`, `CLIKCHAT_PASSWORD`, `CLIKCHAT_WHATSAPP_ID`.
- Opcionais: `APRESENTAME_COMPANY_ID`, `APRESENTAME_BASE_URL`, `HORARIO_INICIO`/`HORARIO_FIM`/`FUSO_HORARIO` (padrão 8–18, -3), `INTERVALO_MINUTOS` (15).
- Execução: `RUN_ONCE=1` (um ciclo e sai; exit 1 se o ciclo falhar), `STATE_BLOB_URL` (estado no Blob).
- No Azure: `IDENTITY_ENDPOINT`/`IDENTITY_HEADER` são injetadas pela identidade gerenciada. Senhas são *secrets* do job.

## Como rodar/testar
- **Não há testes automatizados nem modo dry-run.** Qualquer execução com credenciais reais envia WhatsApp a clientes e move/perde negócios no Apresenta.me.
- O Claude **não executa o robô** (nem local, nem `az containerapp job start`). Verificação segura: `node --check robo.js`, leitura de código e `docker build .` (sem rodar o container).
- Local (só o usuário, conscientemente): `cp config.example.json config.json`, preencher, `node robo.js` (loop contínuo) ou `RUN_ONCE=1 node robo.js`. Sem `STATE_BLOB_URL` o estado vai para `robo_processados.json`.
- Sem estado, leads já contatados seriam reprocessados — por isso, com `STATE_BLOB_URL`, falha na leitura do blob aborta o ciclo.

## Deploy
- Push na `main` (ou `workflow_dispatch`) → Action publica `ghcr.io/vitor-llpinfo/robo-samdias:latest` e `:<sha>`.
- Azure: Container App Job `robo-samdias`, RG `rg-samdias-prod`, ambiente `samdias-env-br`, gatilho **Manual** hoje.
- Estado: blob `samdiasarquivos/robo-samdias/estado.json` via identidade gerenciada (papel *Storage Blob Data Contributor* no container `robo-samdias`) — sem chaves de storage.
- Agendamento previsto: cron `*/15 11-20 * * *` (UTC = 8h–17h45 BRT) — **só após execução manual de teste aprovada pelo usuário**.
- `setup.sh`/systemd é o caminho antigo (VPS); o alvo atual é o Container App Job.

## Regras de trabalho
- Fluxo: alterar → linha no `CHANGELOG.md` → commit descritivo → **pedir aprovação** → push. Nada de push/merge sem aprovação.
- Branches de trabalho viram PR para `main` (ex.: `container-azure`, já mergeado no PR #1); push na `main` publica a imagem.
- **Segredos**: o próprio usuário grava no Cloud Shell (`read -s` + `az containerapp job secret set`). O Claude nunca digita, lê de volta ou registra senhas/tokens, e não altera nada no Azure sem pedido explícito.
- Manter o robô sem dependências externas e com mensagens/logs em português.
- Mudar textos de mensagem = editar `templates/*.txt` (afeta clientes reais — confirmar com o usuário).

## Estado atual / bloqueios
- Código, imagem e Job no Azure prontos (modo Manual).
- **BLOQUEADO**: faltam os logins do Apresenta.me e do ClikChat (e conferir IDs das etapas e `CLIKCHAT_WHATSAPP_ID`).
- Próximos passos: usuário grava os secrets → execução manual de teste acompanhada → aprovação → trocar para agendamento.
