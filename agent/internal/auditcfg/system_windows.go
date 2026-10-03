package auditcfg

import (
	"fmt"
	"runtime"
	"strings"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/eventlog"

	"github.com/mracapulco/Tech_Audit/agent/internal/sddl"
)

// Subcategoria "Sistema de arquivos" / "File System" do auditpol. O GUID não
// depende do idioma do Windows, ao contrário do nome.
var fileSystemSubcategory = windows.GUID{Data1: 0x0cce921d, Data2: 0x69ae, Data3: 0x11d9, Data4: [8]byte{0xbe, 0xd3, 0x50, 0x50, 0x54, 0x50, 0x30, 0x30}}

const (
	policyAuditEventSuccess = 0x1
	policyAuditEventFailure = 0x2
	policyAuditEventNone    = 0x4
)

type auditPolicyInformation struct {
	SubCategory  windows.GUID
	Information  uint32
	CategoryGUID windows.GUID
}

var (
	advapi32                   = windows.NewLazySystemDLL("advapi32.dll")
	procAuditQuerySystemPolicy = advapi32.NewProc("AuditQuerySystemPolicy")
	procAuditSetSystemPolicy   = advapi32.NewProc("AuditSetSystemPolicy")
	procAuditFree              = advapi32.NewProc("AuditFree")
	enablePrivilegeOnce        sync.Once
	enablePrivilegeErr         error
)

// WindowsSystem lê e grava SACLs e a política de auditoria. Precisa rodar
// como SYSTEM ou administrador (privilégio SeSecurityPrivilege).
type WindowsSystem struct{}

// NewSystem habilita o SeSecurityPrivilege no processo.
func NewSystem() (System, error) {
	enablePrivilegeOnce.Do(func() { enablePrivilegeErr = enablePrivilege("SeSecurityPrivilege") })
	if enablePrivilegeErr != nil {
		return nil, fmt.Errorf("habilitando SeSecurityPrivilege (rode como SYSTEM ou administrador): %w", enablePrivilegeErr)
	}
	return WindowsSystem{}, nil
}

func enablePrivilege(name string) error {
	// GetLastError abaixo precisa ser lido na mesma thread da chamada.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &tok); err != nil {
		return err
	}
	defer tok.Close()
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(name), &luid); err != nil {
		return err
	}
	tp := windows.Tokenprivileges{PrivilegeCount: 1}
	tp.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
	if err := windows.AdjustTokenPrivileges(tok, false, &tp, 0, nil, nil); err != nil {
		return err
	}
	// AdjustTokenPrivileges "funciona" sem o privilégio e só avisa no GetLastError.
	if e := windows.GetLastError(); e == windows.ERROR_NOT_ALL_ASSIGNED {
		return e
	}
	return nil
}

func (WindowsSystem) ReadSACL(path string) (string, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.SACL_SECURITY_INFORMATION)
	if err != nil {
		return "", err
	}
	return sd.String(), nil
}

// WriteSACL grava só a SACL. Entradas herdáveis se propagam para as
// subpastas e arquivos (pode demorar em árvores grandes).
func (WindowsSystem) WriteSACL(path, sacl string) error {
	parsed, err := sddl.Parse(sacl)
	if err != nil {
		return err
	}
	var acl *windows.ACL
	if len(parsed.ACEs) > 0 {
		sd, err := windows.SecurityDescriptorFromString(parsed.String())
		if err != nil {
			return fmt.Errorf("SDDL %q: %w", parsed.String(), err)
		}
		if acl, _, err = sd.SACL(); err != nil {
			return fmt.Errorf("SDDL %q: %w", parsed.String(), err)
		}
	}
	if acl == nil {
		// Sem entradas: grava uma SACL vazia. ACLFromEntries(nil, nil) não
		// serve: o Windows devolve uma ACL nula e ele falha ao copiá-la.
		acl = emptyACL()
	}
	info := windows.SECURITY_INFORMATION(windows.SACL_SECURITY_INFORMATION)
	if parsed.Protected() {
		info |= windows.PROTECTED_SACL_SECURITY_INFORMATION
	} else {
		info |= windows.UNPROTECTED_SACL_SECURITY_INFORMATION
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, info, nil, nil, nil, acl)
}

func (WindowsSystem) ReadPolicy() (Policy, error) {
	var out *auditPolicyInformation
	r, _, e := procAuditQuerySystemPolicy.Call(uintptr(unsafe.Pointer(&fileSystemSubcategory)), 1, uintptr(unsafe.Pointer(&out)))
	if r == 0 {
		return Policy{}, fmt.Errorf("AuditQuerySystemPolicy: %w", e)
	}
	defer procAuditFree.Call(uintptr(unsafe.Pointer(out)))
	return Policy{Success: out.Information&policyAuditEventSuccess != 0, Failure: out.Information&policyAuditEventFailure != 0}, nil
}

func (WindowsSystem) WritePolicy(p Policy) error {
	info := auditPolicyInformation{SubCategory: fileSystemSubcategory}
	if p.Success {
		info.Information |= policyAuditEventSuccess
	}
	if p.Failure {
		info.Information |= policyAuditEventFailure
	}
	if info.Information == 0 {
		info.Information = policyAuditEventNone
	}
	r, _, e := procAuditSetSystemPolicy.Call(uintptr(unsafe.Pointer(&info)), 1)
	if r == 0 {
		return fmt.Errorf("AuditSetSystemPolicy: %w", e)
	}
	return nil
}

// EventSource é a origem dos eventos no log Application.
const EventSource = "TechAuditAgent"

// NewNotifier escreve no log Application do Windows (origem TechAuditAgent),
// para o administrador local ver as alterações sem acessar o portal.
func NewNotifier(logf func(string, ...any)) func(warning bool, msg string) {
	// Já registrada (pelo instalador ou execução anterior) devolve erro; ignorado.
	_ = eventlog.InstallAsEventCreate(EventSource, eventlog.Error|eventlog.Warning|eventlog.Info)
	l, err := eventlog.Open(EventSource)
	if err != nil {
		logf("log Application indisponível: %v", err)
		return func(bool, string) {}
	}
	return func(warning bool, msg string) {
		// O log Application aceita até 31.839 caracteres por evento.
		if len(msg) > 30000 {
			msg = msg[:30000] + "…"
		}
		msg = strings.ToValidUTF8(msg, "?")
		var err error
		if warning {
			err = l.Warning(1001, msg)
		} else {
			err = l.Info(1000, msg)
		}
		if err != nil {
			logf("log Application: %v", err)
		}
	}
}

// emptyACL monta uma ACL válida sem entradas: só o cabeçalho de 8 bytes
// (revisão ACL_REVISION, tamanho 8, nenhuma ACE).
func emptyACL() *windows.ACL {
	b := make([]byte, 8)
	b[0] = 2 // ACL_REVISION
	b[2] = 8 // AclSize (little endian)
	return (*windows.ACL)(unsafe.Pointer(&b[0]))
}

// NewPlatformSyncer cria o Syncer do Windows: SACL das pastas e política de auditoria.
func NewPlatformSyncer(client *Client, opts Options) (*Syncer, error) {
	sys, err := NewSystem()
	if err != nil {
		return nil, err
	}
	return NewSyncer(client, sys, opts)
}
