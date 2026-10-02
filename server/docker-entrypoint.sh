#!/bin/sh
# Aplica as migrations e cria o primeiro administrador antes de subir a API.
set -e
npx prisma migrate deploy
node dist/cli.js migrate-events
node dist/cli.js admin:bootstrap
exec "$@"
