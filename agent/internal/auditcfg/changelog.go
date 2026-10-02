package auditcfg

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ChangeLog é o log local de alterações de auditoria: uma linha JSON por
// alteração, somente acréscimo. Cada linha traz o hash da anterior, então
// apagar ou editar uma linha quebra a corrente (VerifyChangeLog acusa).
type ChangeLog struct {
	path string
	mu   sync.Mutex
	prev string
}

// ChangeEntry é uma linha do log.
type ChangeEntry struct {
	Time      time.Time   `json:"time"`
	Version   int         `json:"config_version"`
	PathID    string      `json:"path_id,omitempty"`
	Path      string      `json:"path,omitempty"`
	Operation string      `json:"operation"`
	Status    string      `json:"status"`
	Message   string      `json:"message,omitempty"`
	Before    *AuditState `json:"before,omitempty"`
	After     *AuditState `json:"after,omitempty"`
	PrevHash  string      `json:"prev_hash"`
	Hash      string      `json:"hash"`
}

// OpenChangeLog abre (ou cria) o log e lê o hash da última linha.
func OpenChangeLog(path string) (*ChangeLog, error) {
	l := &ChangeLog{path: path}
	f, err := os.Open(path)
	if errors.Is(err, fs.ErrNotExist) {
		return l, os.MkdirAll(filepath.Dir(path), 0o700)
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		var e ChangeEntry
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Hash != "" {
			l.prev = e.Hash
		}
	}
	return l, sc.Err()
}

func entryHash(e ChangeEntry) string {
	e.Hash = ""
	b, _ := json.Marshal(e)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// Append grava a entrada no fim do arquivo.
func (l *ChangeLog) Append(e ChangeEntry) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	e.PrevHash = l.prev
	e.Hash = entryHash(e)
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	l.prev = e.Hash
	return f.Close()
}

// VerifyChangeLog confere a corrente de hashes; devolve quantas linhas leu.
func VerifyChangeLog(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	prev, n := "", 0
	for sc.Scan() {
		n++
		var e ChangeEntry
		if err := json.Unmarshal(sc.Bytes(), &e); err != nil {
			return n, fmt.Errorf("linha %d: %w", n, err)
		}
		if e.PrevHash != prev || entryHash(e) != e.Hash {
			return n, fmt.Errorf("linha %d: corrente de hash quebrada (log alterado)", n)
		}
		prev = e.Hash
	}
	return n, sc.Err()
}
