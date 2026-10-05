package auditcfg

import (
	"strings"
	"sync"
)

// Exclusions decide se um evento de arquivo deve ser ignorado pelos padrões
// configurados no portal para o caminho auditado que o contém. Seguro para
// uso concorrente: a configuração muda enquanto o coletor lê.
type Exclusions struct {
	mu    sync.RWMutex
	rules []exclusionRule
	roots []Root
	known bool // já recebeu a configuração do portal
}

// Root é um caminho auditado ativo, para o coletor do Linux saber o que
// monitorar e o que descartar (o Samba registra o compartilhamento inteiro).
type Root struct {
	Path      string
	Recursive bool
	AuditRead bool
}

type exclusionRule struct {
	root     string // caminho auditado, em minúsculas, terminado em \
	patterns []string
}

func (x *Exclusions) set(paths []PathConfig) {
	var rules []exclusionRule
	var roots []Root
	for _, p := range paths {
		if p.State != "active" {
			continue
		}
		roots = append(roots, Root{Path: p.Path, Recursive: p.Recursive, AuditRead: p.AuditRead})
		if len(p.Exclusions) == 0 {
			continue
		}
		r := exclusionRule{root: strings.TrimRight(slashes(strings.ToLower(p.Path)), `\`) + `\`}
		for _, e := range p.Exclusions {
			r.patterns = append(r.patterns, strings.ToLower(strings.Trim(slashes(e), `\`)))
		}
		rules = append(rules, r)
	}
	x.mu.Lock()
	x.rules, x.roots, x.known = rules, roots, true
	x.mu.Unlock()
}

// slashes troca "/" por "\": as regras valem igual para caminhos do
// Windows e do Linux (no Linux, sem diferenciar maiúsculas).
func slashes(p string) string { return strings.ReplaceAll(p, "/", `\`) }

// Roots devolve os caminhos ativos; known=false enquanto o portal não respondeu.
func (x *Exclusions) Roots() (roots []Root, known bool) {
	if x == nil {
		return nil, false
	}
	x.mu.RLock()
	defer x.mu.RUnlock()
	return append([]Root(nil), x.roots...), x.known
}

// InScope diz se um caminho do Linux está dentro de algum caminho ativo
// (sem subpastas quando o caminho não é recursivo) e, para leituras, se a
// auditoria de leitura está ligada. Antes da primeira resposta do portal
// tudo passa.
func (x *Exclusions) InScope(path string, read bool) bool {
	roots, known := x.Roots()
	if !known {
		return true
	}
	for _, r := range roots {
		root := strings.TrimRight(r.Path, "/")
		var rel string
		switch {
		case path == r.Path || path == root:
			rel = ""
		case strings.HasPrefix(path, root+"/"):
			rel = path[len(root)+1:]
		default:
			continue
		}
		if !r.Recursive && strings.Contains(rel, "/") {
			continue
		}
		if read && !r.AuditRead {
			continue
		}
		return true
	}
	return false
}

// ReadAllowed diz se uma leitura nesse caminho deve ser enviada: vale a
// opção "Auditar também leituras" do caminho auditado mais específico que o
// contém. A SACL de uma pasta-pai, uma entrada antiga ou uma política do
// Windows podem gerar leituras que o portal não pediu; elas são descartadas.
// Antes da primeira resposta do portal, ou sem caminhos configurados, tudo
// passa.
func (x *Exclusions) ReadAllowed(path string) bool {
	roots, known := x.Roots()
	if !known || len(roots) == 0 || path == "" {
		return true
	}
	best, allowed := -1, false
	for _, r := range roots {
		rel, sep, ok := relPath(path, r.Path)
		if !ok || (!r.Recursive && strings.Contains(rel, sep)) {
			continue
		}
		if n := len(r.Path); n > best {
			best, allowed = n, r.AuditRead
		}
	}
	return allowed
}

// relPath devolve o caminho relativo a root, se path estiver dentro dele.
// No Windows sem diferenciar maiúsculas e aceitando / ou \; no Linux
// (caminho começando com /) exato.
func relPath(path, root string) (rel, sep string, ok bool) {
	if !strings.HasPrefix(root, "/") {
		path, root = slashes(strings.ToLower(path)), slashes(strings.ToLower(root))
	}
	sep = `\`
	if strings.HasPrefix(root, "/") {
		sep = "/"
	}
	root = strings.TrimRight(root, sep)
	switch {
	case path == root || path == root+sep:
		return "", sep, true
	case strings.HasPrefix(path, root+sep):
		return path[len(root)+1:], sep, true
	}
	return "", sep, false
}

// Excluded: padrões sem "\" valem para qualquer nome de arquivo ou pasta
// dentro do caminho auditado (ex.: *.tmp, ~$*, Temp); padrões com "\" são
// subpastas relativas ao caminho auditado (ex.: Backup\Antigo).
func (x *Exclusions) Excluded(path string) bool {
	if x == nil || path == "" {
		return false
	}
	p := slashes(strings.ToLower(path))
	x.mu.RLock()
	defer x.mu.RUnlock()
	for _, r := range x.rules {
		if !strings.HasPrefix(p, r.root) {
			continue
		}
		rel := p[len(r.root):]
		segs := strings.Split(rel, `\`)
		for _, pat := range r.patterns {
			if strings.Contains(pat, `\`) {
				if rel == pat || strings.HasPrefix(rel, pat+`\`) || glob(pat, rel) {
					return true
				}
				continue
			}
			for _, s := range segs {
				if glob(pat, s) {
					return true
				}
			}
		}
	}
	return false
}

// glob compara com * (qualquer sequência) e ? (um caractere).
func glob(pattern, s string) bool {
	p, t := []rune(pattern), []rune(s)
	pi, ti, star, mark := 0, 0, -1, 0
	for ti < len(t) {
		switch {
		case pi < len(p) && (p[pi] == '?' || p[pi] == t[ti]):
			pi++
			ti++
		case pi < len(p) && p[pi] == '*':
			star, mark = pi, ti
			pi++
		case star >= 0:
			pi = star + 1
			mark++
			ti = mark
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}
