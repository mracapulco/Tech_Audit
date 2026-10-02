package source

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

func TestXPathQuery(t *testing.T) {
	got := XPathQuery([]int{4663, 5145})
	if want := "*[System[(EventID=4663 or EventID=5145)]]"; got != want {
		t.Errorf("got %q", got)
	}
}

// Simula a saída do wevtutil: vários <Event> concatenados, sem raiz.
func TestOpenFileConcatenatedEvents(t *testing.T) {
	var data []byte
	for _, n := range []string{"5145.xml", "4663_write.xml", "4663_delete.xml", "4660.xml"} {
		b, err := os.ReadFile(filepath.Join("..", "event", "testdata", n))
		if err != nil {
			t.Fatal(err)
		}
		data = append(append(data, b...), "\r\n"...)
	}
	p := filepath.Join(t.TempDir(), "export.xml")
	os.WriteFile(p, data, 0o600)

	f, err := OpenFile(p)
	if err != nil {
		t.Fatal(err)
	}
	batch, err := f.Next(context.Background(), 3, 0)
	if err != nil || len(batch) != 3 {
		t.Fatalf("lote 1: %d eventos, err=%v", len(batch), err)
	}
	r, err := event.ParseXML(batch[1])
	if err != nil || r.EventID != 4663 {
		t.Fatalf("evento 2: %+v err=%v", r, err)
	}
	if batch, _ = f.Next(context.Background(), 3, 0); len(batch) != 1 {
		t.Fatalf("lote 2: %d eventos", len(batch))
	}
	if _, err = f.Next(context.Background(), 3, 0); err != io.EOF {
		t.Fatalf("esperava EOF, veio %v", err)
	}
}
