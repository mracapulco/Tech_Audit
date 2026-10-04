package auditd

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// LocalStat devolve dispositivo e inode no formato do auditd ("fd:01").
func LocalStat(path string) (FileKey, bool, error) {
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		return FileKey{}, false, err
	}
	dev := uint64(st.Dev) //nolint:unconvert // o tipo varia entre arquiteturas
	return FileKey{Dev: fmt.Sprintf("%02x:%02x", unix.Major(dev), unix.Minor(dev)), Ino: st.Ino}, st.Mode&syscall.S_IFMT == syscall.S_IFDIR, nil
}

// LookupUser traduz um uid com getent, que consulta também contas de
// domínio (SSSD, winbind). Sem cgo, o os/user do Go só lê /etc/passwd.
func LookupUser(uid uint64) string {
	out, err := exec.Command("getent", "passwd", strconv.FormatUint(uid, 10)).Output()
	if err != nil {
		return ""
	}
	name, _, _ := strings.Cut(strings.TrimSpace(string(out)), ":")
	return name
}
