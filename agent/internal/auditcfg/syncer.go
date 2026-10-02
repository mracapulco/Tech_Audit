package auditcfg

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/dirsize"
	"github.com/mracapulco/Tech_Audit/agent/internal/sddl"
)

// Syncer roda a sincronização: consulta a configuração a cada Interval,
// aplica, informa o servidor, registra tudo no log local e mede as pastas.
type Syncer struct {
	Client *Client
	Sys    System
	Opts   Options
	Log    *ChangeLog
	// Notify avisa o administrador local (log Application do Windows).
	// warning é true para erros e divergências.
	Notify func(warning bool, msg string)
	Logf   func(format string, args ...any)
	// Measure mede as pastas; padrão dirsize.Measure.
	Measure func(ctx context.Context, paths []string) map[string]*dirsize.Result

	// Exclusions acompanha a configuração atual, para o coletor descartar
	// eventos dos padrões ignorados.
	Exclusions Exclusions

	now        func() time.Time
	state      *State
	lastVerify time.Time
	reported   int // última versão informada ao servidor (-1: nenhuma)

	mu          sync.Mutex
	activePaths []PathConfig
	measureNow  chan struct{}
}

// NewSyncer carrega o estado local e abre o log de alterações.
func NewSyncer(client *Client, sys System, opts Options) (*Syncer, error) {
	opts = opts.WithDefaults()
	st, err := loadState(opts.StateFile)
	if err != nil {
		return nil, fmt.Errorf("estado da configuração (%s): %w", opts.StateFile, err)
	}
	log, err := OpenChangeLog(opts.ChangeLog)
	if err != nil {
		return nil, fmt.Errorf("log de alterações (%s): %w", opts.ChangeLog, err)
	}
	return &Syncer{
		Client:     client,
		Sys:        sys,
		Opts:       opts,
		Log:        log,
		Notify:     func(bool, string) {},
		Logf:       func(string, ...any) {},
		Measure:    dirsize.Measure,
		now:        time.Now,
		state:      st,
		reported:   -1,
		measureNow: make(chan struct{}, 1),
	}, nil
}

