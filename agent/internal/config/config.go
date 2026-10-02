// Package config carrega a configuração do agente a partir de um arquivo JSON.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// Config é o conteúdo do arquivo agent.json.
type Config struct {
	// Endpoint recebe os lotes via HTTP POST (ex.: https://audit.techmaster.com.br/v1/events).
	Endpoint string `json:"endpoint"`
	// Token é enviado no cabeçalho "Authorization: Bearer <token>".
	Token string `json:"token"`
	// AgentID identifica o agente no servidor. Padrão: nome do host.
	AgentID string `json:"agent_id"`
	// BatchSize é o máximo de eventos por POST.
	BatchSize int `json:"batch_size"`
	// FlushInterval é o tempo máximo de espera por novos eventos antes de enviar um lote parcial.
	FlushInterval Duration `json:"flush_interval"`
	// StateFile guarda o bookmark do Event Log, para retomar de onde parou após reinício.
	StateFile string `json:"state_file"`
	// StartFrom define onde começar quando não há bookmark: "now" (padrão) ou "oldest".
	StartFrom string `json:"start_from"`
	// CAFile é um PEM opcional com a CA do certificado do servidor, se ela não
	// estiver no repositório de certificados do Windows.
	CAFile string `json:"ca_file"`
	// Filter descarta ruído antes do envio.
	Filter event.Filter `json:"filter"`
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

// Load lê o arquivo e aplica os valores padrão.
func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
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
	if c.StateFile == "" {
		c.StateFile = defaultStateFile
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
