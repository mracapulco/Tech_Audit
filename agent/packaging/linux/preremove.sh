#!/bin/sh
# Antes de remover o pacote. Na atualização (deb: upgrade; rpm: 1) não faz
# nada; na remoção para o serviço e desfaz as regras do auditd e o
# full_audit do Samba aplicados pelo agente.
case "$1" in
remove | 0)
	/usr/bin/techaudit-agent uninstall || true
	;;
esac
exit 0
