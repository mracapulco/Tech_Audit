VERSION ?= 0.2.0
LDFLAGS := -s -w -X main.version=$(VERSION)
# Versão do MSI: só números (0.2.0-rc1 -> 0.2.0).
MSI_VERSION := $(firstword $(subst -, ,$(VERSION)))

.PHONY: test windows msi mock

test:
	go vet ./...
	GOOS=windows go vet ./...
	go test ./...

# Gera dist/techaudit-agent.exe para Windows x64 (compila de qualquer SO).
windows:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/techaudit-agent.exe ./cmd/agent

# Gera dist/TechAuditAgent-$(VERSION).msi. Requer wixl e msibuild (pacotes
# wixl e msitools no Debian/Ubuntu). As propriedades ENDPOINT e
# ENROLLMENT_TOKEN precisam ser "seguras" para chegar à parte da instalação
# que roda como SYSTEM, e o token não deve aparecer no log do msiexec.
msi: windows
	wixl -a x64 -D Version=$(MSI_VERSION) -D ExePath=dist/techaudit-agent.exe \
		-o dist/TechAuditAgent-$(VERSION).msi installer/techaudit-agent.wxs
	msibuild dist/TechAuditAgent-$(VERSION).msi -q \
		"UPDATE Property SET Value='ENDPOINT;ENROLLMENT_TOKEN;WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED' WHERE Property='SecureCustomProperties'"
	msibuild dist/TechAuditAgent-$(VERSION).msi -q \
		"INSERT INTO Property (Property, Value) VALUES ('MsiHiddenProperties', 'ENROLLMENT_TOKEN')"

mock:
	go run ./cmd/mock-receiver
