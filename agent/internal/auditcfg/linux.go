package auditcfg

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/samba"
)

// No Linux o agente audita cada pasta de dois jeitos:
//
//   - auditd: regras do kernel para a pasta (acesso direto ao servidor:
//     SSH, console, sudo). Processos sem login (serviços, o próprio Samba)
//     ficam de fora pela condição auid != unset.
//   - Samba: módulo full_audit nos compartilhamentos que dão acesso à pasta
//     (acesso pela rede, com IP do computador).
//
// As regras do kernel somem quando o auditd reinicia; o agente confere a
// cada consulta e recoloca as que faltam (aqui não há GPO para respeitar).

// AuditRule é uma regra do auditd do Tech Audit para uma pasta.
type AuditRule struct {
	Dir  string
	Read bool // regra de leitura (só nos caminhos com auditoria de leitura)
}

// LinuxSystem é o acesso ao sistema: auditd e Samba. Implementado em
// system_linux.go; os testes usam um falso.
type LinuxSystem interface {
	IsDir(path string) bool
	AuditdActive() bool
	StartAuditd() error
	// Rules devolve as regras do Tech Audit carregadas no kernel.
	Rules() ([]AuditRule, error)
	AddRule(AuditRule) error
	DeleteRule(AuditRule) error
	// RuleText é a regra como aparece no auditctl (para o antes/depois).
	RuleText(AuditRule) string
	// SaveRules grava as regras em /etc/audit/rules.d, para valerem já no
	// início do auditd (antes de o agente subir).
	SaveRules([]AuditRule) error
	// Samba devolve nil quando o Samba não está instalado.
	Samba() SambaSystem
}

// SambaSystem configura o full_audit.
type SambaSystem interface {
	Shares() ([]samba.Share, error)
	ReadConf() (string, error)
	// WriteConf valida com testparm, guarda cópia do original e recarrega o Samba.
	WriteConf(text string) error
	Ops() (success, failure []string, err error)
	// LogRate tira (on) ou devolve o limite de mensagens do journald para o
	// serviço do Samba. changed indica que o arquivo mudou.
	LogRate(on bool) (changed bool, err error)
}

type linuxApplier struct {
	sys   LinuxSystem
	state *State
	now   func() time.Time
	log   []ChangeEntry
}

func ruleDesc(p PathConfig) string {
	if p.AuditRead {
		return "auditd:wa,r"
	}
	return "auditd:wa"
}

func wantedRules(active []PathConfig) map[AuditRule]bool {
	want := map[AuditRule]bool{}
	for _, p := range active {
		want[AuditRule{Dir: p.Path}] = true
		if p.AuditRead {
			want[AuditRule{Dir: p.Path, Read: true}] = true
		}
	}
	return want
}

