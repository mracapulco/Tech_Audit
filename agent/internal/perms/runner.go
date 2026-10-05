package perms

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// Path é um caminho auditado ativo.
type Path struct {
	ID   string
	Path string
}

// Settings é o que o portal pede (vem de GET /v1/config).
type Settings struct {
	Enabled       bool
	IntervalHours int
	RequestedAt   string
}

// Upload é uma parte do inventário de um caminho (POST /v1/permissions).
// Caminhos grandes vão em várias partes, numeradas a partir de 0; a última
// tem Final.
type Upload struct {
	ScanID     string    `json:"scan_id"`
	PathID     string    `json:"path_id"`
	Part       int       `json:"part"`
	Final      bool      `json:"final"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at"`
	Scanned    int       `json:"scanned"`
	Truncated  bool      `json:"truncated"`
	Error      string    `json:"error,omitempty"`
	Folders    []Folder  `json:"folders"`
	// Groups vai só na última parte: membros dos grupos citados.
	Groups []GroupInfo `json:"groups,omitempty"`
}

// PartSize é o número de pastas por envio.
const PartSize = 500

// Runner coleta o inventário quando o portal liga o recurso: uma vez por
// intervalo (padrão 24 h), ao surgir um caminho novo e quando alguém pede
// "Atualizar agora" no portal.
type Runner struct {
	Reader    Reader
	Send      func(ctx context.Context, u Upload) error
	StateFile string
	Options   Options
	Logf      func(format string, args ...any)

	mu       sync.Mutex
	settings Settings
	paths    []Path
	wake     chan struct{}
	state    runnerState
	retryAt  time.Time
	now      func() time.Time
}

type runnerState struct {
	LastRun     time.Time `json:"last_run"`
	LastRequest string    `json:"last_request"`
	PathIDs     []string  `json:"path_ids"`
}

// NewRunner carrega o estado salvo (última coleta), para não refazer tudo a
// cada reinício do serviço.
func NewRunner(r Reader, send func(context.Context, Upload) error, stateFile string) *Runner {
	run := &Runner{Reader: r, Send: send, StateFile: stateFile, Logf: func(string, ...any) {}, wake: make(chan struct{}, 1), now: time.Now}
	if b, err := os.ReadFile(stateFile); err == nil {
		_ = json.Unmarshal(b, &run.state)
	}
	return run
}

// Update recebe a configuração atual; acorda a coleta se ela ficou devida.
func (r *Runner) Update(s Settings, paths []Path) {
	r.mu.Lock()
	r.settings, r.paths = s, paths
	due := r.dueLocked()
	r.mu.Unlock()
	if due {
		select {
		case r.wake <- struct{}{}:
		default:
		}
	}
}

func (r *Runner) dueLocked() bool {
	s := r.settings
	if !s.Enabled || len(r.paths) == 0 || r.now().Before(r.retryAt) {
		return false
	}
	interval := time.Duration(s.IntervalHours) * time.Hour
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	if r.state.LastRun.IsZero() || r.now().Sub(r.state.LastRun) >= interval {
		return true
	}
	if s.RequestedAt != "" && s.RequestedAt != r.state.LastRequest {
		return true
	}
	for _, p := range r.paths {
		if !slices.Contains(r.state.PathIDs, p.ID) {
			return true
		}
	}
	return false
}

// Run espera a coleta ficar devida e roda, até ctx ser cancelado.
func (r *Runner) Run(ctx context.Context) {
	t := time.NewTicker(10 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.wake:
		case <-t.C:
			r.mu.Lock()
			due := r.dueLocked()
			r.mu.Unlock()
			if !due {
				continue
			}
		}
		r.RunOnce(ctx)
	}
}

// RunOnce coleta e envia todos os caminhos ativos.
func (r *Runner) RunOnce(ctx context.Context) {
	r.mu.Lock()
	s, paths := r.settings, append([]Path(nil), r.paths...)
	r.mu.Unlock()
	if !s.Enabled || len(paths) == 0 {
		return
	}
	start := r.now()
	var ids []string
	failed := false
	for _, p := range paths {
		if ctx.Err() != nil {
			return
		}
		res := r.scan(ctx, p)
		if ctx.Err() != nil {
			return
		}
		var groups []GroupInfo
		if res.Err == nil {
			groups = CollectGroups(r.Reader, res.Folders)
		}
		if err := r.upload(ctx, p, res.started, res.Result, groups); err != nil {
			r.Logf("inventário de permissões de %s: envio falhou: %v", p.Path, err)
			failed = true
			continue
		}
		ids = append(ids, p.ID)
		if res.Err != nil {
			r.Logf("inventário de permissões de %s: %v", p.Path, res.Err)
		} else {
			r.Logf("inventário de permissões de %s: %d pasta(s) lida(s), %d com permissão própria", p.Path, res.Scanned, len(res.Folders))
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if failed {
		// Servidor fora do ar: tenta de novo em 30 min, sem refazer a cada consulta.
		r.retryAt = r.now().Add(30 * time.Minute)
		if len(ids) == 0 {
			return
		}
	}
	r.state = runnerState{LastRun: start, LastRequest: s.RequestedAt, PathIDs: ids}
	if failed {
		r.state.LastRun = time.Time{} // os que falharam continuam devidos
	}
	if err := r.saveLocked(); err != nil {
		r.Logf("inventário de permissões: salvando o estado: %v", err)
	}
}

type scanned struct {
	Result
	started time.Time
}

func (r *Runner) scan(ctx context.Context, p Path) scanned {
	started := r.now()
	return scanned{Result: Scan(ctx, r.Reader, p.Path, r.Options), started: started}
}

func (r *Runner) upload(ctx context.Context, p Path, started time.Time, res Result, groups []GroupInfo) error {
	id, err := newID()
	if err != nil {
		return err
	}
	u := Upload{ScanID: id, PathID: p.ID, StartedAt: started.UTC(), FinishedAt: r.now().UTC(), Scanned: res.Scanned, Truncated: res.Truncated}
	if res.Err != nil {
		u.Error = res.Err.Error()
	}
	folders := res.Folders
	for part := 0; ; part++ {
		n := min(PartSize, len(folders))
		u.Part, u.Folders, u.Final = part, folders[:n], n == len(folders)
		if u.Folders == nil {
			u.Folders = []Folder{}
		}
		if u.Final {
			u.Groups = groups
		}
		if err := r.Send(ctx, u); err != nil {
			return err
		}
		folders = folders[n:]
		if u.Final {
			return nil
		}
	}
}

func (r *Runner) saveLocked() error {
	b, err := json.Marshal(r.state)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.StateFile), 0o700); err != nil {
		return err
	}
	tmp := r.StateFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.StateFile)
}

// newID gera um UUID v4 para identificar a coleta.
func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
