#!/bin/sh
# Gera o instalador MSI a partir de um techaudit-agent.exe já compilado.
# Usado pelo Makefile (make msi) e pela imagem Docker do servidor.
#   installer/build-msi.sh <versão> <exe> <saída.msi>
# Requer wixl e msibuild (pacotes wixl e msitools no Debian/Ubuntu).
set -eu
version=$1 exe=$2 out=$3
dir=$(dirname "$0")
# Versão do MSI: só números (0.3.0-rc1 -> 0.3.0).
msi_version=${version%%-*}

wixl --ext ui -a x64 -D Version="$msi_version" -D ExePath="$exe" -D BitmapDir="$dir/bitmaps" \
	-o "$out" "$dir/techaudit-agent.wxs"
# ENDPOINT e ENROLLMENT_TOKEN precisam ser "seguras" para chegar à parte da
# instalação que roda como SYSTEM, e o token não deve aparecer no log do msiexec.
msibuild "$out" -q \
	"UPDATE Property SET Value='ENDPOINT;ENROLLMENT_TOKEN;WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED' WHERE Property='SecureCustomProperties'"
msibuild "$out" -q \
	"INSERT INTO Property (Property, Value) VALUES ('MsiHiddenProperties', 'ENROLLMENT_TOKEN')"
