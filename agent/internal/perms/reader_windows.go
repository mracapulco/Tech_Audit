package perms

import (
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

var procNetShareEnum = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetShareEnum")

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
