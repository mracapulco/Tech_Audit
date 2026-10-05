package perms

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/mracapulco/Tech_Audit/agent/internal/sddl"
)

// Leitura do dono e da DACL de um descritor em SDDL, sem chamadas ao
// Windows, para poder ser testada em qualquer sistema.

// Principal é um SID já traduzido para nome.
type Principal struct {
	Name string
	SID  string
	Kind string // user, group, unknown
}

// Resolver traduz um SID (S-1-5-... ou apelido SDDL como BA) em nome.
type Resolver func(sid string) Principal

// Máscaras das permissões básicas do Windows (Propriedades > Segurança).
const (
	maskFull         = 0x1f01ff
	maskModify       = 0x1301bf
	maskReadExecute  = 0x1200a9
	maskRead         = 0x120089
	maskWrite        = 0x100116
	maskSynchronize  = 0x100000
	genericAll       = 0x10000000
	genericRead      = 0x80000000
	genericWrite     = 0x40000000
	genericExecute   = 0x20000000
	fileGenericExec  = 0x1200a0
	fileGenericWrite = 0x120116
)

// expandGeneric troca os direitos genéricos (comuns em entradas só para
// herança, como CRIADOR PROPRIETÁRIO) pelos direitos de arquivo equivalentes.
func expandGeneric(m uint32) uint32 {
	if m&genericAll != 0 {
		m |= maskFull
	}
	if m&genericRead != 0 {
		m |= maskRead
	}
	if m&genericWrite != 0 {
		m |= fileGenericWrite
	}
	if m&genericExecute != 0 {
		m |= fileGenericExec
	}
	return m &^ (genericAll | genericRead | genericWrite | genericExecute)
}

// RightsLabel dá o nome da permissão como o Windows mostra. share usa os
// nomes da aba Permissões de compartilhamento (Alteração no lugar de Modificar).
func RightsLabel(mask uint32, share bool) string {
	m := expandGeneric(mask)
	has := func(want uint32) bool { return m&want == want }
	switch {
	case has(maskFull):
		return "Controle total"
	case has(maskModify):
		if share {
			return "Alteração"
		}
		return "Modificar"
	}
	var parts []string
	covered := uint32(maskSynchronize)
	switch {
	case has(maskReadExecute):
		parts, covered = append(parts, "Leitura e execução"), covered|maskReadExecute
	case has(maskRead):
		parts, covered = append(parts, "Leitura"), covered|maskRead
	}
	if has(maskWrite) {
		parts, covered = append(parts, "Gravação"), covered|maskWrite
	}
	if len(parts) == 0 {
		return "Especial"
	}
	label := strings.Join(parts, ", ")
	if m&^covered != 0 {
		label += " + especiais"
	}
	return label
}

// AppliesTo traduz os flags de herança de uma entrada.
func AppliesTo(flags []string) string {
	has := map[string]bool{}
	for _, f := range flags {
		has[f] = true
	}
	var s string
	switch {
	case has["IO"] && has["OI"] && has["CI"]:
		s = "Somente subpastas e arquivos"
	case has["IO"] && has["CI"]:
		s = "Somente subpastas"
	case has["IO"] && has["OI"]:
		s = "Somente arquivos"
	case has["OI"] && has["CI"]:
		s = "Esta pasta, subpastas e arquivos"
	case has["CI"]:
		s = "Esta pasta e subpastas"
	case has["OI"]:
		s = "Esta pasta e arquivos"
	default:
		s = "Somente esta pasta"
	}
	if has["NP"] && (has["OI"] || has["CI"]) {
		s += " (um nível)"
	}
	return s
}

var ownerRe = regexp.MustCompile(`O:(S-[0-9-]+|[A-Z]{2})`)

// rawACE é uma entrada da DACL como está no SDDL.
type rawACE struct {
	typ   string
	flags []string
	mask  uint32
	sid   string
}

// parseDACL extrai os flags e as entradas da parte "D:" de um SDDL.
func parseDACL(s string) (flags string, aces []rawACE, err error) {
	i := strings.Index(s, "D:")
	if i < 0 {
		return "", nil, nil
	}
	rest := s[i+2:]
	j := strings.IndexByte(rest, '(')
	if j < 0 {
		j = len(rest)
	}
	// Sem entradas, o que vem depois dos flags pode ser a SACL ("D:PS:...").
	if k := strings.Index(rest[:j], "S:"); k >= 0 {
		return rest[:k], nil, nil
	}
	if j == len(rest) {
		return rest, nil, nil
	}
	flags, rest = rest[:j], rest[j:]
	for rest != "" {
		if rest[0] != '(' {
			break // início da SACL ou fim
		}
		depth, end := 0, -1
		for k := 0; k < len(rest); k++ {
			switch rest[k] {
			case '(':
				depth++
			case ')':
				depth--
			}
			if depth == 0 {
				end = k
				break
			}
		}
		if end < 0 {
			return "", nil, fmt.Errorf("SDDL inválido: parêntese sem fechar")
		}
		f := strings.Split(rest[1:end], ";")
		rest = rest[end+1:]
		if len(f) < 6 {
			continue
		}
		mask, ok := sddl.ParseRights(f[2])
		if !ok {
			continue
		}
		var fl []string
		for k := 0; k+2 <= len(f[1]); k += 2 {
			fl = append(fl, strings.ToUpper(f[1][k:k+2]))
		}
		aces = append(aces, rawACE{typ: strings.ToUpper(f[0]), flags: fl, mask: mask, sid: strings.ToUpper(f[5])})
	}
	return flags, aces, nil
}

