//go:build !linux

package source

import (
	"errors"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// LinuxOptions só é usado no Linux.
type LinuxOptions struct {
	AuditLog, Bookmark, StartFrom, Hostname string
	Scope                                   func(path string, read bool) bool
	Roots                                   func() ([]string, bool)
	NoSamba                                 bool
	Logf                                    func(format string, args ...any)
}

// OpenLinux só existe no Linux.
func OpenLinux(LinuxOptions) (Source, error) {
	return nil, errors.New("coletor do Linux disponível só no Linux")
}

// DecodeJSON só é usado no Linux.
func DecodeJSON([]byte) (event.Event, bool, error) {
	return event.Event{}, false, errors.New("coletor do Linux disponível só no Linux")
}