// Run sincroniza até ctx ser cancelado. Falhas de rede só são registradas:
// a próxima consulta tenta de novo.
func (s *Syncer) Run(ctx context.Context) {
	go s.measureLoop(ctx)
	t := time.NewTicker(s.Opts.Interval.Duration)
	defer t.Stop()
	for {
		if err := s.Once(ctx); err != nil && ctx.Err() == nil {
			s.Logf("configuração de auditoria: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Once faz uma rodada: busca, aplica, registra e informa.
func (s *Syncer) Once(ctx context.Context) error {
	cfg, err := s.Client.Fetch(ctx)
	if err != nil {
		return err
	}
	s.Exclusions.set(cfg.Paths)

	verifyDue := s.now().Sub(s.lastVerify) >= s.Opts.VerifyInterval.Duration
	a := &applier{sys: s.Sys, state: s.state, now: s.now}
	results := a.sync(cfg, verifyDue)
	if verifyDue {
		s.lastVerify = s.now()
	}
	if err := s.state.save(s.Opts.StateFile); err != nil {
		s.Logf("salvando o estado da configuração: %v", err)
	}

	for _, e := range a.policyLog {
		e.Version = cfg.Version
		s.record(e)
	}
	changed := false
	for _, r := range results {
		s.record(ChangeEntry{
			Version: cfg.Version, PathID: r.PathID, Path: r.Path, Operation: r.Operation,
			Status: r.Status, Message: r.Message, Before: r.Before, After: r.After,
		})
		if r.Status == "applied" || r.Status == "removed" {
			changed = true
		}
	}

	var active []PathConfig
	for _, p := range cfg.Paths {
		if p.State == "active" {
			active = append(active, p)
		}
	}
	s.mu.Lock()
	s.activePaths = active
	s.mu.Unlock()
	if changed {
		s.requestMeasure()
	}

	if len(results) == 0 && cfg.Version == s.reported {
		return nil
	}
	if err := s.Client.SendResults(ctx, cfg.Version, results); err != nil {
		// O servidor continua com o pedido pendente; a próxima rodada reaplica
		// (aplicar de novo não muda nada se a entrada já estiver lá).
		return fmt.Errorf("enviando resultado: %w", err)
	}
	s.reported = cfg.Version
	return nil
}

// record grava no log local e avisa no log Application.
func (s *Syncer) record(e ChangeEntry) {
	if err := s.Log.Append(e); err != nil {
		s.Logf("gravando o log de alterações: %v", err)
	}
	msg := describe(e)
	s.Logf("%s", msg)
	s.Notify(e.Status == "error" || e.Status == "divergent", msg)
}

func describe(e ChangeEntry) string {
	what := map[string]string{
		"apply/applied":    "Auditoria aplicada",
		"apply/error":      "Erro ao aplicar a auditoria",
		"remove/removed":   "Auditoria removida",
		"remove/error":     "Erro ao remover a auditoria",
		"verify/divergent": "Auditoria divergente do configurado",
		"verify/applied":   "Auditoria voltou ao configurado",
		"policy/applied":   "Política de auditoria alterada",
		"policy/restored":  "Política de auditoria restaurada",
		"policy/error":     "Erro na política de auditoria",
	}[e.Operation+"/"+e.Status]
	if what == "" {
		what = e.Operation + " " + e.Status
	}
	msg := "Tech Audit: " + what
	if e.Path != "" {
		msg += " em " + e.Path
	}
	if e.Message != "" {
		msg += " (" + e.Message + ")"
	}
	if e.Before != nil || e.After != nil {
		msg += fmt.Sprintf(". Antes: %s. Depois: %s.", stateText(e.Before, e.Path != ""), stateText(e.After, e.Path != ""))
	}
	return msg + fmt.Sprintf(" Versão da configuração: %d. Alteração solicitada pelo portal Tech Audit.", e.Version)
}

// stateText descreve SACL e política; withSACL indica que a SACL foi lida
// (vazia = pasta sem nenhuma regra de auditoria).
func stateText(st *AuditState, withSACL bool) string {
	if st == nil {
		return "-"
	}
	parts := ""
	switch sacl, _ := sddl.Parse(st.SACL); {
	case st.SACL != "" && len(sacl.ACEs) > 0:
		parts = "SACL " + st.SACL
	case withSACL:
		parts = "SACL vazia"
	}
	if st.Policy != "" {
		if parts != "" {
			parts += "; "
		}
		parts += st.Policy
	}
	if parts == "" {
		return "-"
	}
	return parts
}

func (s *Syncer) requestMeasure() {
	select {
	case s.measureNow <- struct{}{}:
	default:
	}
}

// measureLoop mede as pastas a cada SizeInterval, ou logo depois de uma
// alteração. A varredura pode levar horas em volumes grandes, então roda
// separada da sincronização.
func (s *Syncer) measureLoop(ctx context.Context) {
	t := time.NewTicker(s.Opts.SizeInterval.Duration)
	defer t.Stop()
	first := time.NewTimer(time.Minute)
	defer first.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-first.C:
		case <-t.C:
		case <-s.measureNow:
		}
		if err := s.MeasureOnce(ctx); err != nil && ctx.Err() == nil {
			s.Logf("medição das pastas: %v", err)
		}
	}
}

// MeasureOnce mede os caminhos ativos e envia ao servidor.
func (s *Syncer) MeasureOnce(ctx context.Context) error {
	s.mu.Lock()
	paths := append([]PathConfig(nil), s.activePaths...)
	s.mu.Unlock()
	if len(paths) == 0 {
		return nil
	}
	list := make([]string, len(paths))
	for i, p := range paths {
		list[i] = p.Path
	}
	start := s.now()
	got := s.Measure(ctx, list)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	reports := make([]SizeReport, 0, len(paths))
	for _, p := range paths {
		r := got[p.Path]
		switch {
		case r == nil:
			reports = append(reports, SizeReport{PathID: p.ID, Error: "não medido"})
		case r.Err != nil:
			reports = append(reports, SizeReport{PathID: p.ID, Error: r.Err.Error()})
		default:
			n := r.Bytes
			reports = append(reports, SizeReport{PathID: p.ID, SizeBytes: &n})
		}
	}
	if err := s.Client.SendSizes(ctx, reports); err != nil {
		return err
	}
	s.Logf("tamanho de %d pasta(s) medido em %s", len(paths), s.now().Sub(start).Round(time.Second))
	return nil
}
