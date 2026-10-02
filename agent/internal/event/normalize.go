package event

import (
	"strings"
)

// Filter define quais eventos são descartados antes do envio.
type Filter struct {
	// ExcludeMachineAccounts descarta contas de computador (terminadas em "$").
	ExcludeMachineAccounts bool `json:"exclude_machine_accounts"`
	// ObjectTypes restringe 4656/4663/4670 a esses tipos de objeto (ex.: "File"). Vazio aceita todos.
	ObjectTypes []string `json:"object_types"`
	// IncludePaths, se preenchido, mantém apenas caminhos com um desses prefixos (sem diferenciar maiúsculas).
	IncludePaths []string `json:"include_paths"`
	// ExcludePathContains descarta caminhos que contenham algum desses trechos (sem diferenciar maiúsculas).
	ExcludePathContains []string `json:"exclude_path_contains"`
}

// Decode converte um evento bruto no formato Event, ainda sem ação lógica
// (ver Correlator). ok=false quando o tipo de objeto não interessa ou o ID
// não é coletado.
func Decode(r *Raw, f Filter) (ev Event, ok bool) {
	d := r.Data
	ev = Event{
		RecordID: r.RecordID,
		EventID:  r.EventID,
		Time:     r.Time,
		Computer: r.Computer,
		User: User{
			Name:    d["SubjectUserName"],
			Domain:  d["SubjectDomainName"],
			SID:     d["SubjectUserSid"],
			LogonID: d["SubjectLogonId"],
		},
		Process:    d["ProcessName"],
		ProcessID:  d["ProcessId"],
		AccessMask: d["AccessMask"],
		Outcome:    outcome(r.Keywords),
		HandleID:   d["HandleId"],
		ObjectType: d["ObjectType"],
	}

	switch r.EventID {
	case IDObjectAccess, IDHandleRequest:
		ev.Kind = "object_access"
		if r.EventID == IDHandleRequest {
			ev.Kind = "handle_request"
		}
		ev.Path = cleanPath(d["ObjectName"])
		ev.Actions = actions(d)
	case IDObjectDeleted:
		ev.Kind = "object_deleted"
		ev.Actions = []string{"delete"}
	case IDPermsChanged:
		ev.Kind = "permissions_changed"
		ev.Path = cleanPath(d["ObjectName"])
		ev.Actions = []string{"permission_change"}
		ev.Details = map[string]string{"old_sd": d["OldSd"], "new_sd": d["NewSd"]}
	case IDShareAccess, IDShareSession:
		ev.Kind = "share_access"
		ev.ShareName = d["ShareName"]
		ev.ClientIP = d["IpAddress"]
		ev.Path = joinShare(d["ShareLocalPath"], d["RelativeTargetName"])
		ev.Actions = actions(d)
	default:
		return ev, false
	}
	if ev.Actions == nil {
		ev.Actions = []string{}
	}
	if r.EventID != IDShareSession && !f.typeAllowed(ev.ObjectType) {
		return ev, false
	}
	return ev, true
}

func actions(d map[string]string) []string {
	if a := ActionsFromMask(d["AccessMask"]); len(a) > 0 {
		return a
	}
	return ActionsFromAccessList(d["AccessList"])
}

func (f Filter) typeAllowed(t string) bool {
	if len(f.ObjectTypes) == 0 || t == "" {
		return true
	}
	for _, ok := range f.ObjectTypes {
		if strings.EqualFold(ok, t) {
			return true
		}
	}
	return false
}

// Keep diz se o evento deve ser enviado. Com renomear/mover basta um dos
// caminhos (origem ou destino) passar pelo filtro: renomear "~WRD0001.tmp"
// para "contrato.docx" interessa, mesmo com ".tmp" excluído.
func (f Filter) Keep(ev Event) bool {
	if f.ExcludeMachineAccounts && strings.HasSuffix(ev.User.Name, "$") {
		return false
	}
	if ev.Path == "" && ev.NewPath == "" { // 4660 sem handle conhecido: mantém, o servidor pode correlacionar
		return len(f.IncludePaths) == 0
	}
	for _, p := range []string{ev.Path, ev.NewPath} {
		if p != "" && f.pathAllowed(p) {
			return true
		}
	}
	return false
}

func (f Filter) pathAllowed(path string) bool {
	p := strings.ToLower(path)
	for _, s := range f.ExcludePathContains {
		if s != "" && strings.Contains(p, strings.ToLower(s)) {
			return false
		}
	}
	if len(f.IncludePaths) == 0 {
		return true
	}
	for _, pre := range f.IncludePaths {
		if strings.HasPrefix(p, strings.ToLower(cleanPath(pre))) {
			return true
		}
	}
	return false
}
