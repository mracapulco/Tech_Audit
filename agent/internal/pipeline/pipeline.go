// Package pipeline liga as etapas do agente: lê eventos brutos da fonte,
// correlaciona em ações, grava no buffer local junto com o bookmark e envia
// ao servidor em lotes, apagando do buffer só o que o servidor confirmou.
package pipeline

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
	"github.com/mracapulco/Tech_Audit/agent/internal/source"
	"github.com/mracapulco/Tech_Audit/agent/internal/store"
)

// Chaves de estado no buffer.
const (
	KeyBookmark   = "bookmark"
	KeyCorrelator = "correlator"
)

// Pipeline coleta e envia até o contexto ser cancelado (ou a fonte acabar).
type Pipeline struct {
	Source     source.Source
	Store      *store.Store
	Correlator *event.Correlator
	Filter     event.Filter
	// Send envia um lote; erro = tentar de novo mais tarde.
	Send func(context.Context, *event.Batch) error

	AgentID, Hostname, Version string
	BatchSize                  int
	FlushInterval              time.Duration
	// RetryDelay é a espera após o servidor recusar um lote. Padrão 1 min.
	RetryDelay time.Duration
	// Heartbeat, se informado, é chamado a cada HeartbeatInterval (padrão
	// 1 min) mesmo sem eventos, para o portal saber que o agente está vivo.
	Heartbeat         func(context.Context, Status) error
	HeartbeatInterval time.Duration
	Logf              func(format string, args ...any)

	wake chan struct{}
	mu   sync.Mutex // protege o Correlator (coleta e heartbeat)
}

// Status é o que o agente informa no heartbeat.
type Status struct {
	BufferEvents int
	BufferBytes  int64
	Pending      int
}

// Run executa a coleta e o envio em paralelo. Com uma fonte finita (replay),
// termina quando tudo foi lido e enviado.
func (p *Pipeline) Run(parent context.Context) error {
	if p.RetryDelay <= 0 {
		p.RetryDelay = time.Minute
	}
	if p.Logf == nil {
		p.Logf = func(string, ...any) {}
	}
	p.wake = make(chan struct{}, 1)
	instance, err := p.Store.InstanceID()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	collected := make(chan struct{}) // fechado quando a fonte acaba
	var wg sync.WaitGroup
	var collectErr, sendErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		collectErr = p.collect(ctx)
		close(collected)
		if collectErr != nil {
			cancel()
		}
	}()
	go func() {
		defer wg.Done()
		sendErr = p.send(ctx, instance, collected)
		cancel()
	}()
	if p.Heartbeat != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			p.heartbeats(ctx)
		}()
	}
	wg.Wait()
	if collectErr != nil && !errors.Is(collectErr, context.Canceled) {
		return collectErr
	}
	if sendErr != nil && !errors.Is(sendErr, context.Canceled) {
		return sendErr
	}
	return parent.Err()
}

