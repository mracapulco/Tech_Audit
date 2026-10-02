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
}

type exclusionRule struct {
	root     string // caminho auditado, em minúsculas, terminado em \
	patterns []string
}

func (x *Exclusions) set(paths []PathConfig) {
	var rules []exclusionRule
	for _, p := range paths {
		if p.State != "active" || len(p.Exclusions) == 0 {
			continue
		}
		r := exclusionRule{root: strings.TrimRight(strings.ToLower(p.Path), `\`) + `\`}
		for _, e := range p.Exclusions {
			r.patterns = append(r.patterns, strings.ToLower(strings.Trim(e, `\`)))
		}
		rules = append(rules, r)
	}
	x.mu.Lock()
	x.rules = rules
	x.mu.Unlock()
}

// Excluded: padrões sem "\" valem para qualquer nome de arquivo ou pasta
// dentro do caminho auditado (ex.: *.tmp, ~$*, Temp); padrões com "\" são
// subpastas relativas ao caminho auditado (ex.: Backup\Antigo).
func (x *Exclusions) Excluded(path string) bool {
	if x == nil || path == "" {
		return false
	}
	p := strings.ToLower(path)
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
