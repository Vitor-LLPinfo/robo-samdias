# robo-samdias

Robô de primeiro contato e follow-up de leads da **Sam Dias Imóveis**.

## O que faz
A cada `intervaloMinutos`, dentro do horário comercial (`horarioInicio`–`horarioFim`, fuso `fusoHorario`):

1. Busca no **Apresenta.me** os negócios na etapa *Lead* (`stepLead`).
2. Envia a mensagem inicial por WhatsApp via **ClikChat** (`templates/mensagem_template.txt`), com o link do imóvel em samdias.com.br quando houver.
3. Move o negócio para *Follow-up* (`stepFollowUp`).
4. Sem resposta, envia `mensagem_tentativa2.txt`, `mensagem_tentativa3.txt` e por fim `mensagem_encerramento.txt`.
5. Se o cliente responder, move para *Atendimento* (`stepAtendimento`).

Os tokens do Apresenta.me (a cada 9 h) e do ClikChat (a cada 20 h) são renovados automaticamente.

## Estrutura
| Arquivo | Função |
|---|---|
| `robo.js` | O robô (Node.js, sem dependências externas) |
| `templates/*.txt` | Textos das mensagens. Variáveis: `{PROP_URL}`, `{NOME}` |
| `config.example.json` | Modelo de configuração — copie para `config.json` |
| `setup.sh` | Instalação como serviço systemd em VPS Linux (`/opt/robo-samdias`) |

Gerados em execução (não versionados): `config.json`, `robo_log.csv` (log de envios), `robo_processados.json` (estado por negócio).

## Rodar localmente
```bash
cp config.example.json config.json   # preencher credenciais e IDs das etapas
node robo.js
```

## Instalar em VPS (Linux)
```bash
bash setup.sh
sudo journalctl -u robo-samdias -f   # logs
```

> ⚠️ `config.json` contém senhas — nunca faça commit dele.

## Rodar no Azure (Container App Job)
A imagem `ghcr.io/vitor-llpinfo/robo-samdias:latest` é gerada pela GitHub Action `.github/workflows/imagem.yml` a cada push na `main`.
No container o robô roda **um ciclo e encerra** (`RUN_ONCE=1`); o agendamento é do Container App Job.

Configuração por variáveis de ambiente (senhas como *secrets* do job):

| Variável | Corresponde a |
|---|---|
| `APRESENTAME_EMAIL`, `APRESENTAME_PASSWORD` | `apresentame.email` / `password` |
| `APRESENTAME_COMPANY_ID` | `apresentame.companyId` |
| `APRESENTAME_STEP_LEAD`, `APRESENTAME_STEP_FOLLOWUP`, `APRESENTAME_STEP_ATENDIMENTO` | IDs das etapas do funil |
| `CLIKCHAT_EMAIL`, `CLIKCHAT_PASSWORD`, `CLIKCHAT_WHATSAPP_ID` | `clikchat.*` |
| `HORARIO_INICIO`, `HORARIO_FIM`, `FUSO_HORARIO` | horário comercial (padrão 8–18, -3) |
| `STATE_BLOB_URL` | URL do blob de estado, ex.: `https://samdiasarquivos.blob.core.windows.net/robo-samdias/estado.json` |

O estado é lido/gravado no blob com a **identidade gerenciada** do job (papel *Storage Blob Data Contributor* no container `robo-samdias`) — sem chaves.
Se o blob não puder ser lido, o ciclo é abortado para não reenviar mensagens.
