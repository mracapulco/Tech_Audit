//go:build !windows

package auditd

import (
	"os"
	"syscall"
)

func fileIno(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Ino) //nolint:unconvert // o tipo varia entre sistemas
	}
	return 0
}