func (a *linuxApplier) sync(cfg *Config, verifyDue bool) []Result {
	var active, removed []PathConfig
	for _, p := range cfg.Paths {
		switch p.State {
		case "active":
			active = append(active, p)
		case "removed":
			removed = append(removed, p)
		}
	}
	// Pasta inexistente não entra nas regras (o auditctl recusaria).
	missing := map[string]bool{}
	var usable []PathConfig
	for _, p := range active {
		if a.sys.IsDir(p.Path) {
			usable = append(usable, p)
		} else {
			missing[p.ID] = true
		}
	}

	policyBefore := a.policyText()
	pathErr := map[string][]string{} // id -> problemas
	addErr := func(p PathConfig, msg string) { pathErr[p.ID] = append(pathErr[p.ID], msg) }

	// 1. Serviço auditd.
	if len(usable) > 0 && !a.sys.AuditdActive() {
		entry := ChangeEntry{Operation: "policy", Before: &AuditState{Policy: "auditd parado"}}
		if err := a.sys.StartAuditd(); err != nil {
			entry.Status, entry.Message = "error", "não foi possível iniciar o auditd: "+err.Error()
			for _, p := range usable {
				addErr(p, entry.Message)
			}
		} else {
			entry.Status, entry.Message, entry.After = "applied", "serviço auditd iniciado e habilitado", &AuditState{Policy: "auditd ativo"}
		}
		a.log = append(a.log, entry)
	}

	// 2. Regras do auditd.
	want := wantedRules(usable)
	before, err := a.sys.Rules()
	if err != nil {
		for _, p := range usable {
			addErr(p, "lendo as regras do auditd: "+err.Error())
		}
	}
	beforeSet := map[AuditRule]bool{}
	for _, r := range before {
		beforeSet[r] = true
	}
	if err == nil {
		for _, r := range before {
			if !want[r] {
				if err := a.sys.DeleteRule(r); err != nil {
					a.log = append(a.log, ChangeEntry{Operation: "policy", Status: "error", Message: "removendo regra do auditd de " + r.Dir + ": " + err.Error()})
				}
			}
		}
		var readded []string
		for r := range want {
			if beforeSet[r] {
				continue
			}
			if err := a.sys.AddRule(r); err != nil {
				for _, p := range usable {
					if p.Path == r.Dir {
						addErr(p, "regra do auditd: "+err.Error())
					}
				}
				continue
			}
			// Regra que o agente já tinha aplicado e sumiu (auditd reiniciado).
			for id, st := range a.state.Paths {
				if st.Path == r.Dir && st.Status == "applied" && !r.Read && !isPending(cfg, id) {
					readded = append(readded, r.Dir)
				}
			}
		}
		if len(readded) > 0 {
			sort.Strings(readded)
			a.log = append(a.log, ChangeEntry{Operation: "verify", Status: "applied",
				Message: "regras do auditd recolocadas (o auditd foi reiniciado ou as regras foram apagadas): " + strings.Join(readded, ", ")})
		}
	}
	saved := make([]AuditRule, 0, len(want))
	for r := range want {
		saved = append(saved, r)
	}
	sortRules(saved)
	if err := a.sys.SaveRules(saved); err != nil {
		a.log = append(a.log, ChangeEntry{Operation: "policy", Status: "error", Message: "gravando /etc/audit/rules.d: " + err.Error()})
	}
	after, _ := a.sys.Rules()

	// 3. Samba.
	confBefore, confAfter := "", ""
	sharesFor := map[string][]string{} // id -> compartilhamentos
	smb := a.sys.Samba()
	if smb != nil {
		confBefore, confAfter = a.syncSamba(smb, usable, sharesFor, addErr)
	}

	// 4. Resultado por caminho.
	var results []Result
	for _, p := range removed {
		local := a.state.Paths[p.ID]
		if p.Status != "removing" && local == nil {
			continue
		}
		r := Result{PathID: p.ID, Path: p.Path, Operation: "remove", Status: "removed",
			Before: &AuditState{SACL: a.pathText(p.Path, before, confBefore), Policy: policyBefore},
			After:  &AuditState{SACL: a.pathText(p.Path, after, confAfter), Policy: a.policyText()}}
		delete(a.state.Paths, p.ID)
		results = append(results, r)
	}
	for _, p := range active {
		local := a.state.Paths[p.ID]
		want := ruleDesc(p)
		if p.Status != "pending" && local != nil && (local.ACE == want || local.Attempted == want) && !missing[p.ID] && len(pathErr[p.ID]) == 0 {
			continue
		}
		if p.Status != "pending" && local != nil && local.Attempted == want && local.Status == "error" {
			continue // erro só é tentado de novo quando o portal pede para reaplicar
		}
		r := Result{PathID: p.ID, Path: p.Path, Operation: "apply",
			Before: &AuditState{SACL: a.pathText(p.Path, before, confBefore), Policy: policyBefore},
			After:  &AuditState{SACL: a.pathText(p.Path, after, confAfter), Policy: a.policyText()}}
		switch {
		case missing[p.ID]:
			r.Status, r.Message = "error", "a pasta não existe no servidor"
		case len(pathErr[p.ID]) > 0:
			r.Status, r.Message = "error", strings.Join(pathErr[p.ID], "; ")
		default:
			r.Status, r.Message = "applied", a.applyMessage(p, smb != nil, sharesFor[p.ID])
		}
		if r.Status == "error" {
			if local == nil {
				local = &PathState{Path: p.Path}
				a.state.Paths[p.ID] = local
			}
			local.Status, local.Attempted, local.LastAttempt = "error", want, a.now()
		} else {
			a.state.Paths[p.ID] = &PathState{Path: p.Path, ACE: want, Status: "applied", AppliedAt: a.now(), LastAttempt: a.now()}
		}
		results = append(results, r)
	}
	for id := range a.state.Paths {
		if !hasPath(cfg, id) {
			delete(a.state.Paths, id)
		}
	}
	if verifyDue {
		results = append(results, a.verify(usable, after, confAfter)...)
	}
	return results
}

