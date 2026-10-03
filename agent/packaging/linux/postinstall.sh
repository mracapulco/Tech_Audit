#!/bin/sh
# Depois de instalar ou atualizar o pacote.
systemctl daemon-reload >/dev/null 2>&1 || true
if [ -f /etc/techaudit/agent.json ]; then
	# Atualização: volta a rodar com a versão nova.
	systemctl enable techaudit-agent.service >/dev/null 2>&1 || true
	systemctl restart techaudit-agent.service >/dev/null 2>&1 || true
else
	echo "Tech Audit Agent instalado. Para registrar este servidor, rode:"
	echo "  sudo techaudit-agent install -endpoint https://ingest-audit.techmaster.inf.br -enrollment-token TOKEN"
fi
exit 0
