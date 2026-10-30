ARG BUILD_FROM
FROM ${BUILD_FROM}

# Node.js + ffmpeg (converte o áudio em nota de voz) + git (uma dependência do WhatsApp vem do GitHub) + dados de idioma e fuso horário
RUN apk add --no-cache nodejs npm git icu-data-full tzdata ffmpeg

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src

ENV DADOS_DIR=/data \
    AUDIOS_DIR=/media/oracao \
    NODE_ENV=production

ENTRYPOINT []
CMD ["node", "/app/src/index.js"]
