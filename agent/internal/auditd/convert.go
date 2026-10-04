package auditd

import (
	"fmt"
	"hash/fnv"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// Chaves das regras do auditd criadas pelo agente: escrita/atributos e
// leitura (só nos caminhos com auditoria de leitura).
const (
	KeyWrite = "techaudit"
	KeyRead  = "techaudit-r"
)

// Kind é o valor do campo kind dos eventos vindos do auditd.
const Kind = "auditd"

// unsetID é o auid de processos sem login (serviços); as regras os excluem.
const unsetID = 4294967295

// Converter transforma um grupo do log em um evento do Tech Audit.
type Converter struct {
	// Hostname é o nome do servidor, usado como domínio de contas locais.
	Hostname string
	Dirs     *DirMap
	// UserName traduz um uid quando o log não vem no formato ENRICHED.
	UserName func(uid uint64) string
	// MissingDir é chamado quando uma pasta não está no mapa (o coletor
	// agenda uma nova varredura).
	MissingDir func()
	// SearchLimit limita quantas pastas FindChild consulta. Padrão 20000.
	SearchLimit int
}

// item é um registro PATH já interpretado.
type item struct {
	rec      *Record
	name     string
	key      FileKey
	isDir    bool
	nametype string
}

func parseItem(r *Record) item {
	ino, _ := r.Uint("inode", false)
	mode := r.Fields["mode"]
	return item{
		rec:      r,
		name:     r.Text("name"),
		key:      FileKey{Dev: r.Fields["dev"], Ino: ino},
		isDir:    strings.HasPrefix(mode, "040"),
		nametype: r.Fields["nametype"],
	}
}

// Convert devolve o evento do grupo, ou ok=false quando a chamada não
// interessa (falha que não é acesso negado, leitura de pasta...).
func (c *Converter) Convert(g *Group) (ev event.Event, ok bool) {
	sc := g.Syscall()
	if sc == nil {
		return ev, false
	}
	name := syscallName(sc)
	class := syscallClass[name]
	if class == "" {
		return ev, false
	}
	success := sc.Fields["success"] != "no"
	if !success {
		code, _ := sc.Int("exit")
		if code != -13 && code != -1 { // só EACCES e EPERM são "acesso negado"
			return ev, false
		}
	}

	var items []item
	for _, r := range g.Paths() {
		items = append(items, parseItem(r))
	}
	cwd := g.CWD()
	ev = event.Event{
		RecordID:  RecordID(g.Key),
		Kind:      Kind,
		Time:      sc.Time,
		Computer:  c.Hostname,
		User:      c.user(sc),
		Process:   sc.Text("exe"),
		ProcessID: sc.Fields["pid"],
		Outcome:   "success",
		Details:   map[string]string{"syscall": name},
	}
	if uid, ok := sc.Uint("uid", false); ok {
		if auid, ok2 := sc.Uint("auid", false); ok2 && uid != auid {
			ev.Details["run_as"] = c.idName(sc, "UID", uid)
		}
	}
	if !success {
		ev.Outcome = "failure"
	}
	key := sc.Text("key")

	// Primeiro item com o objeto da chamada (não a pasta pai).
	var obj, parent *item
	for i := range items {
		it := &items[i]
		switch it.nametype {
		case "PARENT":
			if parent == nil {
				parent = it
			}
		default:
			if obj == nil && (it.nametype != "UNKNOWN" || it.name != "") {
				obj = it
			}
		}
	}

	switch class {
	case opRename:
		return c.rename(ev, sc, name, items, cwd)
	case opOpen:
		if obj == nil {
			return ev, false
		}
		ev.Path, ok = c.resolve(*obj, parent, cwd, sc, name)
		switch {
		case obj.nametype == "CREATE":
			ev.Action, ev.ItemType, ev.Actions = event.ActionCreated, "file", []string{"write"}
		case obj.isDir:
			return ev, false // abrir pasta (listar) não é ação sobre arquivo
		case key == KeyRead && !openForWrite(sc, name):
			ev.Action, ev.ItemType, ev.Actions = event.ActionRead, "file", []string{"read"}
		default:
			ev.Action, ev.ItemType, ev.Actions = event.ActionModified, "file", []string{"write"}
		}
		if obj.nametype == "CREATE" && success {
			c.Dirs.RememberFile(obj.key, ev.Path)
		}
	case opTruncate:
		if obj == nil {
			return ev, false
		}
		ev.Path, ok = c.resolve(*obj, parent, cwd, sc, name)
		ev.Action, ev.ItemType, ev.Actions = event.ActionModified, "file", []string{"write"}
	case opMkdir, opCreate:
		if obj == nil {
			return ev, false
		}
		ev.Path, ok = c.resolve(*obj, parent, cwd, sc, name)
		ev.Action, ev.Actions = event.ActionCreated, []string{"append"}
		ev.ItemType = "file"
		if class == opMkdir {
			ev.ItemType = "folder"
			if success && parent != nil {
				c.Dirs.AddDir(obj.key, parent.key, filepath.Base(ev.Path))
			}
		} else if success {
			c.Dirs.RememberFile(obj.key, ev.Path)
		}
	case opDelete:
		if obj == nil {
			return ev, false
		}
		ev.Path, ok = c.resolve(*obj, parent, cwd, sc, name)
		ev.Action, ev.Actions = event.ActionDeleted, []string{"delete"}
		ev.ItemType = itemType(obj.isDir || name == "rmdir" || (name == "unlinkat" && sc.Fields["a2"] == "200"))
		if success {
			if ev.ItemType == "folder" {
				c.Dirs.Remove(obj.key)
			}
			c.Dirs.ForgetFile(obj.key)
		}
	case opChmod, opChown, opXattr, opUtime:
		if obj == nil {
			return ev, false
		}
		ev.Path, ok = c.resolve(*obj, parent, cwd, sc, name)
		ev.ItemType = itemType(obj.isDir)
		switch class {
		case opChmod, opXattr:
			// setxattr em arquivo de servidor é quase sempre ACL (setfacl).
			ev.Action, ev.Actions = event.ActionPermissionChanged, []string{"permission_change"}
		case opChown:
			ev.Action, ev.Actions = event.ActionOwnerChanged, []string{"owner_change"}
		default:
			ev.Action, ev.Actions = event.ActionAttributesChanged, []string{"write_attributes"}
		}
	}
	if !ok {
		ev.Details["path_unresolved"] = "true"
	}
	if !success {
		ev.Action = event.ActionDenied
	}
	return ev, ev.Path != ""
}

// rename trata rename/renameat/renameat2: itens PARENT (pastas de origem e
// destino), DELETE (nome antigo) e CREATE (nome novo). Se o destino já
// existia, há um segundo DELETE: o arquivo foi salvo por cima (editores
// gravam um temporário e renomeiam), o que vira "alterou".
func (c *Converter) rename(ev event.Event, sc *Record, name string, items []item, cwd string) (event.Event, bool) {
	var parents, deletes []*item
	var created *item
	for i := range items {
		it := &items[i]
		switch it.nametype {
		case "PARENT":
			parents = append(parents, it)
		case "DELETE":
			deletes = append(deletes, it)
		case "CREATE":
			if created == nil {
				created = it
			}
		}
	}
	if len(deletes) == 0 || created == nil {
		return ev, false
	}
	old := deletes[0]
	for _, d := range deletes {
		if d.key == created.key {
			old = d
		}
	}
	var oldParent, newParent *item
	switch len(parents) {
	case 0:
	case 1:
		oldParent, newParent = parents[0], parents[0]
	default:
		// O kernel registra a pasta de destino primeiro; confirma pelo
		// inode do nome novo quando as pastas são diferentes.
		newParent, oldParent = parents[0], parents[1]
		if parents[0].key != parents[1].key {
			if d, ok := c.Dirs.Path(parents[1].key); ok && c.Dirs.Stat != nil {
				if k, _, err := c.Dirs.Stat(filepath.Join(d, filepath.Base(created.name))); err == nil && k == created.key {
					newParent, oldParent = parents[1], parents[0]
				}
			}
		}
	}
	oldPath, ok1 := c.resolveArg(*old, oldParent, cwd, sc, dirfdArg[name], true)
	// O inode do nome novo é o mesmo do antigo: o cache de arquivos ainda
	// aponta para o caminho de antes.
	newPath, ok2 := c.resolveArg(*created, newParent, cwd, sc, newDirfdArg[name], false)
	if !ok1 || !ok2 {
		ev.Details["path_unresolved"] = "true"
	}
	ev.Path, ev.NewPath = oldPath, newPath
	ev.ItemType = itemType(created.isDir)
	ev.Actions = []string{"delete"}
	switch {
	case ev.Outcome == "failure":
		ev.Action = event.ActionDenied
	case len(deletes) > 1:
		// "salvar" de editores: temporário renomeado por cima do original.
		ev.Action = event.ActionModified
		ev.Path, ev.NewPath = newPath, ""
		ev.Actions = []string{"write"}
		ev.Details["saved_from"] = oldPath
	case isTrash(newPath) && !isTrash(oldPath):
		ev.Action = event.ActionRecycled
	case oldParent != nil && newParent != nil && oldParent.key == newParent.key:
		ev.Action = event.ActionRenamed
	default:
		ev.Action = event.ActionMoved
	}
	if ev.Outcome == "success" {
		if created.isDir && newParent != nil {
			c.Dirs.AddDir(created.key, newParent.key, filepath.Base(newPath))
		} else {
			c.Dirs.RememberFile(created.key, newPath)
		}
	}
	return ev, ev.Path != ""
}

// isTrash reconhece a lixeira do Samba (vfs_recycle) e a do desktop Linux.
func isTrash(p string) bool {
	return strings.Contains(p, "/.recycle/") || strings.Contains(p, "/.Trash") || strings.Contains(p, "/.local/share/Trash/")
}

func (c *Converter) resolve(it item, parent *item, cwd string, sc *Record, name string) (string, bool) {
	return c.resolveArg(it, parent, cwd, sc, dirfdArg[name], true)
}

// resolveArg monta o caminho completo de um item. arg é o argumento da
// chamada com o dirfd do caminho ("" para chamadas relativas à pasta atual);
// cached permite usar o cache de arquivos vistos há pouco.
func (c *Converter) resolveArg(it item, parent *item, cwd string, sc *Record, arg string, cached bool) (string, bool) {
	base := filepath.Base(it.name)
	// 1. Pasta pai conhecida pelo inode: o mais confiável (o nome registrado
	// para a pasta pai nem sempre é o dela).
	if parent != nil && it.name != "" {
		if d, ok := c.Dirs.Path(parent.key); ok {
			return filepath.Join(d, base), true
		}
		c.missing()
	}
	// 2. Caminho absoluto.
	if strings.HasPrefix(it.name, "/") {
		return filepath.Clean(it.name), true
	}
	// 3. Relativo à pasta atual (chamada sem dirfd, ou com AT_FDCWD).
	if it.name != "" && cwd != "" && (arg == "" || isATFDCWD(sc.Fields[arg])) && !pathless[syscallName(sc)] {
		return filepath.Join(cwd, it.name), true
	}
	// 4. O próprio item é uma pasta conhecida ou um arquivo visto há pouco.
	if it.isDir {
		if d, ok := c.Dirs.Path(it.key); ok {
			return d, true
		}
	} else if cached {
		if p, ok := c.Dirs.File(it.key); ok {
			return p, true
		}
	}
	// 5. Procura o nome nas pastas conhecidas pelo inode.
	limit := c.SearchLimit
	if limit <= 0 {
		limit = 20000
	}
	if p, ok := c.Dirs.FindChild(base, it.key, limit); ok {
		c.Dirs.RememberFile(it.key, p)
		return p, true
	}
	c.missing()
	if it.name == "" {
		return "", false
	}
	return ".../" + base, false
}

func (c *Converter) missing() {
	if c.MissingDir != nil {
		c.MissingDir()
	}
}

// user identifica quem fez: o usuário do login (auid), que se mantém após
// sudo ou su. O usuário efetivo, se diferente, vai em details.run_as.
func (c *Converter) user(sc *Record) event.User {
	id, ok := sc.Uint("auid", false)
	field := "AUID"
	if !ok || id == unsetID {
		id, _ = sc.Uint("uid", false)
		field = "UID"
	}
	n := c.idName(sc, field, id)
	u := event.User{Name: n, Domain: shortHost(c.Hostname), SID: "uid:" + strconv.FormatUint(id, 10), LogonID: sc.Fields["ses"]}
	// Contas de domínio (SSSD/winbind): "DOMINIO\usuario" ou "usuario@dominio".
	if d, user, ok := strings.Cut(n, `\`); ok {
		u.Domain, u.Name = d, user
	} else if user, d, ok := strings.Cut(n, "@"); ok {
		u.Domain, u.Name = d, user
	}
	if u.Domain != shortHost(c.Hostname) {
		u.SID = "" // o uid de um usuário de domínio varia entre servidores
	}
	return u
}

func (c *Converter) idName(sc *Record, field string, id uint64) string {
	if sc.Enriched != nil {
		if n := decodeText(sc.Enriched[field]); n != "" && n != "unset" && !strings.HasPrefix(n, "unknown(") {
			return n
		}
	}
	if c.UserName != nil {
		if n := c.UserName(id); n != "" {
			return n
		}
	}
	return strconv.FormatUint(id, 10)
}

func shortHost(h string) string {
	h, _, _ = strings.Cut(h, ".")
	return strings.ToUpper(h)
}

func syscallName(sc *Record) string {
	if sc.Enriched != nil {
		if n := sc.Enriched["SYSCALL"]; n != "" {
			return n
		}
	}
	num, _ := sc.Uint("syscall", false)
	return syscallNames[sc.Fields["arch"]][num]
}

// openForWrite lê as flags de open/openat (O_WRONLY ou O_RDWR).
func openForWrite(sc *Record, name string) bool {
	arg := ""
	switch name {
	case "open":
		arg = "a1"
	case "openat":
		arg = "a2"
	case "creat":
		return true
	default:
		return false // openat2 passa as flags numa estrutura
	}
	f, ok := sc.Uint(arg, true)
	return ok && f&3 != 0
}

func isATFDCWD(v string) bool {
	return v == "ffffff9c" || v == "ffffffffffffff9c"
}

func itemType(dir bool) string {
	if dir {
		return "folder"
	}
	return "file"
}

// RecordID é um número estável para o evento (horário + série do kernel),
// com até 53 bits: o servidor descarta repetições pelo par agente+record_id.
func RecordID(key string) uint64 {
	h := fnv.New64a()
	fmt.Fprint(h, key)
	return h.Sum64() & (1<<53 - 1)
}
