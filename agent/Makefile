VERSION ?= 0.1.0-dev
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: test windows mock

test:
	go vet ./...
	GOOS=windows go vet ./...
	go test ./...

# Gera dist/techaudit-agent.exe para Windows x64 (compila de qualquer SO).
windows:
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o dist/techaudit-agent.exe ./cmd/agent

mock:
	go run ./cmd/mock-receiver
