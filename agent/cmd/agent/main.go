// Comando agent (techaudit-agent.exe no Windows, techaudit-agent no Linux) lê a auditoria de acesso a
// arquivos, transforma em ações (criou, alterou, excluiu, renomeou...) e envia ao servidor Tech Audit.
// No Windows lê o Security Event Log e roda como serviço (TechAuditAgent); no Linux lê o auditd e o
// full_audit do Samba e roda como serviço do systemd (techaudit-agent). Também roda no console para testes.
//
//	techaudit-agent install -endpoint URL -enrollment-token TOKEN   instala e inicia o serviço
//	techaudit-agent uninstall                                        remove o serviço (mantém os dados)
//	techaudit-agent [-config arquivo] [-stdout] [-replay export.xml] roda no console
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/config"
	"github.com/mracapulco/Tech_Audit/agent/internal/enroll"
	"github.com/mracapulco/Tech_Audit/agent/internal/event"
	"github.com/mracapulco/Tech_Audit/agent/internal/fsinfo"
	"github.com/mracapulco/Tech_Audit/agent/internal/pipeline"
	"github.com/mracapulco/Tech_Audit/agent/internal/sender"
	"github.com/mracapulco/Tech_Audit/agent/internal/source"
	"github.com/mracapulco/Tech_Audit/agent/internal/store"
)

var version = "0.5.0-dev" // sobrescrito com -ldflags "-X main.version=..."

// options são as opções de linha de comando do modo de execução.
type options struct {
	config  string
	replay  string
	stdout  bool
	logFile string
}

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "install":
			exit(install(os.Args[2:]))
		case "uninstall":
			exit(uninstall())
		}
	}

	var o options
	flag.StringVar(&o.config, "config", defaultConfigFile, "arquivo de configuração JSON (no Windows, sem o arquivo, usa o registro gravado pelo instalador)")
	flag.StringVar(&o.replay, "replay", "", "lê eventos de um XML exportado (wevtutil qe ... /f:xml) em vez do Event Log")
	flag.BoolVar(&o.stdout, "stdout", false, "imprime os lotes em JSON em vez de enviar ao endpoint")
	flag.StringVar(&o.logFile, "logfile", "", "grava o log neste arquivo")
	showVersion := flag.Bool("version", false, "mostra a versão e sai")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	if isService() {
		exit(runService(o))
		return
	}

	if o.logFile != "" {
		w, err := openLog(o.logFile)
		if err != nil {
			log.Fatal(err)
		}
		defer w.Close()
		log.SetOutput(w)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, o); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
	log.Print("encerrado")
}

