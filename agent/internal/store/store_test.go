package store

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

func TestCommitPeekDelete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.db")
	s, err := Open(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	evs := []event.Event{{RecordID: 1, Action: "created", Path: `D:\a`}, {RecordID: 2, Action: "deleted", Path: `D:\b`}}
	if _, err := s.Commit(evs, map[string][]byte{"bookmark": []byte("<b1/>")}); err != nil {
		t.Fatal(err)
	}
	id1, _ := s.InstanceID()
	s.Close()

	// Reabre: fila e estado persistem.
	s, err = Open(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if id2, _ := s.InstanceID(); id1 == "" || id1 != id2 {
		t.Errorf("instance_id mudou: %q %q", id1, id2)
	}
	if b, _ := s.Get("bookmark"); string(b) != "<b1/>" {
		t.Errorf("bookmark: %q", b)
	}
	rows, err := s.Peek(10)
	if err != nil || len(rows) != 2 || rows[1].Event.Path != `D:\b` {
		t.Fatalf("peek: %+v %v", rows, err)
	}
	if err := s.Delete(rows[0].ID); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.Stats(); n != 1 {
		t.Errorf("restaram %d", n)
	}
	if v, _ := s.Get("nada"); v != nil {
		t.Errorf("chave inexistente: %q", v)
	}
}

func TestLimitDropsReadsFirst(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "agent.db"), 6000)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	big := strings.Repeat("x", 400)
	var evs []event.Event
	for i := range 10 {
		evs = append(evs, event.Event{RecordID: uint64(i), Action: "read", Path: big})
	}
	s.Commit(evs, nil)
	dropped, err := s.Commit([]event.Event{{RecordID: 99, Action: "deleted", Path: big}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if dropped == 0 {
		t.Fatal("deveria descartar")
	}
	rows, _ := s.Peek(100)
	if last := rows[len(rows)-1].Event; last.Action != "deleted" {
		t.Errorf("exclusão foi descartada: %+v", last)
	}
	if _, b := s.Stats(); b > 6000 {
		t.Errorf("acima do limite: %d", b)
	}
}
