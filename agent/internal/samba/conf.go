package samba

import (
	"bytes"
	"fmt"
	"path"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// Share é um compartilhamento como o testparm mostra (configuração efetiva).
type Share struct {
	Name string
	Path string
	// VFS são os módulos efetivos (os do compartilhamento ou, sem eles, os do [global]).
	VFS []string
	// Access são os parâmetros de acesso do compartilhamento (valid users,
	// read only, write list...), para o inventário de permissões.
	Access map[string]string
}

// AccessKeys são os parâmetros que definem quem acessa o compartilhamento.
var AccessKeys = []string{"valid users", "invalid users", "read list", "write list", "admin users", "read only", "guest ok", "guest only", "force user", "force group", "browseable", "available"}

// ParseTestparm lê a saída de "testparm -s": seções e parâmetros.
func ParseTestparm(out string) []Share {
	var shares []Share
	var global []string
	var cur *Share
	own := map[string]bool{}
	flush := func() {
		if cur != nil {
			shares = append(shares, *cur)
		}
	}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			name := line[1 : len(line)-1]
			cur = nil
			if !strings.EqualFold(name, "global") {
				cur = &Share{Name: name}
			}
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = normKey(k), strings.TrimSpace(v)
		switch {
		case cur == nil && k == "vfs objects":
			global = strings.Fields(v)
		case cur != nil && k == "path":
			cur.Path = path.Clean(v)
		case cur != nil && k == "vfs objects":
			cur.VFS = strings.Fields(v)
			own[cur.Name] = true
		case cur != nil && slices.Contains(AccessKeys, k):
			if cur.Access == nil {
				cur.Access = map[string]string{}
			}
			cur.Access[k] = v
		}
	}
	flush()
	for i := range shares {
		if !own[shares[i].Name] {
			shares[i].VFS = append([]string(nil), global...)
		}
	}
	return shares
}

func normKey(k string) string {
	k = strings.ToLower(strings.Join(strings.Fields(k), " "))
	if k == "vfs object" || k == "vfsobjects" || k == "vfsobject" {
		k = "vfs objects"
	}
	return k
}

// Overlaps diz se o compartilhamento dá acesso a algo dentro de dir (o
// compartilhamento contém a pasta, é ela ou está dentro dela).
func (s Share) Overlaps(dir string) bool {
	if s.Path == "" || strings.Contains(s.Path, "%") {
		return false // [homes] e caminhos com variáveis
	}
	return within(dir, s.Path) || within(s.Path, dir)
}

func within(child, parent string) bool {
	child, parent = path.Clean(child), path.Clean(parent)
	return child == parent || parent == "/" || strings.HasPrefix(child, parent+"/")
}

// HasFullAudit diz se o compartilhamento já usa o full_audit.
func (s Share) HasFullAudit() bool {
	for _, m := range s.VFS {
		if m == "full_audit" {
			return true
		}
	}
	return false
}

// Operações registradas. Os nomes mudam entre versões do Samba (mkdir
// virou mkdirat na 4.14); só entram os que o módulo instalado conhece,
// porque um nome desconhecido faz o compartilhamento recusar conexões.
var (
	SuccessOps = []string{"create_file", "mkdirat", "mkdir", "renameat", "rename", "unlinkat", "unlink", "rmdir",
		"fchmod", "chmod", "fchown", "chown", "lchown", "fset_nt_acl", "sys_acl_set_fd", "ftruncate"}
	FailureOps = []string{"create_file", "mkdirat", "mkdir", "renameat", "rename", "unlinkat", "unlink", "rmdir"}
)

// SupportedOps filtra as operações pelos nomes presentes no binário do
// módulo full_audit (strings terminadas em NUL na tabela de operações).
func SupportedOps(module []byte, ops []string) []string {
	var out []string
	for _, op := range ops {
		if bytes.Contains(module, []byte("\x00"+op+"\x00")) {
			out = append(out, op)
		}
	}
	return out
}

// Marcadores do bloco gerenciado dentro da seção do compartilhamento.
const (
	blockBegin  = "# >>> Tech Audit: auditoria do Samba gerenciada pelo agente (não edite entre estas linhas)"
	blockEnd    = "# <<< Tech Audit"
	disabledTag = "# techaudit-desativado: "
)

var (
	sectionRe = regexp.MustCompile(`^\s*\[([^\]]+)\]\s*$`)
	vfsLineRe = regexp.MustCompile(`(?i)^\s*vfs\s*objects?\s*=`)
	faLineRe  = regexp.MustCompile(`(?i)^\s*full_audit\s*:`)
)

// Settings são os parâmetros do full_audit gravados no compartilhamento.
type Settings struct {
	VFS     []string // módulos já usados pelo compartilhamento
	Success []string
	Failure []string
}

