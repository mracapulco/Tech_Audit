// Comando agent (distribuído como techaudit-agent.exe) lê eventos de auditoria de acesso a arquivos do
// Security Event Log do Windows, normaliza e envia ao servidor Tech Audit.
package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/config"
	"github.com/mracapulco/Tech_Audit/agent/internal/event"
	"github.com/mracapulco/Tech_Audit/agent/internal/sender"
	"github.com/mracapulco/Tech_Audit/agent/internal/source"
)

var version = "0.1.0-dev" // sobrescrito com -ldflags "-X main.version=..."

func main() {
	cfgPath := flag.String("config", "agent.json", "arquivo de configuração JSON")
	replay := flag.String("replay", "", "lê eventos de um XML exportado (wevtutil qe ... /f:xml) em vez do Event Log")
	stdout := flag.Bool("stdout", false, "imprime os lotes em JSON em vez de enviar ao endpoint")
	logFile := flag.String("logfile", "", "grava o log neste arquivo (útil ao rodar como tarefa agendada)")
	showVersion := flag.Bool("version", false, "mostra a versão e sai")
	flag.Parse()

	if *logFile != "" {
		f, err := os.OpenFile(*logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		log.SetOutput(f)
	}

	if *showVersion {
		fmt.Println(version)
		return
	}
	cfg, err := config.Load(*cfgPath)
	if err != nil {
		log.Fatalf("configuração: %v", err)
	}

	var src source.Source
	if *replay != "" {
		src, err = source.OpenFile(*replay)
	} else {
		src, err = source.OpenEventLog("Security", source.XPathQuery(event.EventIDs), cfg.StateFile, cfg.StartFrom)
	}
	if err != nil {
		log.Fatal(err)
	}
	defer src.Close()

	var send func(context.Context, *event.Batch) error
	if *stdout {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		send = func(_ context.Context, b *event.Batch) error { return enc.Encode(b) }
	} else {
		s, err := sender.New(cfg.Endpoint, cfg.Token, cfg.CAFile)
		if err != nil {
			log.Fatal(err)
		}
		s.Logf = log.Printf
		send = s.Send
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	log.Printf("techaudit-agent %s iniciado (agent_id=%s, endpoint=%s)", version, cfg.AgentID, cfg.Endpoint)
	if err := run(ctx, cfg, src, send); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
	log.Print("encerrado")
}

func run(ctx context.Context, cfg *config.Config, src source.Source, send func(context.Context, *event.Batch) error) error {
	norm := event.NewNormalizer(cfg.Filter, 0)
	hostname, _ := os.Hostname()

	for {
		raw, eof, err := collect(ctx, src, cfg.BatchSize, cfg.FlushInterval.Duration)
		if err != nil {
			return err
		}
		if len(raw) > 0 {
			batch := &event.Batch{BatchID: newBatchID(), AgentID: cfg.AgentID, Hostname: hostname, AgentVersion: version}
			for _, x := range raw {
				r, err := event.ParseXML(x)
				if err != nil {
					log.Printf("evento ignorado: %v", err)
					continue
				}
				if ev, ok := norm.Normalize(r); ok {
					batch.Events = append(batch.Events, ev)
				}
			}
			if len(batch.Events) > 0 {
				if err := sendUntilAccepted(ctx, send, batch); err != nil {
					return err
				}
				log.Printf("%d eventos enviados (%d lidos)", len(batch.Events), len(raw))
			}
			// Só avança o bookmark depois do envio: entrega pelo menos uma vez.
			if err := src.Commit(); err != nil {
				return fmt.Errorf("salvando bookmark: %w", err)
			}
		}
		if eof {
			return nil
		}
	}
}

// newBatchID gera um UUID v4.
func newBatchID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// collect junta eventos até encher o lote ou passar flush desde o primeiro evento.
func collect(ctx context.Context, src source.Source, size int, flush time.Duration) (raw [][]byte, eof bool, err error) {
	deadline := time.Now().Add(flush)
	for len(raw) < size {
		wait := time.Until(deadline)
		if wait <= 0 {
			break
		}
		got, err := src.Next(ctx, size-len(raw), wait)
		if errors.Is(err, io.EOF) {
			return raw, true, nil
		}
		if err != nil {
			return raw, false, err
		}
		if len(raw) == 0 && len(got) == 0 {
			deadline = time.Now().Add(flush) // nada pendente: continua esperando
		}
		raw = append(raw, got...)
		if ctx.Err() != nil {
			return raw, false, ctx.Err()
		}
	}
	return raw, false, nil
}

// sendUntilAccepted insiste no mesmo lote: um erro definitivo (ex.: token
// inválido) é registrado e tentado de novo a cada minuto, sem descartar eventos.
func sendUntilAccepted(ctx context.Context, send func(context.Context, *event.Batch) error, b *event.Batch) error {
	for {
		b.SentAt = time.Now().UTC()
		err := send(ctx, b)
		if err == nil || ctx.Err() != nil {
			return err
		}
		log.Printf("servidor recusou o lote: %v; nova tentativa em 1 min", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Minute):
		}
	}
}
