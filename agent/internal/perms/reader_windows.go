package perms

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsReader lê dono e DACL (NTFS) e as permissões dos compartilhamentos.
// Roda como SYSTEM; abre as pastas com semântica de backup, para ler mesmo
// as que não dão acesso ao SYSTEM.
type windowsReader struct {
	mu    sync.Mutex
	names map[string]Principal
	dcs   map[string]string
}

// NewReader devolve o leitor do sistema.
func NewReader() (Reader, error) { return &windowsReader{names: map[string]Principal{}}, nil }

func (r *windowsReader) Read(path string) (Folder, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return Folder{}, err
	}
	h, err := windows.CreateFile(p, windows.READ_CONTROL, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return Folder{}, err
	}
	defer windows.CloseHandle(h)
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return Folder{}, err
	}
	f, err := FromSDDL(sd.String(), r.resolve, false)
	f.Source = "ntfs"
	return f, err
}

func (r *windowsReader) Differs(child, parent *Folder) string { return DiffersNTFS(child, parent) }

// resolve traduz o SID com cache (a mesma conta aparece em milhares de pastas).
func (r *windowsReader) resolve(s string) Principal {
	r.mu.Lock()
	defer r.mu.Unlock()
	if p, ok := r.names[s]; ok {
		return p
	}
	p := lookupSID(s)
	r.names[s] = p
	return p
}

