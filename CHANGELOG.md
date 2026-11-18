# Changelog

## [Não publicado]
### Container App Job
- Configuração por variáveis de ambiente (`config.json` passa a ser opcional) com validação na partida.
- Modo `RUN_ONCE=1`: um ciclo por execução, código de saída 1 em caso de falha.
- Estado em Azure Blob via identidade gerenciada (`STATE_BLOB_URL`).
- `Dockerfile` e GitHub Action que publica a imagem no GHCR.
- Timeout de 60 s nas chamadas HTTP e leitura correta de respostas UTF-8 em vários pedaços.

### Adicionado
- `.gitignore` para `config.json`, `robo_log.csv` e `robo_processados.json`.
- `config.example.json` com todas as chaves usadas por `robo.js`.
- README com funcionamento, estrutura e instalação.

### Corrigido
- Mensagens movidas para `templates/`, caminho esperado por `robo.js` e `setup.sh`.
- `setup.sh` cria `config.json` a partir do exemplo quando ele não existe.
