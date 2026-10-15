FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-venv python3-pip ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