func (st Settings) lines() []string {
	vfs := append(append([]string(nil), st.VFS...), "full_audit")
	return []string{
		"\t" + blockBegin,
		"\tvfs objects = " + strings.Join(vfs, " "),
		"\tfull_audit:prefix = " + Prefix,
		"\tfull_audit:success = " + strings.Join(st.Success, " "),
		"\tfull_audit:failure = " + strings.Join(st.Failure, " "),
		"\tfull_audit:facility = LOCAL5",
		"\tfull_audit:priority = NOTICE",
		"\tfull_audit:syslog = yes",
		"\t" + blockEnd,
	}
}

// Enable grava o bloco do Tech Audit na seção do compartilhamento. Linhas
// "vfs objects" e "full_audit:" do próprio compartilhamento são comentadas
// com um marcador (o Samba usa o último valor da seção) e voltam no Disable.
func Enable(conf, share string, st Settings) (string, error) {
	lines := strings.Split(conf, "\n")
	start, end, ok := section(lines, share)
	if !ok {
		return "", fmt.Errorf("compartilhamento [%s] não está em %s (pode estar em um arquivo incluído); configure o full_audit manualmente", share, "smb.conf")
	}
	var body []string
	inBlock := false
	for _, l := range lines[start+1 : end] {
		t := strings.TrimSpace(l)
		switch {
		case t == blockBegin:
			inBlock = true
			continue
		case t == blockEnd:
			inBlock = false
			continue
		case inBlock:
			continue
		case vfsLineRe.MatchString(l) || faLineRe.MatchString(l):
			body = append(body, indentOf(l)+disabledTag+strings.TrimLeft(l, " \t"))
			continue
		}
		body = append(body, l)
	}
	out := append([]string{}, lines[:start+1]...)
	out = append(out, st.lines()...)
	out = append(out, body...)
	out = append(out, lines[end:]...)
	return strings.Join(out, "\n"), nil
}

// Disable retira o bloco e restaura as linhas comentadas. changed=false se
// o compartilhamento não tinha o bloco.
func Disable(conf, share string) (string, bool) {
	lines := strings.Split(conf, "\n")
	start, end, ok := section(lines, share)
	if !ok {
		return conf, false
	}
	var body []string
	inBlock, changed := false, false
	for _, l := range lines[start+1 : end] {
		t := strings.TrimSpace(l)
		switch {
		case t == blockBegin:
			inBlock, changed = true, true
			continue
		case t == blockEnd:
			inBlock = false
			continue
		case inBlock:
			continue
		case strings.HasPrefix(t, disabledTag):
			body = append(body, indentOf(l)+strings.TrimPrefix(t, disabledTag))
			changed = true
			continue
		}
		body = append(body, l)
	}
	if !changed {
		return conf, false
	}
	out := append([]string{}, lines[:start+1]...)
	out = append(out, body...)
	out = append(out, lines[end:]...)
	return strings.Join(out, "\n"), true
}

// Managed lista os compartilhamentos com o bloco do Tech Audit.
func Managed(conf string) []string {
	var out []string
	cur := ""
	for _, l := range strings.Split(conf, "\n") {
		if m := sectionRe.FindStringSubmatch(l); m != nil {
			cur = strings.TrimSpace(m[1])
			continue
		}
		if strings.TrimSpace(l) == blockBegin && cur != "" {
			out = append(out, cur)
		}
	}
	sort.Strings(out)
	return out
}

// Block devolve o bloco gravado no compartilhamento (para o antes/depois).
func Block(conf, share string) string {
	lines := strings.Split(conf, "\n")
	start, end, ok := section(lines, share)
	if !ok {
		return ""
	}
	var out []string
	in := false
	for _, l := range lines[start+1 : end] {
		t := strings.TrimSpace(l)
		if t == blockBegin {
			in = true
			continue
		}
		if t == blockEnd {
			break
		}
		if in || vfsLineRe.MatchString(l) {
			out = append(out, t)
		}
	}
	return strings.Join(out, "\n")
}

// section localiza a seção (sem diferenciar maiúsculas): linha do
// cabeçalho e linha onde a próxima seção começa.
func section(lines []string, share string) (start, end int, ok bool) {
	start = -1
	for i, l := range lines {
		m := sectionRe.FindStringSubmatch(l)
		if m == nil {
			continue
		}
		if start >= 0 {
			return start, i, true
		}
		if strings.EqualFold(strings.TrimSpace(m[1]), share) {
			start = i
		}
	}
	if start < 0 {
		return 0, 0, false
	}
	// Seção até o fim; linhas em branco finais ficam fora dela.
	end = len(lines)
	for end > start+1 && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	return start, end, true
}

func indentOf(l string) string {
	return l[:len(l)-len(strings.TrimLeft(l, " \t"))]
}
