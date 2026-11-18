FROM node:20-alpine
WORKDIR /app
RUN chown node:node /app
COPY --chown=node:node robo.js ./
COPY --chown=node:node templates/ ./templates/
USER node
# Modo Container App Job: um ciclo por execução; o agendamento fica no Azure.
ENV RUN_ONCE=1 NODE_ENV=production
CMD ["node", "robo.js"]