// FromSDDL monta a pasta a partir do descritor (dono e DACL) em SDDL.
// share indica permissões de compartilhamento.
func FromSDDL(desc string, resolve Resolver, share bool) (Folder, error) {
	var f Folder
	if m := ownerRe.FindStringSubmatch(desc); m != nil {
		f.Owner = resolve(m[1]).Name
	}
	flags, aces, err := parseDACL(desc)
	if err != nil {
		return f, err
	}
	f.Protected = strings.Contains(strings.ReplaceAll(flags, "AI", ""), "P")
	if !strings.Contains(desc, "D:") || flags == "NO_ACCESS_CONTROL" {
		// DACL nula: o Windows libera tudo para todos.
		f.Entries = []Entry{{Principal: "Todos (sem lista de permissões)", Kind: "group", Access: "allow", Rights: "Controle total", Raw: "nula", AppliesTo: appliesDefault(share)}}
		return f, nil
	}
	for _, a := range aces {
		var access string
		switch a.typ {
		case "A", "XA", "OA":
			access = "allow"
		case "D", "XD", "OD":
			access = "deny"
		default:
			continue
		}
		p := resolve(a.sid)
		inherited := false
		for _, fl := range a.flags {
			if fl == "ID" {
				inherited = true
			}
		}
		applies := AppliesTo(a.flags)
		if share {
			applies = appliesDefault(true)
		}
		f.Entries = append(f.Entries, Entry{
			Principal: p.Name, SID: p.SID, Kind: p.Kind, Access: access,
			Rights: RightsLabel(a.mask, share), Raw: fmt.Sprintf("0x%x", a.mask),
			Inherited: inherited, AppliesTo: applies,
		})
	}
	return f, nil
}

func appliesDefault(share bool) string {
	if share {
		return "Compartilhamento"
	}
	return "Esta pasta, subpastas e arquivos"
}

// DiffersNTFS: no Windows a pasta tem permissão própria quando a herança está
// desligada ou há alguma entrada explícita (não herdada).
func DiffersNTFS(child, _ *Folder) string {
	if child.Protected {
		return "protected"
	}
	for _, e := range child.Entries {
		if !e.Inherited {
			return "explicit"
		}
	}
	return ""
}

// WellKnown traz os apelidos SDDL mais comuns, usados quando o Windows não
// consegue traduzir o SID (e nos testes).
var WellKnown = map[string]Principal{
	"WD": {Name: "Todos", SID: "S-1-1-0", Kind: "group"},
	"CO": {Name: "CRIADOR PROPRIETÁRIO", SID: "S-1-3-0", Kind: "user"},
	"SY": {Name: "AUTORIDADE NT\\SISTEMA", SID: "S-1-5-18", Kind: "user"},
	"AU": {Name: "AUTORIDADE NT\\Usuários autenticados", SID: "S-1-5-11", Kind: "group"},
	"BA": {Name: "BUILTIN\\Administradores", SID: "S-1-5-32-544", Kind: "group"},
	"BU": {Name: "BUILTIN\\Usuários", SID: "S-1-5-32-545", Kind: "group"},
	"BG": {Name: "BUILTIN\\Convidados", SID: "S-1-5-32-546", Kind: "group"},
	"PU": {Name: "BUILTIN\\Usuários avançados", SID: "S-1-5-32-547", Kind: "group"},
	"BO": {Name: "BUILTIN\\Operadores de cópia", SID: "S-1-5-32-551", Kind: "group"},
	"SO": {Name: "BUILTIN\\Operadores de servidores", SID: "S-1-5-32-549", Kind: "group"},
	"IU": {Name: "AUTORIDADE NT\\INTERATIVO", SID: "S-1-5-4", Kind: "group"},
	"NU": {Name: "AUTORIDADE NT\\REDE", SID: "S-1-5-2", Kind: "group"},
	"SU": {Name: "AUTORIDADE NT\\SERVIÇO", SID: "S-1-5-6", Kind: "group"},
	"OW": {Name: "DIREITOS DE PROPRIETÁRIO", SID: "S-1-3-4", Kind: "group"},
}
