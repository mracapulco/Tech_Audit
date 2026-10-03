#!/bin/sh
# Depois de remover. "apt purge" apaga também a configuração e os dados
# (registro do servidor, buffer de eventos e log de alterações).
systemctl daemon-reload >/dev/null 2>&1 || true
if [ "$1" = "purge" ]; then
	rm -rf /etc/techaudit /var/lib/techaudit
fi
exit 0
