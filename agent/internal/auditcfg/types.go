// Package auditcfg busca no servidor os caminhos auditados configurados no
// portal, aplica a política de auditoria e a SACL de cada pasta, devolve o
// resultado e mede o tamanho das pastas para a licença
// (docs/ARCHITECTURE.md, seções 4.6 e 9.2).
//
// Toda alteração feita no servidor do cliente fica em um log local somente
// de acréscimo (com hash encadeado), gera um evento no log Application do
// Windows e é enviada ao servidor, que registra o antes e o depois.
package auditcfg

import (
	"encoding/json"
	"time"
)

// Config é a resposta de GET /v1/config.
type Config struct {
	AgentID string       `json:"agent_id"`
	Version int          `json:"version"`
	Paths   []PathConfig `json:"paths"`
	// Permissions liga o inventário de permissões (plano Enterprise).
	Permissions PermissionsConfig `json:"permissions"`
}

// PermissionsConfig é o pedido do portal para o inventário de permissões.
type PermissionsConfig struct {
	Enabled bool `json:"enabled"`
	// IntervalHours entre coletas. Padrão 24.
	IntervalHours int `json:"interval_hours"`
	// RequestedAt muda quando alguém pede "Atualizar agora" no portal.
	RequestedAt string `json:"requested_at"`
}

// PathConfig é um caminho auditado como o portal o deixou.
type PathConfig struct {
	ID string `json:"id"`
	// Path é o caminho local no servidor (ex.: D:\Dados\Financeiro).
	Path string `json:"path"`
	// State é active ou removed (o que o portal pediu).
	State string `json:"state"`
	// Status é o último resultado registrado no servidor; pending e removing
	// indicam pedido ainda não confirmado pelo agente.
	Status     string   `json:"status"`
	Recursive  bool     `json:"recursive"`
	AuditRead  bool     `json:"audit_read"`
	Exclusions []string `json:"exclusions"`
}

// AuditState é a SACL (SDDL) e a política de auditoria em um momento.
type AuditState struct {
	SACL   string `json:"sacl,omitempty"`
	Policy string `json:"policy,omitempty"`
}

// Result é o resultado de uma operação em um caminho (POST /v1/config/result).
type Result struct {
	PathID    string      `json:"path_id"`
	Operation string      `json:"operation"` // apply, remove, verify
	Status    string      `json:"status"`    // applied, removed, error, divergent
	Message   string      `json:"message,omitempty"`
	Before    *AuditState `json:"before,omitempty"`
	After     *AuditState `json:"after,omitempty"`
	// Path só vai para o log local; o servidor identifica pelo PathID.
	Path string `json:"-"`
}

// Policy é a configuração da subcategoria "Sistema de arquivos" do auditpol.
type Policy struct {
	Success bool `json:"success"`
	Failure bool `json:"failure"`
}

func (p Policy) String() string {
	switch {
	case p.Success && p.Failure:
		return "Sistema de arquivos: sucesso e falha"
	case p.Success:
		return "Sistema de arquivos: sucesso"
	case p.Failure:
		return "Sistema de arquivos: falha"
	default:
		return "Sistema de arquivos: sem auditoria"
	}
}

// Options vem do agent.json ("audit_config").
type Options struct {
	// Disabled desliga a sincronização (o agente só coleta eventos).
	Disabled bool `json:"disabled"`
	// Interval entre consultas da configuração. Padrão: 2 min.
	Interval Duration `json:"interval"`
	// VerifyInterval entre verificações de divergência (SACL removida, GPO). Padrão: 30 min.
	VerifyInterval Duration `json:"verify_interval"`
	// SizeInterval entre medições do tamanho das pastas. Padrão: 6 h.
	SizeInterval Duration `json:"size_interval"`
	// StateFile guarda o que o agente aplicou (para desfazer só o que é dele).
	StateFile string `json:"state_file"`
	// ChangeLog é o log local de alterações, somente acréscimo.
	ChangeLog string `json:"change_log"`
}

// WithDefaults preenche os campos vazios.
func (o Options) WithDefaults() Options {
	if o.Interval.Duration <= 0 {
		o.Interval.Duration = 2 * time.Minute
	}
	if o.VerifyInterval.Duration <= 0 {
		o.VerifyInterval.Duration = 30 * time.Minute
	}
	if o.SizeInterval.Duration <= 0 {
		o.SizeInterval.Duration = 6 * time.Hour
	}
	if o.StateFile == "" {
		o.StateFile = defaultStateFile
	}
	if o.ChangeLog == "" {
		o.ChangeLog = defaultChangeLog
	}
	return o
}

// Duration aceita valores como "2m" ou "6h" no JSON.
type Duration struct{ time.Duration }

func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return err
	}
	d.Duration = v
	return nil
}

func (d Duration) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }
