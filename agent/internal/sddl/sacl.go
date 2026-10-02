// Package sddl manipula a SACL (lista de auditoria) de um descritor de
// segurança em formato SDDL, sem chamadas ao Windows, para poder ser testado
// em qualquer sistema. O agente lê a SACL atual, acrescenta ou retira só a
// entrada de auditoria dele e grava de volta (docs/ARCHITECTURE.md, seção 4.6).
package sddl

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Direitos auditados (máscara de acesso de arquivos e pastas). Os mesmos que o
// coletor traduz em ações (agent/internal/event/access.go).
const (
	ReadData        = 0x1
	WriteData       = 0x2
	AppendData      = 0x4
	WriteEA         = 0x10
	DeleteChild     = 0x40
	WriteAttributes = 0x100
	Delete          = 0x10000
	WriteDAC        = 0x40000
	WriteOwner      = 0x80000

	// WriteMask cobre criar, escrever, excluir, alterar permissão e alterar dono.
	WriteMask = WriteData | AppendData | WriteEA | DeleteChild | WriteAttributes | Delete | WriteDAC | WriteOwner
)

// Everyone (WD): a auditoria vale para qualquer usuário.
const everyone = "WD"

// AuditACE monta a entrada de auditoria do Tech Audit: sucesso e falha, para
// Todos. recursive herda para subpastas e arquivos; sem ele, vale para a pasta
// e os arquivos diretamente nela.
func AuditACE(recursive, auditRead bool) string {
	mask := uint32(WriteMask)
	if auditRead {
		mask |= ReadData
	}
	flags := "OINP"
	if recursive {
		flags = "OICI"
	}
	return fmt.Sprintf("(AU;%sSAFA;0x%x;;;%s)", flags, mask, everyone)
}

// SACL é a parte "S:" de um SDDL: os flags (P = protegida contra herança,
// AI = herança automática) e as entradas, cada uma com os parênteses.
type SACL struct {
	Flags string
	ACEs  []string
}

// Parse extrai a SACL de um SDDL completo ou só da parte "S:". SDDL sem "S:"
// devolve uma SACL vazia.
func Parse(s string) (SACL, error) {
	i := strings.Index(s, "S:")
	if i < 0 {
		return SACL{}, nil
	}
	rest := s[i+2:]
	var out SACL
	j := strings.IndexByte(rest, '(')
	if j < 0 {
		out.Flags = rest
		return out, nil
	}
	out.Flags = rest[:j]
	rest = rest[j:]
	for rest != "" {
		if rest[0] != '(' {
			return SACL{}, fmt.Errorf("SDDL inválido perto de %q", truncate(rest))
		}
		// Entradas condicionais (XA/ZA) têm parênteses aninhados.
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
			return SACL{}, fmt.Errorf("SDDL inválido: parêntese sem fechar")
		}
		out.ACEs = append(out.ACEs, rest[:end+1])
		rest = rest[end+1:]
	}
	return out, nil
}

// String devolve "S:<flags><entradas>".
func (s SACL) String() string { return "S:" + s.Flags + strings.Join(s.ACEs, "") }

// Protected indica que a SACL não herda da pasta pai.
func (s SACL) Protected() bool { return strings.Contains(strings.ReplaceAll(s.Flags, "AI", ""), "P") }

type ace struct {
	typ   string
	flags []string
	mask  uint32
	sid   string
}

func parseACE(raw string) (ace, bool) {
	if !strings.HasPrefix(raw, "(") || !strings.HasSuffix(raw, ")") {
		return ace{}, false
	}
	f := strings.Split(raw[1:len(raw)-1], ";")
	if len(f) < 6 {
		return ace{}, false
	}
	mask, ok := parseRights(f[2])
	if !ok {
		return ace{}, false
	}
	var flags []string
	for k := 0; k+2 <= len(f[1]); k += 2 {
		flags = append(flags, strings.ToUpper(f[1][k:k+2]))
	}
	sort.Strings(flags)
	sid := strings.ToUpper(f[5])
	if sid == "S-1-1-0" {
		sid = everyone
	}
	return ace{typ: strings.ToUpper(f[0]), flags: flags, mask: mask, sid: sid}, true
}

func (a ace) inherited() bool {
	for _, f := range a.flags {
		if f == "ID" {
			return true
		}
	}
	return false
}

func (a ace) equal(b ace) bool {
	if a.typ != b.typ || a.mask != b.mask || a.sid != b.sid || len(a.flags) != len(b.flags) {
		return false
	}
	for i := range a.flags {
		if a.flags[i] != b.flags[i] {
			return false
		}
	}
	return true
}

// Apelidos de direitos que o Windows usa no SDDL no lugar da máscara.
var rightAliases = map[string]uint32{
	"GA": 0x10000000, "GR": 0x80000000, "GW": 0x40000000, "GX": 0x20000000,
	"RC": 0x20000, "SD": 0x10000, "WD": 0x40000, "WO": 0x80000,
	"RP": 0x10, "WP": 0x20, "CC": 0x1, "DC": 0x2, "LC": 0x4, "SW": 0x8, "LO": 0x80, "DT": 0x40, "CR": 0x100,
	"FA": 0x1f01ff, "FR": 0x120089, "FW": 0x120116, "FX": 0x1200a0,
	"KA": 0xf003f, "KR": 0x20019, "KW": 0x20006, "KX": 0x20019,
}

func parseRights(s string) (uint32, bool) {
	s = strings.ToUpper(strings.TrimSpace(s))
	if strings.HasPrefix(s, "0X") {
		v, err := strconv.ParseUint(s[2:], 16, 32)
		return uint32(v), err == nil
	}
	if len(s)%2 != 0 {
		return 0, false
	}
	var m uint32
	for k := 0; k < len(s); k += 2 {
		v, ok := rightAliases[s[k:k+2]]
		if !ok {
			return 0, false
		}
		m |= v
	}
	return m, true
}

// Explicit devolve a SACL só com as entradas explícitas: as herdadas (ID) são
// recalculadas pelo Windows ao gravar.
func (s SACL) Explicit() SACL {
	out := SACL{Flags: s.Flags}
	for _, raw := range s.ACEs {
		if a, ok := parseACE(raw); ok && a.inherited() {
			continue
		}
		out.ACEs = append(out.ACEs, raw)
	}
	return out
}

// Has indica se há uma entrada explícita equivalente a want (mesmo tipo,
// flags, direitos e SID, mesmo que escrita de outro jeito).
func (s SACL) Has(want string) bool {
	w, ok := parseACE(want)
	if !ok {
		return false
	}
	for _, raw := range s.ACEs {
		if a, ok := parseACE(raw); ok && !a.inherited() && a.equal(w) {
			return true
		}
	}
	return false
}

// With devolve a SACL explícita com want acrescentada; changed é false se
// ela já existia.
func (s SACL) With(want string) (out SACL, changed bool) {
	out = s.Explicit()
	if out.Has(want) {
		return out, false
	}
	out.ACEs = append(out.ACEs, want)
	return out, true
}

// Without devolve a SACL explícita sem as entradas equivalentes a want.
func (s SACL) Without(want string) (out SACL, changed bool) {
	w, ok := parseACE(want)
	explicit := s.Explicit()
	out = SACL{Flags: explicit.Flags}
	for _, raw := range explicit.ACEs {
		if a, okA := parseACE(raw); ok && okA && a.equal(w) {
			changed = true
			continue
		}
		out.ACEs = append(out.ACEs, raw)
	}
	return out, changed
}

func truncate(s string) string {
	if len(s) > 40 {
		return s[:40] + "…"
	}
	return s
}
