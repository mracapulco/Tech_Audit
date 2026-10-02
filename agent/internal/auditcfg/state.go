package auditcfg

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// State é o que o agente aplicou, salvo em disco: permite retirar só a
// entrada de auditoria que ele mesmo adicionou e restaurar a política.
type State struct {
	Paths map[string]*PathState `json:"paths"`
	// PolicyBefore é a política de "Sistema de arquivos" antes de o agente
	// habilitá-la; nil se ele não mexeu nela.
	PolicyBefore *Policy `json:"policy_before,omitempty"`
}

// PathState é um caminho com a entrada (ACE) aplicada pelo agente.
type PathState struct {
	Path string `json:"path"`
	ACE  string `json:"ace"`
	// Attempted é a entrada da última tentativa que falhou; evita repetir o
	// mesmo erro a cada consulta até o portal pedir para reaplicar.
	Attempted string `json:"attempted,omitempty"`
	// Preexisting: a mesma entrada já existia antes; na remoção ela fica.
	Preexisting bool `json:"preexisting"`
	// Status: applied, error ou divergent.
	Status string `json:"status"`
	// SACLBefore é a SACL original, para reverter manualmente se preciso.
	SACLBefore  string    `json:"sacl_before"`
	AppliedAt   time.Time `json:"applied_at"`
	LastAttempt time.Time `json:"last_attempt"`
}

func loadState(path string) (*State, error) {
	s := &State{Paths: map[string]*PathState{}}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, s); err != nil {
		return nil, err
	}
	if s.Paths == nil {
		s.Paths = map[string]*PathState{}
	}
	return s, nil
}

// save grava em arquivo temporário e renomeia, para não corromper o estado
// se o serviço parar no meio.
func (s *State) save(path string) error {
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