// collect lê a fonte e grava as ações no buffer. Eventos brutos, bookmark e
// pendências do correlacionador vão na mesma transação: após um reinício,
// nada é lido duas vezes nem perdido.
func (p *Pipeline) collect(ctx context.Context) error {
	for {
		raw, err := p.Source.Next(ctx, p.BatchSize, time.Second)
		eof := errors.Is(err, io.EOF)
		if err != nil && !eof {
			return err
		}
		var out []event.Event
		for _, x := range raw {
			r, err := event.ParseXML(x)
			if err != nil {
				p.Logf("evento ignorado: %v", err)
				continue
			}
			if ev, ok := event.Decode(r, p.Filter); ok {
				p.mu.Lock()
				out = append(out, p.Correlator.Add(ev)...)
				p.mu.Unlock()
			}
		}
		p.mu.Lock()
		if len(raw) == 0 {
			out = append(out, p.Correlator.Tick(time.Now().UTC())...)
		}
		if eof {
			out = append(out, p.Correlator.Flush()...)
		}
		p.mu.Unlock()
		if len(raw) > 0 || len(out) > 0 {
			state := map[string][]byte{}
			if len(raw) > 0 {
				bm, err := p.Source.Bookmark()
				if err != nil {
					return fmt.Errorf("bookmark: %w", err)
				}
				if bm != "" {
					state[KeyBookmark] = []byte(bm)
				}
			}
			p.mu.Lock()
			cs, err := p.Correlator.State()
			p.mu.Unlock()
			if err != nil {
				return err
			}
			state[KeyCorrelator] = cs
			dropped, err := p.Store.Commit(out, state)
			if err != nil {
				return fmt.Errorf("gravando no buffer: %w", err)
			}
			if dropped > 0 {
				p.Logf("buffer cheio: %d eventos antigos descartados", dropped)
			}
			if len(out) > 0 {
				select {
				case p.wake <- struct{}{}:
				default:
				}
			}
		}
		if eof {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

// send esvazia o buffer em lotes. Um lote só sai do buffer depois do 2xx do
// servidor (entrega pelo menos uma vez; o servidor deduplica).
func (p *Pipeline) send(ctx context.Context, instance string, collected <-chan struct{}) error {
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		rows, err := p.Store.Peek(p.BatchSize)
		if err != nil {
			return err
		}
		if len(rows) == 0 {
			select {
			case <-collected:
				// Fonte finita: confere de novo, pode ter chegado algo antes de fechar.
				if rows, err = p.Store.Peek(1); err != nil || len(rows) == 0 {
					return err
				}
				continue
			case <-ctx.Done():
				return ctx.Err()
			case <-p.wake:
			}
			// Espera juntar um lote maior, até FlushInterval.
			if n, _ := p.Store.Stats(); n < p.BatchSize {
				timer.Reset(p.FlushInterval)
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-collected:
				case <-timer.C:
				}
			}
			continue
		}
		b := &event.Batch{
			BatchID:      batchID(instance, rows[0].ID, rows[len(rows)-1].ID),
			AgentID:      p.AgentID,
			Hostname:     p.Hostname,
			AgentVersion: p.Version,
			Events:       make([]event.Event, len(rows)),
		}
		for i, r := range rows {
			b.Events[i] = r.Event
		}
		if err := p.sendUntilAccepted(ctx, b); err != nil {
			return err
		}
		if err := p.Store.Delete(rows[len(rows)-1].ID); err != nil {
			return err
		}
		n, _ := p.Store.Stats()
		p.Logf("%d eventos enviados (%d aguardando no buffer)", len(rows), n)
	}
}

// heartbeats avisa o servidor periodicamente. Falhas só aparecem no log
// quando mudam (primeira falha e volta ao normal), para não encher o log.
func (p *Pipeline) heartbeats(ctx context.Context) {
	every := p.HeartbeatInterval
	if every <= 0 {
		every = time.Minute
	}
	failing := false
	for {
		n, b := p.Store.Stats()
		p.mu.Lock()
		pending := p.Correlator.Pending()
		p.mu.Unlock()
		hctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := p.Heartbeat(hctx, Status{BufferEvents: n, BufferBytes: b, Pending: pending})
		cancel()
		switch {
		case err != nil && ctx.Err() == nil && !failing:
			p.Logf("heartbeat falhou: %v", err)
			failing = true
		case err == nil && failing:
			p.Logf("heartbeat voltou a funcionar")
			failing = false
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// sendUntilAccepted insiste no mesmo lote: um erro definitivo (ex.: token
// inválido) é registrado e tentado de novo a cada RetryDelay, sem descartar eventos.
func (p *Pipeline) sendUntilAccepted(ctx context.Context, b *event.Batch) error {
	for {
		b.SentAt = time.Now().UTC()
		err := p.Send(ctx, b)
		if err == nil || ctx.Err() != nil {
			return err
		}
		p.Logf("servidor recusou o lote: %v; nova tentativa em %s", err, p.RetryDelay)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(p.RetryDelay):
		}
	}
}

// batchID é um UUID derivado do banco e do intervalo de eventos: o mesmo
// lote reenviado após um reinício mantém o id, e o servidor o reconhece.
func batchID(instance string, first, last int64) string {
	h := sha256.Sum256(fmt.Appendf(nil, "%s|%d|%d", instance, first, last))
	b := h[:16]
	b[6] = b[6]&0x0f | 0x50 // versão 5 (baseado em hash)
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
