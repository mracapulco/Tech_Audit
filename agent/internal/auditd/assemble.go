package auditd

import "time"

// Group são os registros de uma chamada de sistema (SYSCALL, CWD, PATH,
// PROCTITLE), na ordem do log.
type Group struct {
	Key     string
	Records []*Record
	// Offset é a posição no arquivo da primeira linha do grupo: o bookmark
	// não passa dela enquanto o grupo não termina.
	Offset int64
	first  time.Time
	keep   bool // o SYSCALL tem uma das chaves das regras do Tech Audit
	sys    bool // já recebeu o SYSCALL
}

// Syscall devolve o registro SYSCALL do grupo.
func (g *Group) Syscall() *Record { return g.find("SYSCALL") }

// CWD devolve a pasta atual do processo (registro CWD).
func (g *Group) CWD() string {
	if r := g.find("CWD"); r != nil {
		return r.Text("cwd")
	}
	return ""
}

// Proctitle devolve a linha de comando do processo (registro PROCTITLE).
func (g *Group) Proctitle() string {
	if r := g.find("PROCTITLE"); r != nil {
		return r.Text("proctitle")
	}
	return ""
}

// Paths devolve os registros PATH ordenados pelo número do item.
func (g *Group) Paths() []*Record {
	var out []*Record
	for _, r := range g.Records {
		if r.Type == "PATH" {
			out = append(out, r)
		}
	}
	for i := 1; i < len(out); i++ { // poucos itens: inserção
		for j := i; j > 0; j-- {
			a, _ := out[j-1].Uint("item", false)
			b, _ := out[j].Uint("item", false)
			if a <= b {
				break
			}
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

func (g *Group) find(typ string) *Record {
	for _, r := range g.Records {
		if r.Type == typ {
			return r
		}
	}
	return nil
}

// Assembler junta as linhas do log em grupos por evento. Só guarda os tipos
// de registro de uma chamada de sistema; os demais (logins, comandos do
// auditctl) são ignorados. Grupos cujo SYSCALL não tem uma das Keys são
// descartados ao terminar.
type Assembler struct {
	Keys map[string]bool
	// MaxAge força o fim de um grupo sem EOE depois desse tempo (pelo
	// horário dos registros). Padrão 2s.
	MaxAge time.Duration

	pending map[string]*Group
	order   []*Group
	newest  time.Time
}

// tipos de registro que fazem parte de uma chamada de sistema monitorada.
var groupTypes = map[string]bool{"SYSCALL": true, "CWD": true, "PATH": true, "PROCTITLE": true, "EOE": true}

// Add processa um registro lido na posição offset do arquivo e devolve os
// grupos que terminaram (EOE ou tempo esgotado) e interessam.
func (a *Assembler) Add(r *Record, offset int64) []*Group {
	if !groupTypes[r.Type] {
		return nil
	}
	if a.pending == nil {
		a.pending = map[string]*Group{}
	}
	if a.MaxAge <= 0 {
		a.MaxAge = 2 * time.Second
	}
	if r.Time.After(a.newest) {
		a.newest = r.Time
	}
	key := r.EventKey()
	g := a.pending[key]
	if g == nil {
		if r.Type == "EOE" {
			return a.expire()
		}
		g = &Group{Key: key, Offset: offset, first: r.Time}
		a.pending[key] = g
		a.order = append(a.order, g)
	}
	switch r.Type {
	case "EOE":
		g.Records = append(g.Records, r)
		return append(a.finish(g), a.expire()...)
	case "SYSCALL":
		g.sys = true
		g.keep = a.Keys[r.Text("key")]
	}
	if g.sys && !g.keep {
		// Não interessa: guarda só o necessário para reconhecer o EOE.
		g.Records = nil
	} else {
		g.Records = append(g.Records, r)
	}
	return a.expire()
}

// expire termina os grupos sem EOE mais velhos que MaxAge.
func (a *Assembler) expire() []*Group {
	var out []*Group
	for len(a.order) > 0 {
		g := a.order[0]
		if _, ok := a.pending[g.Key]; !ok {
			a.order = a.order[1:]
			continue
		}
		if a.newest.Sub(g.first) < a.MaxAge {
			break
		}
		out = append(out, a.finish(g)...)
	}
	return out
}

func (a *Assembler) finish(g *Group) []*Group {
	delete(a.pending, g.Key)
	for len(a.order) > 0 {
		if _, ok := a.pending[a.order[0].Key]; ok {
			break
		}
		a.order = a.order[1:]
	}
	if !g.keep || !g.sys {
		return nil
	}
	return []*Group{g}
}

// Flush termina todos os grupos pendentes (fim do arquivo sem novas linhas).
func (a *Assembler) Flush() []*Group {
	var out []*Group
	for len(a.order) > 0 {
		g := a.order[0]
		if _, ok := a.pending[g.Key]; !ok {
			a.order = a.order[1:]
			continue
		}
		out = append(out, a.finish(g)...)
	}
	return out
}

// MinOffset é a posição da primeira linha do grupo pendente mais antigo.
func (a *Assembler) MinOffset() (int64, bool) {
	min, ok := int64(0), false
	for _, g := range a.pending {
		if !ok || g.Offset < min {
			min, ok = g.Offset, true
		}
	}
	return min, ok
}

// Reset descarta os grupos pendentes (troca de arquivo).
func (a *Assembler) Reset() {
	a.pending = nil
	a.order = nil
}
