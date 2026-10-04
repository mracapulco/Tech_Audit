package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

const defaultDataDir = "/var/lib/techaudit"

// DefaultFile é onde o comando install grava a configuração.
const DefaultFile = "/etc/techaudit/agent.json"

func fromRegistry() (*Config, bool) { return nil, false }

// platformDefaults guarda o estado e o log de alterações da auditoria na
// pasta de dados (no Windows eles ficam em C:\ProgramData\TechAudit).
func platformDefaults(c *Config) {
	if c.AuditConfig.StateFile == "" {
		c.AuditConfig.StateFile = filepath.Join(c.DataDir, "audit-config-state.json")
	}
	if c.AuditConfig.ChangeLog == "" {
		c.AuditConfig.ChangeLog = filepath.Join(c.DataDir, "audit-changes.log")
	}
}

// DefaultFilter descarta contas de computador e temporários conhecidos
// (Office, LibreOffice, editores, arquivos do Explorer e do macOS).
var DefaultFilter = event.Filter{
	ExcludeMachineAccounts: true,
	ExcludePathContains:    []string{"/~$", ".tmp", "/.~lock.", ".swp", "/desktop.ini", "/thumbs.db", "/.ds_store"},
}

var (
	loadedMu   sync.Mutex
	loadedPath string
)

func rememberPath(path string) {
	loadedMu.Lock()
	loadedPath = path
	loadedMu.Unlock()
}

// ForgetEnrollmentToken tira o token de registro do agent.json depois que o
// agente já obteve o próprio token.
func ForgetEnrollmentToken() {
	loadedMu.Lock()
	path := loadedPath
	loadedMu.Unlock()
	if path == "" {
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(b, &m) != nil {
		return
	}
	if _, ok := m["enrollment_token"]; !ok {
		return
	}
	delete(m, "enrollment_token")
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append(out, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, path)
	}
}
