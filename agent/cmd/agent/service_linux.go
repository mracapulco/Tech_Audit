package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mracapulco/Tech_Audit/agent/internal/auditcfg"
	"github.com/mracapulco/Tech_Audit/agent/internal/config"
)

// No Linux o agente roda em primeiro plano sob o systemd (unidade
// techaudit-agent.service, instalada pelo pacote .deb/.rpm); o log vai para
// o journald: journalctl -u techaudit-agent.

const (
	defaultConfigFile = config.DefaultFile
	unitName          = "techaudit-agent.service"
	// Unidade gravada pelo comando install quando o agente não veio de pacote.
	localUnit = "/etc/systemd/system/" + unitName
)

// Locais onde os pacotes instalam a unidade.
var packagedUnits = []string{"/usr/lib/systemd/system/" + unitName, "/lib/systemd/system/" + unitName}

func isService() bool          { return false }
func runService(options) error { return errors.New("no Linux o agente roda pelo systemd") }

func ensureDataDir(dir string) error { return os.MkdirAll(dir, 0o700) }

// install grava /etc/techaudit/agent.json e inicia o serviço:
//
//	sudo techaudit-agent install -endpoint https://ingest-audit.techmaster.inf.br -enrollment-token TOKEN
func install(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	endpoint := fs.String("endpoint", "", "endereço do servidor (ex.: https://ingest-audit.techmaster.inf.br)")
	token := fs.String("enrollment-token", "", "token de registro gerado no portal")
	caFile := fs.String("ca-file", "", "PEM com a CA do servidor, se ela não estiver no sistema")
	cfgPath := fs.String("config", defaultConfigFile, "arquivo de configuração")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return errors.New("rode como root (sudo techaudit-agent install ...)")
	}

	// Mantém o que já existir no arquivo (ajustes manuais) e troca só o informado.
	m := map[string]any{}
	if b, err := os.ReadFile(*cfgPath); err == nil {
		if err := json.Unmarshal(b, &m); err != nil {
			return fmt.Errorf("%s: %w", *cfgPath, err)
		}
	}
	if *endpoint != "" {
		m["endpoint"] = config.NormalizeEndpoint(*endpoint)
	}
	if *token != "" {
		m["enrollment_token"] = strings.TrimSpace(*token)
	}
	if *caFile != "" {
		m["ca_file"] = *caFile
	}
	if _, ok := m["filter"]; !ok {
		m["filter"] = config.DefaultFilter
	}
	if m["endpoint"] == nil || m["endpoint"] == "" {
		return errors.New("informe -endpoint")
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(*cfgPath), 0o755); err != nil {
		return err
	}
	tmp := *cfgPath + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, *cfgPath); err != nil {
		return err
	}
	if _, err := config.Load(*cfgPath); err != nil {
		return err
	}
	if err := ensureDataDir("/var/lib/techaudit"); err != nil {
		return err
	}
	fmt.Println("configuração gravada em", *cfgPath)
	if _, err := os.Stat("/var/lib/techaudit/credentials.json"); err == nil && *token != "" {
		fmt.Println("aviso: este servidor já está registrado; o token novo só é usado se /var/lib/techaudit/credentials.json for apagado")
	}

	if !hasPackagedUnit() {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if err := os.WriteFile(localUnit, []byte(unitFile(exe, *cfgPath)), 0o644); err != nil {
			return err
		}
	}
	for _, args := range [][]string{{"daemon-reload"}, {"enable", unitName}, {"restart", unitName}} {
		if out, err := exec.Command("systemctl", args...).CombinedOutput(); err != nil {
			return fmt.Errorf("systemctl %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	fmt.Println("serviço techaudit-agent iniciado; acompanhe com: journalctl -u techaudit-agent -f")
	return nil
}

func hasPackagedUnit() bool {
	for _, p := range packagedUnits {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}

func unitFile(exe, cfg string) string {
	return `[Unit]
Description=Tech Audit Agent (auditoria de acesso a arquivos)
After=network-online.target auditd.service
Wants=network-online.target

[Service]
ExecStart=` + exe + ` -config ` + cfg + `
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`
}

// uninstall para o serviço e desfaz o que o agente aplicou (regras do
// auditd, full_audit do Samba). Mantém /etc/techaudit e /var/lib/techaudit.
func uninstall() error {
	if os.Geteuid() != 0 {
		return errors.New("rode como root (sudo techaudit-agent uninstall)")
	}
	_ = exec.Command("systemctl", "disable", "--now", unitName).Run()
	if _, err := os.Stat(localUnit); err == nil {
		_ = os.Remove(localUnit)
		_ = exec.Command("systemctl", "daemon-reload").Run()
	}
	opts := auditcfg.Options{}
	if cfg, err := config.Load(defaultConfigFile); err == nil {
		opts = cfg.AuditConfig
	}
	if err := auditcfg.RemoveAll(opts, func(format string, args ...any) { fmt.Printf(format+"\n", args...) }); err != nil {
		return err
	}
	fmt.Println("serviço removido; configuração e dados mantidos em /etc/techaudit e /var/lib/techaudit")
	return nil
}
