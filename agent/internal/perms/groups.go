package perms

import "strings"

// Member é um membro direto de um grupo.
type Member struct {
	Name string `json:"name"`
	SID  string `json:"sid,omitempty"`
	// Kind: user, group ou unknown.
	Kind string `json:"kind"`
}

// GroupInfo é um grupo citado nas permissões e quem faz parte dele.
type GroupInfo struct {
	Name    string   `json:"name"`
	SID     string   `json:"sid,omitempty"`
	Members []Member `json:"members"`
	// Note explica grupos sem lista de membros (ex.: Todos, Usuários autenticados).
	Note      string `json:"note,omitempty"`
	Error     string `json:"error,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}

// Limites do apêndice de grupos.
const (
	MaxGroups       = 300
	MaxGroupMembers = 2000
)

// ownerSuffixes são os sufixos que o inventário do Linux põe no nome do
// dono e do grupo dono da pasta.
var ownerSuffixes = []string{" (grupo dono)", " (dono)"}

func plainName(n string) string {
	for _, s := range ownerSuffixes {
		n = strings.TrimSuffix(n, s)
	}
	return n
}

// CollectGroups busca os membros de todos os grupos citados nas pastas e,
// por recursão, dos grupos que estão dentro deles.
func CollectGroups(r Reader, folders []Folder) []GroupInfo {
	type item struct{ name, sid string }
	var queue []item
	seen := map[string]bool{}
	// O mesmo grupo pode chegar pelo nome e pelo SID: marca os dois.
	keys := func(name, sid string) []string {
		k := []string{"n:" + strings.ToLower(name)}
		if sid != "" {
			k = append(k, strings.ToUpper(sid))
		}
		return k
	}
	mark := func(name, sid string) {
		for _, k := range keys(name, sid) {
			seen[k] = true
		}
	}
	push := func(name, sid string) {
		for _, k := range keys(name, sid) {
			if seen[k] {
				return
			}
		}
		mark(name, sid)
		queue = append(queue, item{name, sid})
	}
	for _, f := range folders {
		for _, e := range f.Entries {
			if e.Kind == "group" {
				push(plainName(e.Principal), e.SID)
			}
		}
	}
	var out []GroupInfo
	for i := 0; i < len(queue) && len(out) < MaxGroups; i++ {
		it := queue[i]
		g, err := r.Members(it.name, it.sid)
		if g.Name == "" {
			g.Name = it.name
		}
		if g.SID == "" {
			g.SID = it.sid
		}
		if err != nil {
			g.Error = err.Error()
		}
		mark(g.Name, g.SID)
		if len(g.Members) > MaxGroupMembers {
			g.Members, g.Truncated = g.Members[:MaxGroupMembers], true
		}
		if g.Members == nil {
			g.Members = []Member{}
		}
		for _, m := range g.Members {
			if m.Kind == "group" {
				push(m.Name, m.SID)
			}
		}
		out = append(out, g)
	}
	return out
}
