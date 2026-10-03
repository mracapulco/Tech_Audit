# API do Tech Audit: portal (/api) e agentes (/v1).

# Instaladores do agente (MSI do Windows; .deb e .rpm do Linux), oferecidos
# para download no portal. O código
# vem de agent/ (additional_contexts "agent" no docker-compose.yml).
FROM golang:1.24-bookworm AS agent-exe
WORKDIR /src
COPY --from=agent go.mod go.sum ./
RUN go mod download
COPY --from=agent . .
RUN VERSION=$(tr -d '\r\n ' < VERSION) && \
    GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/techaudit-agent.exe ./cmd/agent

# wixl do Ubuntu 24.04 (0.103) monta as telas do assistente.
FROM ubuntu:24.04 AS agent-msi
RUN apt-get update && apt-get install -y --no-install-recommends wixl msitools && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY --from=agent VERSION ./
COPY --from=agent installer ./installer
COPY --from=agent-exe /out/techaudit-agent.exe /out/
RUN sed -i 's/\r$//' installer/build-msi.sh && VERSION=$(tr -d '\r\n ' < VERSION) && mkdir -p /downloads && \
    sh installer/build-msi.sh "$VERSION" /out/techaudit-agent.exe "/downloads/TechAuditAgent-$VERSION.msi"

# Pacotes do agente Linux (.deb e .rpm, x86-64), também oferecidos no portal.
FROM golang:1.24-bookworm AS agent-linux
WORKDIR /src
RUN go install github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.42.1
COPY --from=agent go.mod go.sum ./
RUN go mod download
COPY --from=agent . .
RUN sed -i 's/\r$//' packaging/linux/* && VERSION=$(tr -d '\r\n ' < VERSION) && \
    make packages VERSION="$VERSION" NFPM=nfpm && mkdir -p /downloads && \
    cp "dist/techaudit-agent_${VERSION}-1_amd64.deb" "dist/techaudit-agent-${VERSION}-1.x86_64.rpm" /downloads/

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3001
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts /app/package.json ./
COPY --from=agent-msi /downloads ./downloads
COPY --from=agent-linux /downloads ./downloads
COPY docker-entrypoint.sh /usr/local/bin/
# Defesa extra contra CRLF vindo de um clone no Windows.
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3001
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
