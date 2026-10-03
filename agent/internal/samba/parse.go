// Package samba coleta o acesso aos compartilhamentos Samba pelo módulo
// full_audit do próprio Samba (usuário, IP do computador, compartilhamento
// e caminho de cada operação) e configura esse módulo nos compartilhamentos
// das pastas auditadas.
//
// O full_audit escreve no syslog com o identificador smbd_audit; o agente lê
// pelo journalctl, guardando o cursor do journald como posição.
package samba

import (
	"fmt"
	"hash/fnv"
	"net"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// Kind é o valor do campo kind dos eventos vindos do Samba.
const Kind = "samba"

// Prefix é o formato do início de cada linha: usuário, domínio, IP do
// computador, compartilhamento e pasta do compartilhamento.
const Prefix = "%u|%D|%I|%S|%P"

const prefixFields = 5

// Message é uma linha do journald com identificador smbd_audit.
type Message struct {
	Cursor string
	Time   time.Time
	PID    string
	Text   string
}

// Parser converte as linhas do full_audit em eventos.
type Parser struct {
	Hostname string
	// Born devolve a data de criação do arquivo (statx), quando o sistema de
	// arquivos informa; distingue "criou" de "alterou" ao gravar.
	Born func(path string) (time.Time, bool)
	// Exists diz se o caminho existe (falhas do Samba nem sempre trazem o
	// motivo certo; ver denied).
	Exists func(path string) bool

	dirs map[string]bool // caminhos abertos como pasta, para o tipo da exclusão

	// renames do lote em análise (ParseBatch), para achar o nome atual de
	// um arquivo renomeado logo depois de criado.
	batch []batchRename
	cur   int
	// held são permissões de itens que já não existem, guardadas até o
	// lote seguinte: o create_file do mesmo item pode vir nele.
	held  []event.Event
	since map[uint64]time.Time // quando cada permissão guardada chegou
	now   func() time.Time
}

// holdFor é quanto uma permissão fica guardada esperando o create_file.
const holdFor = 2 * time.Second

type batchRename struct {
	at       int
	old, new string
}

const (
	maxDirCache = 20000
	bornSlack   = 3 * time.Second
)

// Direitos do campo access_mask do create_file (mesmos do Windows).
const (
	maskRead     = 0x1
	maskWrite    = 0x2
	maskAppend   = 0x4
	maskDelete   = 0x10000
	maskWriteDAC = 0x40000
	maskOwner    = 0x80000
)

// ParseBatch converte um lote de linhas. Ver o lote inteiro permite
// reconhecer como "criou" o arquivo que foi renomeado logo em seguida
// (o Word e outros programas gravam num nome temporário e renomeiam).
func (p *Parser) ParseBatch(ms []Message) []event.Event {
	p.batch = p.batch[:0]
	for i, m := range ms {
		f := strings.Split(m.Text, "|")
		if len(f) >= prefixFields+4 && (f[prefixFields] == "renameat" || f[prefixFields] == "rename") && f[prefixFields+1] == "ok" {
			args := f[prefixFields+2:]
			half := len(args) / 2
			root := f[4]
			p.batch = append(p.batch, batchRename{at: i, old: absPath(root, strings.Join(args[:half], "|")), new: absPath(root, strings.Join(args[half:], "|"))})
		}
	}
	out := p.held
	p.held = nil
	for i, m := range ms {
		p.cur = i
		if ev, ok := p.Parse(m); ok {
			out = append(out, ev)
		}
	}
	p.batch, p.cur = p.batch[:0], 0
	foldCreatePerms(out)
	if p.Exists == nil {
		return out
	}
	// Permissão de um item que sumiu e sem create_file no lote: espera até
	// holdFor pelo lote seguinte (o lote pode ter sido cortado entre as
	// duas linhas).
	now := time.Now
	if p.now != nil {
		now = p.now
	}
	t := now()
	keep := out[:0]
	for _, ev := range out {
		first, held := p.since[ev.RecordID]
		if ev.Action == event.ActionPermissionChanged && (held || !p.Exists(ev.Path)) && (!held || t.Sub(first) < holdFor) {
			if !held {
				if p.since == nil {
					p.since = map[uint64]time.Time{}
				}
				p.since[ev.RecordID] = t
			}
			p.held = append(p.held, ev)
			continue
		}
		delete(p.since, ev.RecordID)
		keep = append(keep, ev)
	}
	return keep
}

// foldCreatePerms marca como parte do "criou" as permissões que o Samba
// grava ao criar um item, quando o mesmo processo cria o item no mesmo
// lote (vale também para o item que já foi apagado e não tem mais data de
// criação para consultar).
func foldCreatePerms(evs []event.Event) {
	for i := range evs {
		e := &evs[i]
		if e.Action != event.ActionPermissionChanged {
			continue
		}
		for j := range evs {
			c := &evs[j]
			if c.Action == event.ActionCreated && c.Path == e.Path && c.ProcessID == e.ProcessID &&
				c.Time.Sub(e.Time) < bornSlack && e.Time.Sub(c.Time) < bornSlack {
				e.Action = event.ActionCreated
				e.Details["permissions_set_on_create"] = "true"
				if e.ItemType == "file" {
					e.ItemType = c.ItemType
				}
				break
			}
		}
	}
}

// current devolve o caminho atual de um item citado na linha p.cur,
// seguindo os renames posteriores do mesmo lote.
func (p *Parser) current(path string) string {
	for _, r := range p.batch {
		if r.at > p.cur && r.old == path {
			path = r.new
		}
	}
	return path
}

func absPath(root, s string) string {
	if s == "" || strings.HasPrefix(s, "/") {
		return path.Clean(s)
	}
	return path.Join(root, s) // versões antigas registram relativo ao compartilhamento
}

// Parse devolve o evento de uma linha, ou ok=false quando a operação não é
// uma ação sobre arquivo (abrir pasta, ler atributos, consultas).
func (p *Parser) Parse(m Message) (ev event.Event, ok bool) {
	f := strings.Split(m.Text, "|")
	if len(f) < prefixFields+2 {
		return ev, false
	}
	user, domain, ip, share, root := f[0], f[1], f[2], f[3], f[4]
	op, result, args := f[prefixFields], f[prefixFields+1], f[prefixFields+2:]
	success := result == "ok"
	ev = event.Event{
		RecordID:  RecordID(m.Cursor),
		Kind:      Kind,
		Time:      m.Time.UTC(),
		Computer:  p.Hostname,
		User:      parseUser(user, domain),
		ShareName: share,
		ClientIP:  cleanIP(ip),
		Process:   "smbd",
		ProcessID: m.PID,
		Outcome:   "success",
		Details:   map[string]string{"operation": op},
	}
	if !success {
		ev.Outcome = "failure"
		ev.Details["error"] = strings.TrimSuffix(strings.TrimPrefix(result, "fail ("), ")")
	}
	abs := func(s string) string { return absPath(root, s) }

	switch op {
	case "create_file":
		// create_file|ok|0x12019f|file|overwrite_if|/dados/a.txt
		if len(args) < 4 {
			return ev, false
		}
		mask, err := strconv.ParseUint(strings.TrimPrefix(args[0], "0x"), 16, 32)
		if err != nil {
			return ev, false
		}
		kind, disp := args[1], args[2]
		ev.Path = abs(strings.Join(args[3:], "|"))
		ev.AccessMask = fmt.Sprintf("0x%x", mask)
		ev.Actions = event.ActionsFromMask(ev.AccessMask)
		ev.Details["disposition"] = disp
		isDir := kind == "dir"
		ev.ItemType = itemType(isDir)
		if success {
			p.rememberDir(ev.Path, isDir)
		}
		if !success {
			return p.denied(ev, mask)
		}
		if isDir {
			return ev, false // criação de pasta vem no mkdirat; abrir pasta é navegação
		}
		switch {
		case mask&(maskWrite|maskAppend) != 0:
			ev.Action = event.ActionModified
			if disp == "create" || p.bornAt(ev.Path, ev.Time) || p.gone(ev.Path, disp) {
				ev.Action = event.ActionCreated
			}
		case mask&maskRead != 0:
			ev.Action = event.ActionRead
		default:
			return ev, false // só atributos, exclusão (vem no unlinkat) ou permissão (fset_nt_acl)
		}
		return ev, true
	case "mkdirat", "mkdir":
		ev.Path, ev.ItemType, ev.Action, ev.Actions = abs(strings.Join(args, "|")), "folder", event.ActionCreated, []string{"append"}
		p.rememberDir(ev.Path, true)
	case "renameat", "rename":
		if len(args) < 2 {
			return ev, false
		}
		// Caminhos com "|" (raros: o Windows não permite) ficam ambíguos;
		// assume metade para cada lado.
		half := len(args) / 2
		ev.Path, ev.NewPath = abs(strings.Join(args[:half], "|")), abs(strings.Join(args[half:], "|"))
		ev.Actions = []string{"delete"}
		ev.ItemType = itemType(p.dirs[ev.Path])
		switch {
		case isRecycle(ev.NewPath) && !isRecycle(ev.Path):
			ev.Action = event.ActionRecycled
		case path.Dir(ev.Path) == path.Dir(ev.NewPath):
			ev.Action = event.ActionRenamed
		default:
			ev.Action = event.ActionMoved
		}
		if success && p.dirs[ev.Path] {
			delete(p.dirs, ev.Path)
			p.rememberDir(ev.NewPath, true)
		}
	case "unlinkat", "unlink", "rmdir":
		ev.Path, ev.Action, ev.Actions = abs(strings.Join(args, "|")), event.ActionDeleted, []string{"delete"}
		ev.ItemType = itemType(op == "rmdir" || p.dirs[ev.Path])
		delete(p.dirs, ev.Path)
	case "fset_nt_acl", "sys_acl_set_fd", "fchmod", "chmod":
		if len(args) < 1 {
			return ev, false
		}
		// fset_nt_acl registra "caminho [descritor]".
		ev.Path, ev.Action, ev.Actions = abs(aclPath(args)), event.ActionPermissionChanged, []string{"permission_change"}
		ev.ItemType = itemType(p.dirs[ev.Path])
		if success && p.bornAt(ev.Path, ev.Time) {
			// O Samba grava as permissões herdadas logo ao criar o item
			// (antes até da linha do create_file): faz parte do "criou".
			ev.Action = event.ActionCreated
			ev.Details["permissions_set_on_create"] = "true"
		}
	case "fchown", "lchown", "chown":
		if len(args) < 1 {
			return ev, false
		}
		ev.Path, ev.Action, ev.Actions = abs(args[0]), event.ActionOwnerChanged, []string{"owner_change"}
		ev.ItemType = itemType(p.dirs[ev.Path])
	case "ftruncate":
		if len(args) < 1 {
			return ev, false
		}
		ev.Path, ev.Action, ev.Actions, ev.ItemType = abs(args[0]), event.ActionModified, []string{"write"}, "file"
	default:
		return ev, false
	}
	if !success {
		return p.denied(ev, 0)
	}
	return ev, ev.Path != ""
}

// denied trata uma falha. O texto do Samba vem do errno do momento, que
// nem sempre é o da recusa (acesso negado aparece como "No such file or
// directory"): conta como acesso negado quando o motivo é permissão ou
// quando o item existe. Arquivo em uso por outra pessoa também cai aqui.
func (p *Parser) denied(ev event.Event, mask uint64) (event.Event, bool) {
	reason := strings.ToLower(ev.Details["error"])
	explicit := strings.Contains(reason, "permission denied") || strings.Contains(reason, "operation not permitted") ||
		strings.Contains(reason, "access_denied") || strings.Contains(reason, "access denied")
	if !explicit {
		if ev.Path == "" || p.Exists == nil || !p.Exists(ev.Path) {
			return ev, false
		}
		if ev.Details["operation"] == "create_file" && mask&(maskRead|maskWrite|maskAppend|maskDelete|maskWriteDAC|maskOwner) == 0 {
			return ev, false
		}
	}
	ev.Action = event.ActionDenied
	return ev, true
}

func (p *Parser) bornAt(path string, t time.Time) bool {
	if p.Born == nil {
		return false
	}
	b, ok := p.Born(p.current(path))
	if !ok {
		return false
	}
	d := b.Sub(t)
	return d < bornSlack && d > -bornSlack
}

// gone diz se um arquivo aberto para gravação com uma disposição que cria
// o arquivo já não existe: temporário criado e apagado logo em seguida
// conta como "criou", não como "alterou".
func (p *Parser) gone(path, disp string) bool {
	if p.Exists == nil {
		return false
	}
	switch disp {
	case "overwrite_if", "open_if", "supersede":
		return !p.Exists(p.current(path))
	}
	return false
}

// aclPath tira o " [descritor]" que o fset_nt_acl põe depois do caminho.
func aclPath(args []string) string {
	s := strings.Join(args, "|")
	if strings.HasSuffix(s, "]") {
		if i := strings.LastIndex(s, " ["); i > 0 {
			s = s[:i]
		}
	}
	return s
}

func (p *Parser) rememberDir(path string, isDir bool) {
	if p.dirs == nil || len(p.dirs) >= maxDirCache {
		p.dirs = map[string]bool{}
	}
	if isDir {
		p.dirs[path] = true
	} else {
		delete(p.dirs, path)
	}
}

// parseUser separa "DOMINIO\usuario" (winbind) ou usa o domínio do %D.
func parseUser(u, domain string) event.User {
	if d, n, ok := strings.Cut(u, `\`); ok {
		return event.User{Name: n, Domain: d}
	}
	if n, d, ok := strings.Cut(u, "@"); ok {
		return event.User{Name: n, Domain: d}
	}
	return event.User{Name: u, Domain: domain}
}

// cleanIP tira o prefixo IPv4 mapeado em IPv6 ("::ffff:10.0.0.5"); o que
// não for IP vira vazio.
func cleanIP(ip string) string {
	ip = strings.TrimPrefix(ip, "::ffff:")
	if net.ParseIP(ip) == nil {
		return ""
	}
	return ip
}

func isRecycle(p string) bool { return strings.Contains(p, "/.recycle/") }

func itemType(dir bool) string {
	if dir {
		return "folder"
	}
	return "file"
}

// RecordID é um número estável para a linha (cursor do journald), com até
// 53 bits: o servidor descarta repetições pelo par agente+record_id.
func RecordID(cursor string) uint64 {
	h := fnv.New64a()
	h.Write([]byte(cursor))
	return h.Sum64() & (1<<53 - 1)
}
