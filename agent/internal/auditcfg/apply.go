package auditcfg

import (
	"fmt"
	"strings"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/sddl"
)

// System é o acesso ao Windows: SACL das pastas e política de auditoria.
// Implementado em system_windows.go; os testes usam um falso.
type System interface {
	ReadSACL(path string) (string, error)
	WriteSACL(path, sacl string) error
	ReadPolicy() (Policy, error)
	WritePolicy(Policy) error
}

// applier compara a configuração do portal com o estado local e aplica a
// diferença. Não é seguro para uso concorrente (o Syncer serializa).
type applier struct {
	sys   System
	state *State
	now   func() time.Time
	// policyLog recebe as mudanças na política de auditoria (só log local:
	// o servidor as vê no antes/depois dos caminhos).
	policyLog []ChangeEntry
}

// sync processa a configuração. verifyDue indica que é hora de também
// conferir os caminhos já aplicados e retentar remoções que falharam.
func (a *applier) sync(cfg *Config, verifyDue bool) []Result {
	var results []Result
	var active []PathConfig
	for _, p := range cfg.Paths {
		if p.State == "active" {
			active = append(active, p)
		}
	}

	// Remoções primeiro: se nada mais precisar da política, ela é restaurada.
	for _, p := range cfg.Paths {
		if p.State != "removed" {
			continue
		}
		local := a.state.Paths[p.ID]
		if p.Status == "removing" || (local != nil && verifyDue) {
			results = append(results, a.remove(p, local))
		}
	}

	var policyResult *policyChange
	for _, p := range active {
		want := sddl.AuditACE(p.Recursive, p.AuditRead)
		local := a.state.Paths[p.ID]
		if p.Status != "pending" && local != nil && (local.ACE == want || local.Attempted == want) {
			continue
		}
		if policyResult == nil {
			pc := a.ensurePolicy()
			policyResult = &pc
		}
		results = append(results, a.apply(p, local, want, *policyResult))
	}

	// Caminho que sumiu da configuração (removido e já confirmado, ou agente
	// trocado de servidor): esquece o registro local.
	known := map[string]bool{}
	for _, p := range cfg.Paths {
		known[p.ID] = true
	}
	for id := range a.state.Paths {
		if !known[id] {
			delete(a.state.Paths, id)
		}
	}

	if len(a.state.Paths) == 0 && a.state.PolicyBefore != nil {
		results = a.restorePolicy(results)
	}
	if verifyDue {
		results = append(results, a.verify(active)...)
	}
	return results
}

type policyChange struct {
	before, after string
	err           error
}

// ensurePolicy liga sucesso e falha em "Sistema de arquivos", guardando a
// política original na primeira vez.
func (a *applier) ensurePolicy() policyChange {
	cur, err := a.sys.ReadPolicy()
	if err != nil {
		return policyChange{err: fmt.Errorf("lendo a política de auditoria: %w", err)}
	}
	pc := policyChange{before: cur.String(), after: cur.String()}
	if cur.Success && cur.Failure {
		return pc
	}
	if a.state.PolicyBefore == nil {
		orig := cur
		a.state.PolicyBefore = &orig
	}
	want := Policy{Success: true, Failure: true}
	if err := a.sys.WritePolicy(want); err != nil {
		pc.err = fmt.Errorf("habilitando a auditoria de Sistema de arquivos: %w", err)
		return pc
	}
	pc.after = want.String()
	a.policyLog = append(a.policyLog, ChangeEntry{Operation: "policy", Status: "applied", Message: "auditoria de Sistema de arquivos habilitada",
		Before: &AuditState{Policy: pc.before}, After: &AuditState{Policy: pc.after}})
	return pc
}

func (a *applier) apply(p PathConfig, local *PathState, want string, pc policyChange) Result {
	r := Result{PathID: p.ID, Path: p.Path, Operation: "apply"}
	fail := func(err error) Result {
		r.Status, r.Message = "error", err.Error()
		if local == nil {
			local = &PathState{Path: p.Path}
			a.state.Paths[p.ID] = local
		}
		local.Status, local.Attempted, local.LastAttempt = "error", want, a.now()
		return r
	}
	if pc.err != nil {
		return fail(pc.err)
	}
	before, err := a.sys.ReadSACL(p.Path)
	if err != nil {
		return fail(fmt.Errorf("lendo a SACL: %w", err))
	}
	r.Before = &AuditState{SACL: before, Policy: pc.before}
	cur, err := sddl.Parse(before)
	if err != nil {
		return fail(err)
	}
	next := cur
	// Opções mudaram: retira a entrada antiga que o agente tinha posto.
	if local != nil && local.ACE != "" && local.ACE != want && !local.Preexisting {
		next, _ = next.Without(local.ACE)
	}
	preexisting := cur.Has(want) && (local == nil || local.ACE != want)
	if local != nil && local.ACE == want {
		preexisting = local.Preexisting
	}
	next, _ = next.With(want)
	if next.String() != cur.Explicit().String() {
		if err := a.sys.WriteSACL(p.Path, next.String()); err != nil {
			return fail(fmt.Errorf("gravando a SACL: %w", err))
		}
	}
	after, err := a.sys.ReadSACL(p.Path)
	if err != nil {
		return fail(fmt.Errorf("conferindo a SACL: %w", err))
	}
	r.After = &AuditState{SACL: after, Policy: pc.after}
	if got, err := sddl.Parse(after); err != nil || !got.Has(want) {
		return fail(fmt.Errorf("a SACL gravada não contém a entrada de auditoria"))
	}
	sacl0 := before
	if local != nil && local.SACLBefore != "" {
		sacl0 = local.SACLBefore
	}
	a.state.Paths[p.ID] = &PathState{
		Path: p.Path, ACE: want, Preexisting: preexisting, Status: "applied",
		SACLBefore: sacl0, AppliedAt: a.now(), LastAttempt: a.now(),
	}
	r.Status = "applied"
	if preexisting {
		r.Message = "a entrada de auditoria já existia; nada foi alterado na SACL"
	}
	return r
}

