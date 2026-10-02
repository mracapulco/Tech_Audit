package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/mracapulco/Tech_Audit/agent/internal/config"
)

const (
	serviceName        = "TechAuditAgent"
	serviceDisplayName = "Tech Audit Agent"
	serviceDescription = "Coleta a auditoria de acesso a arquivos do log de Segurança e envia ao servidor Tech Audit."
	defaultDataDir     = `C:\ProgramData\TechAudit`
	defaultConfigFile  = defaultDataDir + `\agent.json`
	installDir         = `C:\Program Files\TechAudit`
	exeName            = "techaudit-agent.exe"
	// Pasta de dados: só SYSTEM e Administradores (contém o token do agente).
	dataDirSDDL = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)

func isService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// runService é chamado quando o Gerenciador de Serviços inicia o agente.
func runService(o options) error {
	eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info) // já existe: ignora
	elog, err := eventlog.Open(serviceName)
	if err != nil {
		return err
	}
	defer elog.Close()

	// Antes de ler o agent.json de dentro dela.
	if err := ensureDataDir(defaultDataDir); err != nil {
		elog.Error(1, "pasta de dados: "+err.Error())
		return err
	}
	logPath := filepath.Join(defaultDataDir, "agent.log")
	if cfg, err := config.Load(o.config); err == nil {
		logPath = cfg.LogFile
	}
	ensureDataDir(filepath.Dir(logPath))
	if w, err := openLog(logPath); err == nil {
		defer w.Close()
		log.SetOutput(w)
	} else {
		log.SetOutput(io.Discard)
	}
	if err := setRecovery(); err != nil {
		log.Printf("aviso: não foi possível configurar o reinício automático do serviço: %v", err)
	}
	return svc.Run(serviceName, &handler{opts: o, elog: elog})
}

type handler struct {
	opts options
	elog *eventlog.Log
}

func (h *handler) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- run(ctx, h.opts) }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	h.elog.Info(1, fmt.Sprintf("Tech Audit Agent %s iniciado.", version))

	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending, WaitHint: 30000}
				cancel()
				select {
				case <-done:
				case <-time.After(25 * time.Second):
					log.Print("encerramento demorou; saindo assim mesmo (o buffer já está gravado)")
				}
				log.Print("serviço parado")
				h.elog.Info(1, "Tech Audit Agent parado.")
				return false, 0
			}
		case err := <-done:
			if err == nil || errors.Is(err, context.Canceled) {
				return false, 0
			}
			log.Printf("erro fatal: %v", err)
			h.elog.Error(2, fmt.Sprintf("Tech Audit Agent parou com erro: %v", err))
			// Código de saída diferente de zero: o Windows reinicia o serviço (setRecovery).
			return false, 1
		}
	}
}

// setRecovery reinicia o serviço 1 minuto após qualquer falha, inclusive
// quando ele sai com erro sem travar.
func setRecovery() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return err
	}
	defer s.Close()
	restart := mgr.RecoveryAction{Type: mgr.ServiceRestart, Delay: time.Minute}
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{restart, restart, restart}, 24*3600); err != nil {
		return err
	}
	return s.SetRecoveryActionsOnNonCrashFailures(true)
}

// ensureDataDir garante a pasta de dados acessível só por SYSTEM e
// Administradores. Qualquer usuário local pode criar pastas em ProgramData:
// uma pasta que já existe só é aceita se o dono for SYSTEM ou Administradores
// e não for um atalho (junção) para outro lugar; senão alguém poderia deixar
// ali um agent.json ou um atalho para o serviço (SYSTEM) ler ou gravar.
func ensureDataDir(dir string) error {
	if _, err := os.Stat(dir); err == nil {
		if err := checkExistingDataDir(dir); err != nil {
			return err
		}
	} else if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(dataDirSDDL)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil)
}

func checkExistingDataDir(dir string) error {
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("%s é um atalho (junção ou link) para outra pasta; apague-o e instale de novo", dir)
	}
	sd, err := windows.GetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	if owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return nil
	}
	name, domain, _, _ := owner.LookupAccount("")
	return fmt.Errorf("%s foi criada por %s\\%s, não por SYSTEM ou Administradores; por segurança o agente não usa essa pasta. Confira o conteúdo, apague a pasta e instale de novo", dir, domain, name)
}

