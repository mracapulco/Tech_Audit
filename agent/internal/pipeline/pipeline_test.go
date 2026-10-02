package pipeline

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
	"github.com/mracapulco/Tech_Audit/agent/internal/source"
	"github.com/mracapulco/Tech_Audit/agent/internal/store"
)

func replayFile(t *testing.T, names ...string) string {
	t.Helper()
	var data []byte
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join("..", "event", "testdata", n))
		if err != nil {
			t.Fatal(err)
		}
		data = append(append(data, b...), '\n')
	}
	p := filepath.Join(t.TempDir(), "export.xml")
	os.WriteFile(p, data, 0o600)
	return p
}

func TestReplayEndToEnd(t *testing.T) {
	src, err := source.OpenFile(replayFile(t, "5140.xml", "4663_write.xml", "4663_delete.xml", "4660.xml"))
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "agent.db"), 0)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	var mu sync.Mutex
	var batches []*event.Batch
	fail := 1
	beats := 0
	p := &Pipeline{
		Source:     src,
		Store:      st,
		Correlator: event.NewCorrelator(event.CorrelationConfig{}, event.Filter{}, nil),
		Send: func(_ context.Context, b *event.Batch) error {
			mu.Lock()
			defer mu.Unlock()
			if fail > 0 { // primeira tentativa falha: o lote deve ser reenviado igual
				fail--
				batches = append(batches, b)
				return errors.New("fora do ar")
			}
			batches = append(batches, b)
			return nil
		},
		AgentID: "FS01", BatchSize: 100, FlushInterval: 10 * time.Millisecond, RetryDelay: time.Millisecond,
		Heartbeat: func(context.Context, Status) error {
			mu.Lock()
			beats++
			mu.Unlock()
			return nil
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if len(batches) != 2 || batches[0].BatchID != batches[1].BatchID {
		t.Fatalf("esperava o mesmo lote duas vezes: %d lotes", len(batches))
	}
	got := map[string]event.Event{}
	for _, e := range batches[1].Events {
		got[e.Action] = e
	}
	if len(batches[1].Events) != 2 || got["deleted"].Path != `D:\Shares\Financeiro\antigo.docx` ||
		got["modified"].ClientIP != "10.0.0.25" {
		t.Errorf("eventos inesperados: %+v", batches[1].Events)
	}
	if beats == 0 {
		t.Error("nenhum heartbeat enviado")
	}
	if n, _ := st.Stats(); n != 0 {
		t.Errorf("buffer deveria estar vazio, tem %d", n)
	}
	if cs, _ := st.Get(KeyCorrelator); cs == nil {
		t.Error("estado do correlacionador não foi gravado")
	}
}

func TestBatchIDStable(t *testing.T) {
	a, b := batchID("x", 1, 10), batchID("x", 1, 10)
	if a != b || a == batchID("y", 1, 10) || len(a) != 36 || a[14] != '5' {
		t.Errorf("batchID: %s %s", a, b)
	}
}