// syncSamba liga o full_audit nos compartilhamentos que dão acesso a
// alguma pasta ativa e desliga nos que não precisam mais.
func (a *linuxApplier) syncSamba(smb SambaSystem, active []PathConfig, sharesFor map[string][]string, addErr func(PathConfig, string)) (before, after string) {
	fail := func(paths []PathConfig, msg string) {
		for _, p := range paths {
			addErr(p, msg)
		}
	}
	shares, err := smb.Shares()
	if err != nil {
		fail(active, "lendo os compartilhamentos do Samba: "+err.Error())
		return "", ""
	}
	conf, err := smb.ReadConf()
	if err != nil {
		fail(active, "lendo o smb.conf: "+err.Error())
		return "", ""
	}
	managed := map[string]bool{}
	for _, s := range samba.Managed(conf) {
		managed[strings.ToLower(s)] = true
	}
	wanted := map[string]samba.Share{}
	for _, p := range active {
		for _, s := range shares {
			if !s.Overlaps(p.Path) {
				continue
			}
			if s.HasFullAudit() && !managed[strings.ToLower(s.Name)] {
				addErr(p, fmt.Sprintf("o compartilhamento [%s] já usa o full_audit com outra configuração; o agente não altera", s.Name))
				continue
			}
			wanted[strings.ToLower(s.Name)] = s
			sharesFor[p.ID] = append(sharesFor[p.ID], s.Name)
		}
	}
	next := conf
	for name := range managed {
		if _, ok := wanted[name]; !ok {
			next, _ = samba.Disable(next, name)
		}
	}
	if len(wanted) > 0 {
		success, failure, err := smb.Ops()
		if err != nil {
			fail(active, "módulo full_audit do Samba: "+err.Error())
			return conf, conf
		}
		for _, s := range wanted {
			var vfs []string
			for _, m := range s.VFS {
				if m != "full_audit" {
					vfs = append(vfs, m)
				}
			}
			out, err := samba.Enable(next, s.Name, samba.Settings{VFS: vfs, Success: success, Failure: failure})
			if err != nil {
				for _, p := range active {
					if s.Overlaps(p.Path) {
						addErr(p, err.Error())
					}
				}
				continue
			}
			next = out
		}
	}
	if next != conf {
		if err := smb.WriteConf(next); err != nil {
			fail(active, "gravando o smb.conf: "+err.Error())
			a.log = append(a.log, ChangeEntry{Operation: "policy", Status: "error", Message: "gravando o smb.conf: " + err.Error()})
			return conf, conf
		}
		a.log = append(a.log, ChangeEntry{Operation: "policy", Status: "applied",
			Message: "smb.conf alterado: full_audit em " + listOr(samba.Managed(next), "nenhum compartilhamento") + " (vale para novas conexões)",
			Before:  &AuditState{Policy: "Samba: full_audit em " + listOr(samba.Managed(conf), "nenhum compartilhamento")},
			After:   &AuditState{Policy: "Samba: full_audit em " + listOr(samba.Managed(next), "nenhum compartilhamento")}})
	}
	if changed, err := smb.LogRate(len(wanted) > 0); err != nil {
		a.log = append(a.log, ChangeEntry{Operation: "policy", Status: "error", Message: "limite de mensagens do journald para o Samba: " + err.Error()})
	} else if changed {
		msg := "limite de mensagens do journald para o Samba removido (vale depois de reiniciar o serviço do Samba)"
		if len(wanted) == 0 {
			msg = "limite de mensagens do journald para o Samba restaurado"
		}
		a.log = append(a.log, ChangeEntry{Operation: "policy", Status: "applied", Message: msg})
	}
	return conf, next
}

