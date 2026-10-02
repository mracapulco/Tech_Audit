package fsinfo

import (
	"encoding/binary"
	"errors"
	"log"
	"sync"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

const fileIDBothDirectoryInfo = 10 // FILE_INFO_BY_HANDLE_CLASS

// open abre o arquivo ou pasta só para ler atributos, sem bloquear quem
// estiver usando. FILE_FLAG_BACKUP_SEMANTICS permite abrir pastas e, com
// SeBackupPrivilege habilitado (EnableBackupPrivilege), ignora a DACL.
func open(path string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.CreateFile(p, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// Stat lê os horários pelo caminho (GetFileAttributesEx), sem abrir o
// arquivo: funciona com o arquivo em uso e não depende do alinhamento de
// buffer exigido pelo GetFileInformationByHandleEx. O ChangeTime não vem
// nessa consulta; quem precisa dele usa ListDir.
func (l *Local) Stat(path string) (event.FileInfo, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return event.FileInfo{}, err
	}
	var d windows.Win32FileAttributeData
	if err := windows.GetFileAttributesEx(p, windows.GetFileExInfoStandard, (*byte)(unsafe.Pointer(&d))); err != nil {
		if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			statErrOnce.Do(func() { log.Printf("aviso: não foi possível ler os horários de %s: %v", path, err) })
		}
		return event.FileInfo{}, err
	}
	return event.FileInfo{
		IsDir:    d.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
		Created:  ft(d.CreationTime),
		Modified: ft(d.LastWriteTime),
	}, nil
}

var statErrOnce sync.Once

func ft(f windows.Filetime) time.Time {
	return filetime(uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime))
}

// ListDir lê a pasta com FileIdBothDirectoryInfo, que já traz os quatro
// horários de cada item sem precisar abrir um por um.
func (l *Local) ListDir(dir string, max int) ([]event.DirEntry, error) {
	h, err := open(dir, windows.FILE_LIST_DIRECTORY)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(h)
	buf := make([]byte, 64*1024)
	var out []event.DirEntry
	for len(out) < max {
		err := windows.GetFileInformationByHandleEx(h, fileIDBothDirectoryInfo, &buf[0], uint32(len(buf)))
		if errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			break
		}
		if err != nil {
			return out, err
		}
		for off := 0; ; {
			e := buf[off:]
			if len(e) < 104 {
				break
			}
			next := binary.LittleEndian.Uint32(e[0:])
			nameLen := int(binary.LittleEndian.Uint32(e[60:]))
			if 104+nameLen > len(e) {
				break
			}
			u := unsafe.Slice((*uint16)(unsafe.Pointer(&e[104])), nameLen/2)
			name := string(utf16.Decode(u))
			if name != "." && name != ".." {
				out = append(out, event.DirEntry{Name: name, FileInfo: event.FileInfo{
					IsDir:    binary.LittleEndian.Uint32(e[56:])&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
					Created:  filetime(binary.LittleEndian.Uint64(e[8:])),
					Modified: filetime(binary.LittleEndian.Uint64(e[24:])),
					Changed:  filetime(binary.LittleEndian.Uint64(e[32:])),
				}})
			}
			if next == 0 {
				break
			}
			off += int(next)
		}
	}
	return out, nil
}

// EnableBackupPrivilege habilita SeBackupPrivilege no processo (a conta
// SYSTEM o possui, mas desabilitado), para ler horários e a Lixeira mesmo em
// pastas cuja DACL não inclui SYSTEM.
func EnableBackupPrivilege() error {
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &tok); err != nil {
		return err
	}
	defer tok.Close()
	var luid windows.LUID
	name, _ := windows.UTF16PtrFromString("SeBackupPrivilege")
	if err := windows.LookupPrivilegeValue(nil, name, &luid); err != nil {
		return err
	}
	tp := windows.Tokenprivileges{PrivilegeCount: 1}
	tp.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
	if err := windows.AdjustTokenPrivileges(tok, false, &tp, 0, nil, nil); err != nil {
		return err
	}
	return nil
}
