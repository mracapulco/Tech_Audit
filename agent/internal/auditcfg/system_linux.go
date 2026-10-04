package auditcfg

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/syslog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/samba"
)

// NewPlatformSyncer cria o Syncer do Linux: regras do auditd e full_audit
// do Samba.
func NewPlatformSyncer(client *Client, opts Options) (*Syncer, error) {
	if _, err := exec.LookPath("auditctl"); err != nil {
		return nil, errors.New("auditctl não encontrado; instale o pacote auditd (Debian/Ubuntu) ou audit (CentOS/Oracle/RHEL)")
	}
	s, err := NewSyncer(client, nil, opts)
	if err != nil {
		return nil, err
	}
	s.Linux = &linuxSystem{}
	return s, nil
}

// NewNotifier escreve no syslog/journald (identificador techaudit-agent),
// para o administrador local ver as alterações sem acessar o portal.
func NewNotifier(logf func(string, ...any)) func(warning bool, msg string) {
	if os.Getenv("JOURNAL_STREAM") != "" {
		// Sob o systemd o log do agente já vai para o journald (syslog);
		// gravar de novo duplicaria cada aviso.
		return func(bool, string) {}
	}
	w, err := syslog.New(syslog.LOG_NOTICE|syslog.LOG_DAEMON, "techaudit-agent")
	if err != nil {
		logf("syslog indisponível: %v", err)
		return func(bool, string) {}
	}
	return func(warning bool, msg string) {
		var err error
		if warning {
			err = w.Warning(msg)
		} else {
			err = w.Notice(msg)
		}
		if err != nil {
			logf("syslog: %v", err)
		}
	}
}

// RulesFile guarda as regras do Tech Audit para o auditd carregar ao iniciar.
const RulesFile = "/etc/audit/rules.d/techaudit.rules"

type linuxSystem struct {
	smbChecked bool
	smb        *sambaSystem
}

func run(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var out, errb bytes.Buffer
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = strings.TrimSpace(out.String())
		}
		if msg != "" {
			return out.String(), fmt.Errorf("%s: %s", name, firstLine(msg))
		}
		return out.String(), fmt.Errorf("%s: %w", name, err)
	}
	return out.String(), nil
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(s, "\n")
	return s
}

func (*linuxSystem) IsDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// AuditdActive confere se o daemon está gravando o log (auditctl -s mostra o pid).
func (*linuxSystem) AuditdActive() bool {
	out, err := run("auditctl", "-s")
	if err != nil {
		return false
	}
	for _, l := range strings.Split(out, "\n") {
		if f := strings.Fields(l); len(f) == 2 && f[0] == "pid" {
			pid, _ := strconv.Atoi(f[1])
			return pid > 0
		}
	}
	return false
}

func (*linuxSystem) StartAuditd() error {
	if _, err := run("systemctl", "enable", "--now", "auditd"); err != nil {
		if _, err2 := run("service", "auditd", "start"); err2 != nil {
			return err
		}
	}
	return nil
}

// ruleArgs monta a regra. Gravação, exclusão, renomear e atributos vêm do
// "perm=wa" da pasta; leitura só de open/openat (perm=r em todas as
// chamadas traria cada consulta de atributos).
func ruleArgs(op string, r AuditRule) []string {
	if !r.Read {
		return []string{op, "always,exit", "-F", "dir=" + r.Dir, "-F", "perm=wa", "-F", "auid!=4294967295", "-k", KeyWriteRule}
	}
	sys := []string{"-S", "open", "-S", "openat"}
	if runtime.GOARCH == "arm64" {
		sys = []string{"-S", "openat"}
	}
	args := []string{op, "always,exit", "-F", "arch=b64"}
	args = append(args, sys...)
	return append(args, "-F", "dir="+r.Dir, "-F", "perm=r", "-F", "auid!=4294967295", "-k", KeyReadRule)
}

// Chaves das regras (iguais às do pacote auditd, que lê os eventos).
const (
	KeyWriteRule = "techaudit"
	KeyReadRule  = "techaudit-r"
)

func (*linuxSystem) RuleText(r AuditRule) string { return strings.Join(ruleArgs("-a", r), " ") }

