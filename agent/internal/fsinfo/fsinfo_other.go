//go:build !windows

package fsinfo

import (
	"os"
	"path/filepath"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// Fora do Windows não há data de criação nem ChangeTime portáteis: usa a
// data de modificação para todos (suficiente para testes e para o futuro
// coletor Linux, que terá outra fonte).

func (l *Local) Stat(path string) (event.FileInfo, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return event.FileInfo{}, err
	}
	t := fi.ModTime()
	return event.FileInfo{IsDir: fi.IsDir(), Created: t, Modified: t, Changed: t}, nil
}

func (l *Local) ListDir(dir string, max int) ([]event.DirEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]event.DirEntry, 0, min(len(entries), max))
	for _, e := range entries[:min(len(entries), max)] {
		fi, err := os.Lstat(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		t := fi.ModTime()
		out = append(out, event.DirEntry{Name: e.Name(), FileInfo: event.FileInfo{IsDir: fi.IsDir(), Created: t, Modified: t, Changed: t}})
	}
	return out, nil
}

// EnableBackupPrivilege só existe no Windows.
func EnableBackupPrivilege() error { return nil }