func exit(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "erro:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

// run executa o agente até ctx ser cancelado (ou o replay acabar).
func run(ctx context.Context, o options) error {
	cfg, err := config.Load(o.config)
	if err != nil {
		return fmt.Errorf("configuração: %w", err)
	}
	if err := ensureDataDir(cfg.DataDir); err != nil {
		return fmt.Errorf("pasta de dados %s: %w", cfg.DataDir, err)
	}
	if err := fsinfo.EnableBackupPrivilege(); err != nil {
		log.Printf("aviso: SeBackupPrivilege indisponível (%v); pastas sem acesso para SYSTEM não terão criação/renomear identificados", err)
	}

	// Replay usa um buffer temporário: não mistura com a coleta real.
	bufferFile := cfg.BufferFile
	if o.replay != "" {
		dir, err := os.MkdirTemp("", "techaudit-replay")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		bufferFile = dir + string(os.PathSeparator) + "replay.db"
	}
	st, err := store.Open(bufferFile, int64(cfg.MaxBufferMB)<<20)
	if err != nil {
		return fmt.Errorf("buffer: %w", err)
	}
	defer st.Close()

	ccfg := cfg.Correlation.EventConfig()
	ccfg.IgnoreProcessID = fmt.Sprintf("0x%x", os.Getpid())
	var fs event.FS
	if o.replay == "" { // no replay os caminhos são de outra máquina
		fs = fsinfo.New()
	}
	corr := event.NewCorrelator(ccfg, cfg.Filter, fs)
	if b, err := st.Get(pipeline.KeyCorrelator); err != nil {
		return err
	} else if b != nil {
		if err := corr.LoadState(b); err != nil {
			log.Printf("aviso: estado da correlação ilegível, começando do zero: %v", err)
		}
	}

	hostname, _ := os.Hostname()
	var src source.Source
	var decode func([]byte) (event.Event, bool, error)
	switch {
	case o.replay != "":
		src, err = source.OpenFile(o.replay)
	case runtime.GOOS == "linux":
		var bm []byte
		if bm, err = st.Get(pipeline.KeyBookmark); err != nil {
			return err
		}
		src, err = source.OpenLinux(source.LinuxOptions{
			Bookmark: string(bm), StartFrom: cfg.StartFrom, Hostname: hostname, Logf: log.Printf,
			Scope: func(path string, read bool) bool { return auditExclusions.Load().InScope(path, read) },
			Roots: func() ([]string, bool) {
				roots, known := auditExclusions.Load().Roots()
				paths := make([]string, len(roots))
				for i, r := range roots {
					paths[i] = r.Path
				}
				return paths, known
			},
		})
		decode = source.DecodeJSON
	default:
		var bm []byte
		if bm, err = st.Get(pipeline.KeyBookmark); err != nil {
			return err
		}
		if bm == nil { // posição salva pela versão 0.1, antes do buffer
			bm, _ = os.ReadFile(cfg.StateFile)
		}
		src, err = source.OpenEventLog("Security", source.XPathQuery(event.EventIDs), string(bm), cfg.StartFrom)
	}
	if err != nil {
		return err
	}
	defer src.Close()

	var send func(context.Context, *event.Batch) error
	var heartbeat func(context.Context, pipeline.Status) error
	if o.stdout {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		send = func(_ context.Context, b *event.Batch) error { return enc.Encode(b) }
	} else {
		s, err := sender.New(cfg.Endpoint, cfg.Token, cfg.CAFile)
		if err != nil {
			return err
		}
		if s.Token == "" {
			if s.Token, err = agentToken(ctx, cfg, s.Client); err != nil {
				return err
			}
		}
		s.Logf = log.Printf
		send = s.Send
		heartbeat = func(ctx context.Context, st pipeline.Status) error {
			return s.SendHeartbeat(ctx, sender.Heartbeat{
				Hostname: hostname, AgentVersion: version,
				BufferEvents: st.BufferEvents, BufferBytes: st.BufferBytes, Pending: st.Pending,
			})
		}
		// Caminhos auditados definidos no portal (aplica SACL/auditpol, mede pastas).
		startAuditConfig(ctx, cfg, s.Client, s.Token)
	}

	n, _ := st.Stats()
	log.Printf("techaudit-agent %s iniciado (computador=%s, endpoint=%s, %d eventos no buffer)", version, cfg.AgentID, cfg.Endpoint, n)
	p := &pipeline.Pipeline{
		Source: src, Store: st, Correlator: corr, Filter: cfg.Filter, Send: send, Heartbeat: heartbeat,
		Exclude: func(path string) bool { return auditExclusions.Load().Excluded(path) },
		Decode:  decode,
		AgentID: cfg.AgentID, Hostname: hostname, Version: version,
		BatchSize: cfg.BatchSize, FlushInterval: cfg.FlushInterval.Duration,
		Logf: log.Printf,
	}
	return p.Run(ctx)
}

// agentToken devolve o token salvo no registro anterior ou registra o agente
// com o enrollment_token. Falhas de registro (servidor fora do ar, licença
// sem vagas) são tentadas de novo a cada minuto.
func agentToken(ctx context.Context, cfg *config.Config, client *http.Client) (string, error) {
	creds, err := enroll.Load(cfg.CredentialsFile)
	if err != nil {
		return "", err
	}
	if creds != nil {
		return creds.AgentToken, nil
	}
	if cfg.EnrollmentToken == "" {
		return "", errors.New("configure token ou enrollment_token")
	}
	enrollURL, err := enroll.URL(cfg.Endpoint)
	if err != nil {
		return "", err
	}
	machineID, err := enroll.MachineID()
	if err != nil {
		return "", fmt.Errorf("identificando a máquina: %w", err)
	}
	hostname, _ := os.Hostname()
	req := enroll.Request{
		EnrollmentToken: cfg.EnrollmentToken,
		Hostname:        hostname,
		MachineID:       machineID,
		OS:              runtime.GOOS,
		AgentVersion:    version,
	}
	for {
		creds, err := enroll.Enroll(ctx, client, enrollURL, req)
		if err == nil {
			if err := enroll.Save(cfg.CredentialsFile, creds); err != nil {
				return "", fmt.Errorf("salvando credenciais: %w", err)
			}
			config.ForgetEnrollmentToken()
			log.Printf("agente registrado (agent_id=%s); credenciais em %s", creds.AgentID, cfg.CredentialsFile)
			return creds.AgentToken, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		log.Printf("%v; nova tentativa em 1 min", err)
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(time.Minute):
		}
	}
}