var (
	ruleKeyRe = regexp.MustCompile(`(?:-k |key=)(techaudit(?:-r)?)\s*$`)
	ruleDirRe = regexp.MustCompile(`(?:-F dir=|-w )(.+?)(?: -F | -p | -k |$)`)
)

// Rules lê "auditctl -l" e devolve as regras com as chaves do Tech Audit.
func (*linuxSystem) Rules() ([]AuditRule, error) {
	out, err := run("auditctl", "-l")
	if err != nil {
		return nil, err
	}
	return parseRules(out), nil
}

func parseRules(out string) []AuditRule {
	var rules []AuditRule
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		k := ruleKeyRe.FindStringSubmatch(l)
		d := ruleDirRe.FindStringSubmatch(l)
		if k == nil || d == nil {
			continue
		}
		rules = append(rules, AuditRule{Dir: d[1], Read: k[1] == KeyReadRule})
	}
	return rules
}

func (*linuxSystem) AddRule(r AuditRule) error {
	_, err := run("auditctl", ruleArgs("-a", r)...)
	return err
}

func (*linuxSystem) DeleteRule(r AuditRule) error {
	_, err := run("auditctl", ruleArgs("-d", r)...)
	return err
}

// SaveRules grava o arquivo lido pelo augenrules quando o auditd inicia.
// Pastas com espaço ficam de fora (o formato do arquivo não aceita aspas);
// para elas o agente recoloca a regra ao iniciar e a cada consulta.
func (*linuxSystem) SaveRules(rules []AuditRule) error {
	if len(rules) == 0 {
		if err := os.Remove(RulesFile); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if _, err := os.Stat(filepath.Dir(RulesFile)); err != nil {
		return nil // auditd sem rules.d (instalação antiga): só as regras carregadas
	}
	var b strings.Builder
	b.WriteString("## Regras do Tech Audit, geradas pelo agente a partir dos caminhos do portal.\n")
	b.WriteString("## Não edite: o agente regrava este arquivo.\n")
	for _, r := range rules {
		if strings.ContainsAny(r.Dir, " \t") {
			continue
		}
		b.WriteString(strings.Join(ruleArgs("-a", r), " ") + "\n")
	}
	return writeFileAtomic(RulesFile, []byte(b.String()), 0o640)
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		return nil
	}
	tmp := path + ".techaudit-tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (l *linuxSystem) Samba() SambaSystem {
	if !l.smbChecked {
		l.smbChecked = true
		if _, err := exec.LookPath("smbd"); err == nil {
			l.smb = &sambaSystem{}
		} else if _, err := os.Stat("/usr/sbin/smbd"); err == nil {
			l.smb = &sambaSystem{}
		}
	}
	if l.smb == nil {
		return nil
	}
	return l.smb
}

type sambaSystem struct{}

// build lê "smbd -b" (CONFIGFILE, MODULESDIR...).
func (*sambaSystem) build(key string) (string, error) {
	out, err := run(smbdPath(), "-b")
	if err != nil {
		return "", err
	}
	for _, l := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(l), ":")
		if ok && strings.TrimSpace(k) == key {
			return strings.TrimSpace(v), nil
		}
	}
	return "", fmt.Errorf("smbd -b não informa %s", key)
}

func smbdPath() string {
	if p, err := exec.LookPath("smbd"); err == nil {
		return p
	}
	return "/usr/sbin/smbd"
}

func (s *sambaSystem) confPath() string {
	if p, err := s.build("CONFIGFILE"); err == nil && p != "" {
		return p
	}
	return "/etc/samba/smb.conf"
}

func (s *sambaSystem) Shares() ([]samba.Share, error) {
	out, err := run("testparm", "-s", "--suppress-prompt", s.confPath())
	if err != nil {
		return nil, err
	}
	return samba.ParseTestparm(out), nil
}

func (s *sambaSystem) ReadConf() (string, error) {
	b, err := os.ReadFile(s.confPath())
	return string(b), err
}

