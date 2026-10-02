// Package enroll registra o agente no servidor: troca o token de registro
// gerado no portal por um agent_id e um token próprio, salvos em disco.
package enroll

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
)

// Credentials é o que o servidor devolve no registro.
type Credentials struct {
	AgentID    string `json:"agent_id"`
	TenantID   string `json:"tenant_id"`
	AgentToken string `json:"agent_token"`
}

// Request é o corpo de POST /v1/enroll.
type Request struct {
	EnrollmentToken string `json:"enrollment_token"`
	Hostname        string `json:"hostname"`
	MachineID       string `json:"machine_id"`
	OS              string `json:"os"`
	AgentVersion    string `json:"agent_version"`
}

// URL deriva o endereço de registro do endpoint de eventos
// (https://host/v1/events -> https://host/v1/enroll).
func URL(eventsEndpoint string) (string, error) {
	u, err := url.Parse(eventsEndpoint)
	if err != nil {
		return "", err
	}
	return u.ResolveReference(&url.URL{Path: "enroll"}).String(), nil
}

// Enroll faz o registro. Um erro de HTTP traz o status e a mensagem do servidor.
func Enroll(ctx context.Context, client *http.Client, enrollURL string, r Request) (*Credentials, error) {
	body, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, enrollURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("registro recusado: HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
	var c Credentials
	if err := json.Unmarshal(msg, &c); err != nil {
		return nil, fmt.Errorf("resposta do registro: %w", err)
	}
	if c.AgentID == "" || c.AgentToken == "" {
		return nil, errors.New("resposta do registro sem agent_id ou agent_token")
	}
	return &c, nil
}

// Load lê as credenciais salvas; devolve nil, nil se o arquivo não existe.
func Load(path string) (*Credentials, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var c Credentials
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if c.AgentToken == "" {
		return nil, fmt.Errorf("%s: agent_token vazio", path)
	}
	return &c, nil
}

// Save grava as credenciais com permissão restrita. No Windows o diretório
// C:\ProgramData\TechAudit deve ter acesso apenas de SYSTEM e Administradores.
func Save(path string, c *Credentials) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// MachineID é um identificador estável da máquina, em hash, para o servidor
// reconhecer reinstalações e não gastar outra vaga da licença.
func MachineID() (string, error) {
	raw, err := rawMachineID()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(runtime.GOOS + ":" + raw))
	return hex.EncodeToString(sum[:]), nil
}
