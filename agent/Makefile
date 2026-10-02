VERSION ?= $(shell cat VERSION)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: test windows msi mock

test:
	go vet ./...
	GOOS=windows go vet ./...
	go test ./...

# Gera dist/techaudit-agent.exe para Windows x64 (compila de qualquer SO).
windows:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/techaudit-agent.exe ./cmd/agent

# Gera dist/TechAuditAgent-$(VERSION).msi, com o assistente gráfico em
# português. Requer wixl e msibuild (pacotes wixl e msitools no Debian/Ubuntu).
msi: windows
	sh installer/build-msi.sh $(VERSION) dist/techaudit-agent.exe dist/TechAuditAgent-$(VERSION).msi

mock:
	go run ./cmd/mock-receiver
