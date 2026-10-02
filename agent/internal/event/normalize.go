package event

import (
	"strings"
)

// Filter define quais eventos são descartados antes do envio.
type Filter struct {
	// ExcludeMachineAccounts descarta contas de computador (terminadas em "$").
	ExcludeMachineAccounts bool `json:"exclude_machine_accounts"`
	// ObjectTypes restringe 4656/4663 a esses tipos de objeto (ex.: "File"). Vazio aceita todos.
	ObjectTypes []string `json:"object_types"`
	// IncludePaths, se preenchido, mantém apenas caminhos com um desses prefixos (sem diferenciar maiúsculas).
	IncludePaths []string `json:"include_paths"`
	// ExcludePathContains descarta caminhos que contenham algum desses trechos (sem diferenciar maiúsculas).
	ExcludePathContains []string `json:"exclude_path_contains"`
}

// Normalizer converte eventos brutos no formato Event. Ele guarda o caminho de
// cada handle aberto (visto em 4656/4663) para resolver o caminho do 4660,
// que só informa o HandleId.
type Normalizer struct {
	Filter  Filter
	maxKeys int
	handles map[string]string
	order   []string
}

// NewNormalizer cria um Normalizer que lembra até maxHandles handles recentes.
func NewNormalizer(f Filter, maxHandles int) *Normalizer {
	if maxHandles <= 0 {
		maxHandles = 10000
	}
	return &Normalizer{Filter: f, maxKeys: maxHandles, handles: map[string]string{}}
}

// Normalize retorna o evento normalizado, ou ok=false se ele deve ser descartado.
func (n *Normalizer) Normalize(r *Raw) (ev Event, ok bool) {
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
		if !n.typeAllowed(ev.ObjectType) {
			return ev, false
		}
		if ev.Path != "" && ev.HandleID != "" && ev.HandleID != "0x0" {
			n.remember(handleKey(r, d), ev.Path)
		}
	case IDObjectDeleted:
		ev.Kind = "object_deleted"
		ev.Actions = []string{"delete"}
		ev.Path = n.handles[handleKey(r, d)]
	case IDShareAccess:
		ev.Kind = "share_access"
		ev.ShareName = d["ShareName"]
		ev.ClientIP = d["IpAddress"]
		ev.Path = joinShare(d["ShareLocalPath"], d["RelativeTargetName"])
		ev.Actions = actions(d)
		if !n.typeAllowed(ev.ObjectType) {
			return ev, false
		}
	default:
		return ev, false
	}

	if ev.Actions == nil {
		ev.Actions = []string{}
	}
	return ev, n.keep(ev)
}

func actions(d map[string]string) []string {
	if a := ActionsFromMask(d["AccessMask"]); len(a) > 0 {
		return a
	}
	return ActionsFromAccessList(d["AccessList"])
}

func handleKey(r *Raw, d map[string]string) string {
	return r.Computer + "|" + d["ProcessId"] + "|" + d["HandleId"]
}

func (n *Normalizer) remember(key, path string) {
	if _, exists := n.handles[key]; !exists {
		n.order = append(n.order, key)
	}
	n.handles[key] = path
	for len(n.order) > n.maxKeys {
		delete(n.handles, n.order[0])
		n.order = n.order[1:]
	}
}

func (n *Normalizer) typeAllowed(t string) bool {
	if len(n.Filter.ObjectTypes) == 0 || t == "" {
		return true
	}
	for _, ok := range n.Filter.ObjectTypes {
		if strings.EqualFold(ok, t) {
			return true
		}
	}
	return false
}

func (n *Normalizer) keep(ev Event) bool {
	f := n.Filter
	if f.ExcludeMachineAccounts && strings.HasSuffix(ev.User.Name, "$") {
		return false
	}
	p := strings.ToLower(ev.Path)
	for _, s := range f.ExcludePathContains {
		if s != "" && strings.Contains(p, strings.ToLower(s)) {
			return false
		}
	}
	if len(f.IncludePaths) == 0 {
		return true
	}
	if ev.Path == "" { // 4660 sem handle conhecido: mantém, o servidor pode correlacionar
		return ev.EventID == IDObjectDeleted
	}
	for _, pre := range f.IncludePaths {
		if strings.HasPrefix(p, strings.ToLower(cleanPath(pre))) {
			return true
		}
	}
	return false
}
