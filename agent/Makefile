VERSION ?= $(shell cat VERSION)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: test windows msi linux deb rpm packages mock

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

# Linux: binário estático (sem cgo), roda do CentOS 7 ao Ubuntu 24.04.
# ARCH=amd64 (padrão) ou arm64.
ARCH ?= amd64
NFPM ?= go run github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.42.1

linux:
	GOOS=linux GOARCH=$(ARCH) CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/linux-$(ARCH)/techaudit-agent ./cmd/agent

# dist/techaudit-agent_$(VERSION)_$(ARCH).deb (Ubuntu/Debian)
deb: linux
	mkdir -p dist/pkg && cp dist/linux-$(ARCH)/techaudit-agent dist/pkg/
	VERSION=$(VERSION) ARCH=$(ARCH) $(NFPM) package -f packaging/linux/nfpm.yaml -p deb -t dist/

# dist/techaudit-agent-$(VERSION)-1.x86_64.rpm (CentOS/Oracle/RHEL/Rocky/Alma)
rpm: linux
	mkdir -p dist/pkg && cp dist/linux-$(ARCH)/techaudit-agent dist/pkg/
	VERSION=$(VERSION) ARCH=$(ARCH) $(NFPM) package -f packaging/linux/nfpm.yaml -p rpm -t dist/

packages: deb rpm

mock:
	go run ./cmd/mock-receiver