func (a *applier) remove(p PathConfig, local *PathState) Result {
	r := Result{PathID: p.ID, Path: p.Path, Operation: "remove"}
	// Sem registro local (estado perdido): retira a entrada equivalente às opções.
	ace := sddl.AuditACE(p.Recursive, p.AuditRead)
	if local != nil && local.ACE != "" {
		ace = local.ACE
	}
	fail := func(err error) Result {
		r.Status, r.Message = "error", err.Error()
		if local != nil {
			local.LastAttempt = a.now()
		}
		return r
	}
	before, err := a.sys.ReadSACL(p.Path)
	if err != nil {
		if isNotExist(err) {
			// Pasta apagada: não há o que desfazer.
			delete(a.state.Paths, p.ID)
			r.Status, r.Message = "removed", "a pasta não existe mais no servidor"
			return r
		}
		return fail(fmt.Errorf("lendo a SACL: %w", err))
	}
	r.Before = &AuditState{SACL: before}
	if local != nil && local.Preexisting {
		delete(a.state.Paths, p.ID)
		r.After = &AuditState{SACL: before}
		r.Status, r.Message = "removed", "a entrada de auditoria já existia antes do Tech Audit e foi mantida"
		return r
	}
	cur, err := sddl.Parse(before)
	if err != nil {
		return fail(err)
	}
	if next, changed := cur.Without(ace); changed {
		if err := a.sys.WriteSACL(p.Path, next.String()); err != nil {
			return fail(fmt.Errorf("gravando a SACL: %w", err))
		}
	}
	after, err := a.sys.ReadSACL(p.Path)
	if err != nil {
		return fail(fmt.Errorf("conferindo a SACL: %w", err))
	}
	r.After = &AuditState{SACL: after}
	delete(a.state.Paths, p.ID)
	r.Status = "removed"
	return r
}

// restorePolicy volta a política ao que era quando nenhum caminho precisa
// mais dela. O resultado vai junto do último caminho removido.
func (a *applier) restorePolicy(results []Result) []Result {
	orig := *a.state.PolicyBefore
	cur, err := a.sys.ReadPolicy()
	note := ""
	if err == nil {
		err = a.sys.WritePolicy(orig)
	}
	entry := ChangeEntry{Operation: "policy", Before: &AuditState{Policy: cur.String()}}
	if err != nil {
		note = fmt.Sprintf("não foi possível restaurar a política de auditoria: %v", err)
		entry.Status, entry.Message = "error", note
	} else {
		a.state.PolicyBefore = nil
		note = "política de auditoria restaurada: " + orig.String()
		entry.Status, entry.Message, entry.After = "restored", note, &AuditState{Policy: orig.String()}
	}
	a.policyLog = append(a.policyLog, entry)
	for i := len(results) - 1; i >= 0; i-- {
		if results[i].Operation == "remove" {
			r := &results[i]
			if r.Before == nil {
				r.Before = &AuditState{}
			}
			if r.After == nil {
				r.After = &AuditState{}
			}
			r.Before.Policy = cur.String()
			if err == nil {
				r.After.Policy = orig.String()
			}
			r.Message = strings.TrimPrefix(r.Message+"; "+note, "; ")
			return results
		}
	}
	return results
}

// verify confere os caminhos aplicados e informa só mudanças de situação
// (aplicado <-> divergente). Não reaplica: se uma GPO sobrescreve a
// política, brigar com ela só gera ruído (seção 4.6).
func (a *applier) verify(active []PathConfig) []Result {
	var results []Result
	pol, polErr := a.sys.ReadPolicy()
	for _, p := range active {
		local := a.state.Paths[p.ID]
		if local == nil || (local.Status != "applied" && local.Status != "divergent") {
			continue
		}
		problem := ""
		sacl, err := a.sys.ReadSACL(p.Path)
		switch {
		case err != nil && isNotExist(err):
			problem = "a pasta não existe mais no servidor"
		case err != nil:
			problem = "não foi possível ler a SACL: " + err.Error()
		default:
			if s, err := sddl.Parse(sacl); err != nil || !s.Has(local.ACE) {
				problem = "a entrada de auditoria do Tech Audit foi removida da SACL"
			}
		}
		if problem == "" && polErr == nil && !pol.Success {
			problem = "a auditoria de Sistema de arquivos está desligada no servidor (possível GPO sobrescrevendo a política)"
		}
		status := "applied"
		if problem != "" {
			status = "divergent"
		}
		if status == local.Status {
			continue
		}
		local.Status = status
		results = append(results, Result{
			PathID: p.ID, Path: p.Path, Operation: "verify", Status: status, Message: problem,
			After: &AuditState{SACL: sacl, Policy: pol.String()},
		})
	}
	return results
}
