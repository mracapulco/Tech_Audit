// Package store é o buffer local do agente (SQLite em modo WAL): fila de
// eventos aguardando envio e estado da coleta (bookmark do Event Log e
// pendências do correlacionador), gravados na mesma transação.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

const schema = `
CREATE TABLE IF NOT EXISTS outbox (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  body   BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value BLOB NOT NULL
);`

// Store guarda os eventos até o servidor confirmar o recebimento.
type Store struct {
	db       *sql.DB
	maxBytes int64

	mu    sync.Mutex
	count int
	bytes int64
}

// Row é um evento na fila.
type Row struct {
	ID    int64
	Event event.Event
}

// Open abre (ou cria) o banco. maxBytes limita o tamanho da fila; ao
// atingir, descarta primeiro leituras e depois os eventos mais antigos.
func Open(path string, maxBytes int64) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	dsn := "file:" + filepath.ToSlash(path) +
		"?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(10000)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // um escritor só; evita SQLITE_BUSY entre coleta e envio
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	s := &Store{db: db, maxBytes: maxBytes}
	if err := db.QueryRow(`SELECT count(*), COALESCE(sum(length(body)), 0) FROM outbox`).Scan(&s.count, &s.bytes); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Get lê um valor de estado; nil se não existir.
func (s *Store) Get(key string) ([]byte, error) {
	var v []byte
	err := s.db.QueryRow(`SELECT value FROM state WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return v, err
}

// InstanceID identifica este banco (gerado na criação). Entra no batch_id,
// para um banco recriado não repetir o id de um lote já enviado.
func (s *Store) InstanceID() (string, error) {
	v, err := s.Get("instance_id")
	if err != nil || v != nil {
		return string(v), err
	}
	var b [16]byte
	rand.Read(b[:])
	id := hex.EncodeToString(b[:])
	_, err = s.db.Exec(`INSERT OR IGNORE INTO state (key, value) VALUES ('instance_id', ?)`, []byte(id))
	if err != nil {
		return "", err
	}
	v, err = s.Get("instance_id")
	return string(v), err
}

// Commit grava os eventos na fila e os valores de estado numa só transação.
// Devolve quantos eventos antigos foram descartados por falta de espaço.
func (s *Store) Commit(events []event.Event, state map[string][]byte) (dropped int, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var added int64
	if len(events) > 0 {
		ins, err := tx.Prepare(`INSERT INTO outbox (action, body) VALUES (?, ?)`)
		if err != nil {
			return 0, err
		}
		defer ins.Close()
		for _, ev := range events {
			b, err := json.Marshal(ev)
			if err != nil {
				return 0, err
			}
			if _, err := ins.Exec(ev.Action, b); err != nil {
				return 0, err
			}
			added += int64(len(b))
		}
	}
	for k, v := range state {
		if _, err := tx.Exec(`INSERT INTO state (key, value) VALUES (?, ?)
			ON CONFLICT (key) DO UPDATE SET value = excluded.value`, k, v); err != nil {
			return 0, err
		}
	}
	count, bytes := s.count+len(events), s.bytes+added
	if s.maxBytes > 0 && bytes > s.maxBytes {
		// Descarta leituras antes de escritas e exclusões (docs/ARCHITECTURE.md, 4.4).
		for _, where := range []string{`action = 'read'`, `1 = 1`} {
			for bytes > s.maxBytes*9/10 {
				var n int
				var freed int64
				err := tx.QueryRow(`SELECT count(*), COALESCE(sum(length(body)), 0) FROM (
					SELECT body FROM outbox WHERE `+where+` ORDER BY id LIMIT 1000)`).Scan(&n, &freed)
				if err != nil {
					return 0, err
				}
				if n == 0 {
					break
				}
				if _, err := tx.Exec(`DELETE FROM outbox WHERE id IN (
					SELECT id FROM outbox WHERE ` + where + ` ORDER BY id LIMIT 1000)`); err != nil {
					return 0, err
				}
				count, bytes, dropped = count-n, bytes-freed, dropped+n
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	s.count, s.bytes = count, bytes
	return dropped, nil
}

// Peek devolve até n eventos mais antigos da fila, sem removê-los.
func (s *Store) Peek(n int) ([]Row, error) {
	rows, err := s.db.Query(`SELECT id, body FROM outbox ORDER BY id LIMIT ?`, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var b []byte
		if err := rows.Scan(&r.ID, &b); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(b, &r.Event); err != nil {
			return nil, fmt.Errorf("evento %d corrompido no buffer: %w", r.ID, err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Delete remove da fila os eventos com id até maxID (confirmados pelo servidor).
func (s *Store) Delete(maxID int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var n int
	var freed int64
	if err := s.db.QueryRow(`SELECT count(*), COALESCE(sum(length(body)), 0) FROM outbox WHERE id <= ?`, maxID).
		Scan(&n, &freed); err != nil {
		return err
	}
	if _, err := s.db.Exec(`DELETE FROM outbox WHERE id <= ?`, maxID); err != nil {
		return err
	}
	s.count, s.bytes = s.count-n, s.bytes-freed
	return nil
}

// Stats informa o tamanho atual da fila.
func (s *Store) Stats() (count int, bytes int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.count, s.bytes
}