// install copia o executável para Arquivos de Programas, grava o servidor e o
// token de registro no registro do Windows (como o MSI faz), cria o serviço
// e o inicia. Rodar de novo atualiza o executável e a configuração.
func install(args []string) error {
	fl := flag.NewFlagSet("install", flag.ContinueOnError)
	endpoint := fl.String("endpoint", "", "URL de envio dos eventos (ex.: https://ingest-audit.techmaster.inf.br/v1/events)")
	enrollment := fl.String("enrollment-token", "", "token de registro gerado no portal")
	caFile := fl.String("ca-file", "", "PEM com a CA do servidor, se não estiver no repositório do Windows")
	if err := fl.Parse(args); err != nil {
		return err
	}

	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("abrindo o Gerenciador de Serviços (execute como administrador): %w", err)
	}
	defer m.Disconnect()

	if *endpoint != "" || *enrollment != "" || *caFile != "" {
		if err := writeRegistry(*endpoint, *enrollment, *caFile); err != nil {
			return fmt.Errorf("gravando a configuração no registro: %w", err)
		}
	}
	if _, err := config.Load(defaultConfigFile); err != nil {
		return fmt.Errorf("configuração incompleta (informe -endpoint e -enrollment-token, ou crie %s): %w", defaultConfigFile, err)
	}
	if err := ensureDataDir(defaultDataDir); err != nil {
		return err
	}

	s, err := m.OpenService(serviceName)
	exists := err == nil
	if exists {
		defer s.Close()
		stopService(s)
	}

	self, err := os.Executable()
	if err != nil {
		return err
	}
	target := filepath.Join(installDir, exeName)
	if !strings.EqualFold(filepath.Clean(self), target) {
		if err := os.MkdirAll(installDir, 0o755); err != nil {
			return err
		}
		if err := copyFile(self, target); err != nil {
			return fmt.Errorf("copiando para %s: %w", target, err)
		}
	}

	cfg := mgr.Config{
		DisplayName:      serviceDisplayName,
		Description:      serviceDescription,
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		ErrorControl:     mgr.ErrorNormal,
	}
	if exists {
		cur, err := s.Config()
		if err != nil {
			return err
		}
		cur.BinaryPathName = `"` + target + `"`
		cur.DisplayName, cur.Description, cur.StartType, cur.DelayedAutoStart = cfg.DisplayName, cfg.Description, cfg.StartType, true
		if err := s.UpdateConfig(cur); err != nil {
			return fmt.Errorf("atualizando o serviço: %w", err)
		}
	} else {
		s, err = m.CreateService(serviceName, target, cfg)
		if err != nil {
			return fmt.Errorf("criando o serviço: %w", err)
		}
		defer s.Close()
	}
	if err := setRecovery(); err != nil {
		fmt.Println("aviso: reinício automático não configurado:", err)
	}
	eventlog.InstallAsEventCreate(serviceName, eventlog.Error|eventlog.Warning|eventlog.Info)

	if err := s.Start(); err != nil {
		return fmt.Errorf("iniciando o serviço: %w", err)
	}
	if err := waitState(s, svc.Running, 20*time.Second); err != nil {
		return fmt.Errorf("%w; veja %s", err, filepath.Join(defaultDataDir, "agent.log"))
	}
	fmt.Printf("Serviço %s instalado e em execução.\nExecutável: %s\nDados e log: %s\n", serviceName, target, defaultDataDir)
	return nil
}

// uninstall para e remove o serviço. Os dados (buffer, credenciais e log) ficam.
func uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("abrindo o Gerenciador de Serviços (execute como administrador): %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(serviceName)
	if err != nil {
		return fmt.Errorf("serviço %s não encontrado", serviceName)
	}
	defer s.Close()
	stopService(s)
	if err := s.Delete(); err != nil {
		return err
	}
	eventlog.Remove(serviceName)
	fmt.Printf("Serviço %s removido. Os dados continuam em %s (apague a pasta para remover tudo).\n", serviceName, defaultDataDir)
	return nil
}

func stopService(s *mgr.Service) {
	st, err := s.Query()
	if err != nil || st.State == svc.Stopped {
		return
	}
	s.Control(svc.Stop)
	waitState(s, svc.Stopped, 30*time.Second)
}

func waitState(s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		st, err := s.Query()
		if err != nil {
			return err
		}
		if st.State == want {
			return nil
		}
		if st.State == svc.Stopped && want != svc.Stopped {
			return errors.New("o serviço parou logo após iniciar")
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("o serviço não chegou ao estado esperado em %s", timeout)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func writeRegistry(endpoint, enrollment, caFile string) error {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, config.RegistryKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	for name, v := range map[string]string{"Endpoint": endpoint, "EnrollmentToken": enrollment, "CAFile": caFile} {
		if v == "" {
			continue
		}
		if err := k.SetStringValue(name, v); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}
