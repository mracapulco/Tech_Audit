// Package config carrega a configuração do agente a partir de um arquivo JSON.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// Config é o conteúdo do arquivo agent.json.
type Config struct {
	// Endpoint recebe os lotes via HTTP POST (ex.: https://audit.techmaster.com.br/v1/events).
	Endpoint string `json:"endpoint"`
	// Token é enviado no cabeçalho "Authorization: Bearer <token>". Se vazio,
	// o agente usa o token salvo em CredentialsFile ou se registra com
	// EnrollmentToken.
	Token string `json:"token"`
	// EnrollmentToken é o token de registro gerado no portal. No primeiro uso o
	// agente o troca, em POST /v1/enroll, por um token próprio.
	EnrollmentToken string `json:"enrollment_token"`
	// DataDir guarda o buffer, as credenciais e o log. Padrão no Windows:
	// C:\ProgramData\TechAudit.
	DataDir string `json:"data_dir"`
	// CredentialsFile guarda o agent_id e o token recebidos no registro.
	CredentialsFile string `json:"credentials_file"`
	// BufferFile é o banco SQLite com os eventos aguardando envio e o estado
	// da coleta (bookmark do Event Log e correlação). Padrão: DataDir\agent.db.
	BufferFile string `json:"buffer_file"`
	// MaxBufferMB limita o buffer; ao atingir, leituras são descartadas antes
	// de escritas e exclusões. Padrão 1024.
	MaxBufferMB int `json:"max_buffer_mb"`
	// LogFile recebe o log quando o agente roda como serviço. Padrão: DataDir\agent.log.
	LogFile string `json:"log_file"`
	// AgentID identifica o agente no servidor. Padrão: nome do host.
	AgentID string `json:"agent_id"`
	// BatchSize é o máximo de eventos por POST.
	BatchSize int `json:"batch_size"`
	// FlushInterval é o tempo máximo de espera por novos eventos antes de enviar um lote parcial.
	FlushInterval Duration `json:"flush_interval"`
	// StateFile é o bookmark da versão 0.1, antes do buffer SQLite. Lido uma
	// vez, na primeira execução com o buffer, para não perder a posição.
	StateFile string `json:"state_file"`
	// StartFrom define onde começar quando não há bookmark: "now" (padrão) ou "oldest".
	StartFrom string `json:"start_from"`
	// CAFile é um PEM opcional com a CA do certificado do servidor, se ela não
	// estiver no repositório de certificados do Windows.
	CAFile string `json:"ca_file"`
	// Filter descarta ruído antes do envio.
	Filter event.Filter `json:"filter"`
	// Correlation ajusta como eventos brutos viram ações (criou, excluiu, renomeou...).
	Correlation Correlation `json:"correlation"`
}

// Correlation são as janelas de tempo do correlacionador (event.CorrelationConfig).
type Correlation struct {
	Window          Duration `json:"window"`           // padrão 3s
	AggregateWindow Duration `json:"aggregate_window"` // padrão 60s
	BulkThreshold   int      `json:"bulk_threshold"`   // padrão 10
	BulkGap         Duration `json:"bulk_gap"`         // padrão 5s
}

// EventConfig converte para o formato do pacote event (zeros viram os padrões de lá).
func (c Correlation) EventConfig() event.CorrelationConfig {
	return event.CorrelationConfig{
		Window:          c.Window.Duration,
		AggregateWindow: c.AggregateWindow.Duration,
		BulkThreshold:   c.BulkThreshold,
		BulkGap:         c.BulkGap.Duration,
	}
}

// Duration aceita valores como "10s" ou "1m" no JSON.
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

// Load lê o arquivo e aplica os valores padrão. No Windows, se o arquivo não
// existir, usa os valores gravados pelo instalador MSI no registro
// (HKLM\SOFTWARE\TechAudit\Agent).
func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if c, ok := fromRegistry(); ok {
			return c, c.applyDefaults()
		}
	}
	if err != nil {
		return nil, err
	}
	c := &Config{}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return c, c.applyDefaults()
}

func (c *Config) applyDefaults() error {
	if c.Endpoint == "" {
		return errors.New("endpoint é obrigatório")
	}
	if c.AgentID == "" {
		h, _ := os.Hostname()
		c.AgentID = h
	}
	if c.BatchSize <= 0 {
		c.BatchSize = 200
	}
	if c.FlushInterval.Duration <= 0 {
		c.FlushInterval.Duration = 10 * time.Second
	}
	if c.DataDir == "" {
		c.DataDir = defaultDataDir
	}
	if c.CredentialsFile == "" {
		c.CredentialsFile = filepath.Join(c.DataDir, "credentials.json")
	}
	if c.BufferFile == "" {
		c.BufferFile = filepath.Join(c.DataDir, "agent.db")
	}
	if c.LogFile == "" {
		c.LogFile = filepath.Join(c.DataDir, "agent.log")
	}
	if c.StateFile == "" {
		c.StateFile = filepath.Join(c.DataDir, "bookmark.xml")
	}
	if c.MaxBufferMB <= 0 {
		c.MaxBufferMB = 1024
	}
	switch c.StartFrom {
	case "":
		c.StartFrom = "now"
	case "now", "oldest":
	default:
		return fmt.Errorf("start_from inválido %q (use \"now\" ou \"oldest\")", c.StartFrom)
	}
	return nil
}

// defaultFilter é usado quando a configuração vem do instalador, sem arquivo:
// descarta contas de computador e temporários conhecidos.
var defaultFilter = event.Filter{
	ExcludeMachineAccounts: true,
	ObjectTypes:            []string{"File"},
	ExcludePathContains:    []string{`\~$`, ".tmp", `\desktop.ini`, `\thumbs.db`, `\$recycle.bin\`},
}