// WriteConf valida o arquivo novo com testparm antes de trocar, guarda o
// original uma vez (smb.conf.antes-techaudit) e pede ao Samba para recarregar.
func (s *sambaSystem) WriteConf(text string) error {
	path := s.confPath()
	fi, err := os.Stat(path)
	if err != nil {
		return err
	}
	tmp := path + ".techaudit-tmp"
	if err := os.WriteFile(tmp, []byte(text), fi.Mode().Perm()); err != nil {
		return err
	}
	if _, err := run("testparm", "-s", "--suppress-prompt", tmp); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("configuração recusada pelo testparm: %w", err)
	}
	backup := path + ".antes-techaudit"
	if _, err := os.Stat(backup); errors.Is(err, os.ErrNotExist) {
		if orig, err := os.ReadFile(path); err == nil {
			_ = os.WriteFile(backup, orig, fi.Mode().Perm())
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	// Samba parado: a configuração vale quando ele subir.
	_, _ = run("smbcontrol", "smbd", "reload-config")
	return nil
}

func (s *sambaSystem) Ops() ([]string, []string, error) {
	dir, err := s.build("MODULESDIR")
	if err != nil {
		return nil, nil, err
	}
	mod, err := os.ReadFile(filepath.Join(dir, "vfs", "full_audit.so"))
	if err != nil {
		return nil, nil, fmt.Errorf("módulo full_audit não encontrado: %w", err)
	}
	success := samba.SupportedOps(mod, samba.SuccessOps)
	failure := samba.SupportedOps(mod, samba.FailureOps)
	if len(success) == 0 {
		return nil, nil, errors.New("nenhuma operação conhecida no módulo full_audit")
	}
	return success, failure, nil
}

// LogRate tira o limite de mensagens do journald para o serviço do Samba
// (padrão: 10 mil a cada 30 s), que descartaria registros em horário de pico.
func (s *sambaSystem) LogRate(on bool) (bool, error) {
	unit := "smbd.service"
	if _, err := run("systemctl", "cat", unit); err != nil {
		if _, err := run("systemctl", "cat", "smb.service"); err != nil {
			return false, nil // sem systemd ou serviço com outro nome: deixa como está
		}
		unit = "smb.service"
	}
	path := "/etc/systemd/system/" + unit + ".d/techaudit-log.conf"
	if !on {
		if err := os.Remove(path); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return false, nil
			}
			return false, err
		}
		_, _ = run("systemctl", "daemon-reload")
		return true, nil
	}
	want := []byte("# Tech Audit: o módulo full_audit gera uma linha por operação; sem limite\n# o journald não descarta registros de auditoria em horário de pico.\n[Service]\nLogRateLimitIntervalSec=0\n")
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, want) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	if err := os.WriteFile(path, want, 0o644); err != nil {
		return false, err
	}
	_, err := run("systemctl", "daemon-reload")
	return true, err
}

// RemoveAll desfaz tudo o que o agente aplicou (desinstalação): regras do
// auditd, full_audit do Samba e o ajuste do journald. Registra no log de
// alterações.
func RemoveAll(opts Options, logf func(string, ...any)) error {
	opts = opts.WithDefaults()
	clog, err := OpenChangeLog(opts.ChangeLog)
	if err != nil {
		return err
	}
	record := func(e ChangeEntry) {
		e.Operation = "policy"
		if err := clog.Append(e); err != nil {
			logf("log de alterações: %v", err)
		}
		logf("%s", describe(e))
	}
	sys := &linuxSystem{}
	var errs []string
	if rules, err := sys.Rules(); err == nil {
		for _, r := range rules {
			if err := sys.DeleteRule(r); err != nil {
				errs = append(errs, err.Error())
			}
		}
		if len(rules) > 0 {
			record(ChangeEntry{Status: "restored", Message: fmt.Sprintf("agente desinstalado: %d regra(s) do auditd removida(s)", len(rules))})
		}
	}
	if err := sys.SaveRules(nil); err != nil {
		errs = append(errs, err.Error())
	}
	if smb := sys.Samba(); smb != nil {
		if conf, err := smb.ReadConf(); err == nil {
			next := conf
			managed := samba.Managed(conf)
			for _, s := range managed {
				next, _ = samba.Disable(next, s)
			}
			if next != conf {
				if err := smb.WriteConf(next); err != nil {
					errs = append(errs, err.Error())
				} else {
					record(ChangeEntry{Status: "restored", Message: "agente desinstalado: full_audit retirado de " + strings.Join(managed, ", ")})
				}
			}
		}
		if _, err := smb.LogRate(false); err != nil {
			errs = append(errs, err.Error())
		}
	}
	_ = os.Remove(opts.StateFile)
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}