// verify informa mudança de situação (aplicado <-> divergente).
func (a *linuxApplier) verify(active []PathConfig, rules []AuditRule, conf string) []Result {
	loaded := map[AuditRule]bool{}
	for _, r := range rules {
		loaded[r] = true
	}
	var results []Result
	for _, p := range active {
		local := a.state.Paths[p.ID]
		if local == nil || (local.Status != "applied" && local.Status != "divergent") {
			continue
		}
		problem := ""
		switch {
		case !a.sys.AuditdActive():
			problem = "o serviço auditd está parado"
		case !loaded[AuditRule{Dir: p.Path}]:
			problem = "a regra do auditd não está carregada (modo imutável -e 2?)"
		}
		status := "applied"
		if problem != "" {
			status = "divergent"
		}
		if status == local.Status {
			continue
		}
		local.Status = status
		results = append(results, Result{PathID: p.ID, Path: p.Path, Operation: "verify", Status: status, Message: problem,
			After: &AuditState{SACL: a.pathText(p.Path, rules, conf), Policy: a.policyText()}})
	}
	return results
}

func (a *linuxApplier) applyMessage(p PathConfig, hasSamba bool, shares []string) string {
	parts := []string{"auditd: acesso direto ao servidor"}
	switch {
	case !hasSamba:
		parts = append(parts, "Samba não instalado")
	case len(shares) == 0:
		parts = append(parts, "nenhum compartilhamento Samba dá acesso a esta pasta")
	default:
		sort.Strings(shares)
		parts = append(parts, "Samba: compartilhamento "+strings.Join(shares, ", ")+" (quem já está conectado passa a ser auditado ao reconectar)")
	}
	if !p.Recursive {
		parts = append(parts, "subpastas ignoradas pelo agente")
	}
	return strings.Join(parts, "; ")
}

// pathText descreve as regras e o bloco do Samba que valem para a pasta.
func (a *linuxApplier) pathText(dir string, rules []AuditRule, conf string) string {
	var lines []string
	for _, r := range rules {
		if r.Dir == dir {
			lines = append(lines, "auditd: "+a.sys.RuleText(r))
		}
	}
	if conf != "" {
		for _, s := range samba.Managed(conf) {
			if b := samba.Block(conf, s); b != "" && a.shareCovers(s, dir) {
				lines = append(lines, fmt.Sprintf("samba [%s]: %s", s, strings.ReplaceAll(b, "\n", "; ")))
			}
		}
	}
	if len(lines) == 0 {
		return "sem regras do Tech Audit"
	}
	return strings.Join(lines, "\n")
}

func (a *linuxApplier) shareCovers(name, dir string) bool {
	smb := a.sys.Samba()
	if smb == nil {
		return false
	}
	shares, err := smb.Shares()
	if err != nil {
		return false
	}
	for _, s := range shares {
		if strings.EqualFold(s.Name, name) {
			return s.Overlaps(dir)
		}
	}
	return false
}

func (a *linuxApplier) policyText() string {
	if a.sys.AuditdActive() {
		return "auditd ativo"
	}
	return "auditd parado"
}

func sortRules(r []AuditRule) {
	sort.Slice(r, func(i, j int) bool {
		if r[i].Dir != r[j].Dir {
			return r[i].Dir < r[j].Dir
		}
		return !r[i].Read && r[j].Read
	})
}

func isPending(cfg *Config, id string) bool {
	for _, p := range cfg.Paths {
		if p.ID == id {
			return p.Status == "pending"
		}
	}
	return false
}

func hasPath(cfg *Config, id string) bool {
	for _, p := range cfg.Paths {
		if p.ID == id {
			return true
		}
	}
	return false
}

func listOr(items []string, empty string) string {
	if len(items) == 0 {
		return empty
	}
	return strings.Join(items, ", ")
}