func lookupSID(s string) Principal {
	sid, err := windows.StringToSid(s)
	if err != nil {
		if p, ok := WellKnown[s]; ok {
			return p
		}
		return Principal{Name: s, SID: s, Kind: "unknown"}
	}
	str := sid.String()
	account, domain, typ, err := sid.LookupAccount("")
	if err != nil {
		if p, ok := WellKnown[s]; ok {
			return p
		}
		return Principal{Name: "Conta desconhecida (" + str + ")", SID: str, Kind: "unknown"}
	}
	name := account
	if domain != "" {
		name = domain + `\` + account
	}
	kind := "unknown"
	switch typ {
	case windows.SidTypeUser, windows.SidTypeComputer:
		kind = "user"
	case windows.SidTypeGroup, windows.SidTypeAlias, windows.SidTypeWellKnownGroup:
		kind = "group"
	}
	return Principal{Name: name, SID: str, Kind: kind}
}

// SHARE_INFO_502 (lmshare.h).
type shareInfo502 struct {
	Netname            *uint16
	Type               uint32
	Remark             *uint16
	Permissions        uint32
	MaxUses            uint32
	CurrentUses        uint32
	Path               *uint16
	Passwd             *uint16
	Reserved           uint32
	SecurityDescriptor *windows.SECURITY_DESCRIPTOR
}

const (
	stypeDiskTree = 0
	stypeSpecial  = 0x80000000
	maxPreferred  = 0xffffffff
)

var (
	netapi32                    = windows.NewLazySystemDLL("netapi32.dll")
	procNetShareEnum            = netapi32.NewProc("NetShareEnum")
	procNetLocalGroupGetMembers = netapi32.NewProc("NetLocalGroupGetMembers")
	procNetGroupGetUsers        = netapi32.NewProc("NetGroupGetUsers")
	procDsGetDcName             = netapi32.NewProc("DsGetDcNameW")
)

// Shares lista as pastas compartilhadas (sem as administrativas, como C$)
// que contêm o caminho, são ele ou estão dentro dele.
func (r *windowsReader) Shares(root string) ([]Folder, error) {
	var buf *byte
	var read, total, resume uint32
	ret, _, _ := procNetShareEnum.Call(0, 502, uintptr(unsafe.Pointer(&buf)), maxPreferred,
		uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&resume)))
	if buf != nil {
		defer windows.NetApiBufferFree(buf)
	}
	if ret != 0 {
		return nil, fmt.Errorf("NetShareEnum: %w", windows.Errno(ret))
	}
	if read == 0 || buf == nil {
		return nil, nil
	}
	var out []Folder
	for _, s := range unsafe.Slice((*shareInfo502)(unsafe.Pointer(buf)), read) {
		if s.Type&0xff != stypeDiskTree || s.Type&stypeSpecial != 0 || s.Path == nil {
			continue
		}
		path := windows.UTF16PtrToString(s.Path)
		if !overlapsWin(path, root) {
			continue
		}
		f := Folder{Path: path, Share: windows.UTF16PtrToString(s.Netname)}
		if s.SecurityDescriptor == nil {
			// Sem descritor o compartilhamento libera tudo para todos.
			f.Entries = []Entry{{Principal: "Todos", SID: "S-1-1-0", Kind: "group", Access: "allow", Rights: "Controle total", Raw: "sem descritor", AppliesTo: "Compartilhamento"}}
		} else {
			sf, err := FromSDDL(s.SecurityDescriptor.String(), r.resolve, true)
			if err != nil {
				f.Error = err.Error()
			}
			f.Entries = sf.Entries
		}
		out = append(out, f)
	}
	return out, nil
}

func overlapsWin(a, b string) bool {
	a = strings.ToLower(filepath.Clean(a))
	b = strings.ToLower(filepath.Clean(b))
	in := func(child, parent string) bool {
		return child == parent || strings.HasPrefix(child, strings.TrimSuffix(parent, `\`)+`\`)
	}
	return in(a, b) || in(b, a)
}

// Grupos especiais do Windows: não têm lista de membros, valem pelo tipo de acesso.
var specialNotes = map[string]string{
	"S-1-1-0":  "Grupo especial do Windows: todas as contas, inclusive convidados.",
	"S-1-5-11": "Grupo especial do Windows: todos os usuários e computadores que entraram com senha (do domínio e deste servidor).",
	"S-1-3-0":  "Quem criou o arquivo ou a pasta.",
	"S-1-3-4":  "Quem é dono do arquivo ou da pasta.",
	"S-1-5-4":  "Quem está logado diretamente neste servidor.",
	"S-1-5-2":  "Quem acessa pela rede.",
	"S-1-5-6":  "Serviços do Windows.",
}

// Members lista os membros diretos do grupo: grupos locais e do BUILTIN pelo
// próprio servidor; grupos do domínio pelo controlador de domínio.
func (r *windowsReader) Members(name, sidStr string) (GroupInfo, error) {
	g := GroupInfo{Name: name, SID: sidStr}
	var sid *windows.SID
	var err error
	if strings.HasPrefix(sidStr, "S-") {
		sid, err = windows.StringToSid(sidStr)
	} else {
		sid, _, _, err = windows.LookupSID("", name)
	}
	if err != nil {
		return g, fmt.Errorf("grupo não encontrado: %w", err)
	}
	g.SID = sid.String()
	if n, ok := specialNotes[g.SID]; ok {
		g.Note = n
		return g, nil
	}
	account, domain, typ, err := sid.LookupAccount("")
	if err != nil {
		return g, fmt.Errorf("grupo não encontrado: %w", err)
	}
	g.Name = account
	if domain != "" {
		g.Name = domain + `\` + account
	}
	computer, _ := windows.ComputerName()
	local := domain == "" || strings.EqualFold(domain, computer) || strings.EqualFold(domain, "BUILTIN") || strings.EqualFold(domain, "NT AUTHORITY") || strings.EqualFold(domain, "AUTORIDADE NT")
	switch typ {
	case windows.SidTypeWellKnownGroup:
		g.Note = "Grupo especial do Windows: os membros são definidos na hora do acesso, não por uma lista."
		return g, nil
	case windows.SidTypeAlias:
		server := ""
		if !local {
			if server, err = r.dc(domain); err != nil {
				return g, err
			}
		}
		g.Members, err = localGroupMembers(server, account)
		return g, err
	case windows.SidTypeGroup:
		if local {
			g.Note = "Grupo local sem lista de membros."
			return g, nil
		}
		server, err := r.dc(domain)
		if err != nil {
			return g, err
		}
		g.Members, err = r.groupUsers(server, domain, account)
		return g, err
	}
	return g, errors.New("não é um grupo")
}

// dc devolve o controlador de domínio (\\DC01), com cache.
func (r *windowsReader) dc(domain string) (string, error) {
	r.mu.Lock()
	if r.dcs == nil {
		r.dcs = map[string]string{}
	}
	if s, ok := r.dcs[strings.ToLower(domain)]; ok {
		r.mu.Unlock()
		return s, nil
	}
	r.mu.Unlock()
	d, err := windows.UTF16PtrFromString(domain)
	if err != nil {
		return "", err
	}
	const dsIsFlatName = 0x00010000
	var info *struct{ DomainControllerName *uint16 }
	ret, _, _ := procDsGetDcName.Call(0, uintptr(unsafe.Pointer(d)), 0, 0, dsIsFlatName, uintptr(unsafe.Pointer(&info)))
	if ret != 0 {
		return "", fmt.Errorf("controlador do domínio %s não encontrado: %w", domain, windows.Errno(ret))
	}
	defer windows.NetApiBufferFree((*byte)(unsafe.Pointer(info)))
	s := windows.UTF16PtrToString(info.DomainControllerName)
	r.mu.Lock()
	r.dcs[strings.ToLower(domain)] = s
	r.mu.Unlock()
	return s, nil
}

func kindOf(typ uint32) string {
	switch typ {
	case windows.SidTypeUser, windows.SidTypeComputer:
		return "user"
	case windows.SidTypeGroup, windows.SidTypeAlias, windows.SidTypeWellKnownGroup:
		return "group"
	}
	return "unknown"
}

func optPtr(s string) (*uint16, error) {
	if s == "" {
		return nil, nil
	}
	return windows.UTF16PtrFromString(s)
}

// LOCALGROUP_MEMBERS_INFO_2 (lmaccess.h).
type localGroupMembersInfo2 struct {
	SID           *windows.SID
	SIDUsage      uint32
	DomainAndName *uint16
}

func localGroupMembers(server, group string) ([]Member, error) {
	srv, err := optPtr(server)
	if err != nil {
		return nil, err
	}
	grp, err := windows.UTF16PtrFromString(group)
	if err != nil {
		return nil, err
	}
	var buf *byte
	var read, total uint32
	var resume uintptr
	ret, _, _ := procNetLocalGroupGetMembers.Call(uintptr(unsafe.Pointer(srv)), uintptr(unsafe.Pointer(grp)), 2, uintptr(unsafe.Pointer(&buf)), maxPreferred,
		uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&resume)))
	if buf != nil {
		defer windows.NetApiBufferFree(buf)
	}
	if ret != 0 {
		return nil, fmt.Errorf("NetLocalGroupGetMembers: %w", windows.Errno(ret))
	}
	var out []Member
	if read == 0 || buf == nil {
		return out, nil
	}
	for _, m := range unsafe.Slice((*localGroupMembersInfo2)(unsafe.Pointer(buf)), read) {
		mem := Member{Name: windows.UTF16PtrToString(m.DomainAndName), Kind: kindOf(m.SIDUsage)}
		if m.SID != nil {
			mem.SID = m.SID.String()
		}
		out = append(out, mem)
	}
	return out, nil
}

// groupUsers lista um grupo global do domínio (NetGroupGetUsers no DC).
func (r *windowsReader) groupUsers(server, domain, group string) ([]Member, error) {
	srv, err := optPtr(server)
	if err != nil {
		return nil, err
	}
	grp, err := windows.UTF16PtrFromString(group)
	if err != nil {
		return nil, err
	}
	var buf *byte
	var read, total uint32
	var resume uintptr
	ret, _, _ := procNetGroupGetUsers.Call(uintptr(unsafe.Pointer(srv)), uintptr(unsafe.Pointer(grp)), 0, uintptr(unsafe.Pointer(&buf)), maxPreferred,
		uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&resume)))
	if buf != nil {
		defer windows.NetApiBufferFree(buf)
	}
	if ret != 0 {
		return nil, fmt.Errorf("NetGroupGetUsers: %w", windows.Errno(ret))
	}
	var names []string
	if read > 0 && buf != nil {
		for _, p := range unsafe.Slice((**uint16)(unsafe.Pointer(buf)), read) {
			names = append(names, windows.UTF16PtrToString(p))
		}
	}
	out := make([]Member, 0, len(names))
	for i, n := range names {
		full := domain + `\` + n
		m := Member{Name: full, Kind: "user"}
		// Tipo e SID só dos primeiros, para não fazer milhares de consultas.
		if i < MaxGroupMembers {
			if sid, _, typ, err := windows.LookupSID("", full); err == nil {
				m.SID, m.Kind = sid.String(), kindOf(typ)
			}
		}
		out = append(out, m)
	}
	return out, nil
}
