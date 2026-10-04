package auditd

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func readAll(t *testing.T, tl *Tail) []string {
	t.Helper()
	var out []string
	for {
		line, _, _, err := tl.ReadLine()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, line)
	}
}

func appendFile(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

func TestTailRotationAndRestart(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "audit.log")
	appendFile(t, log, "antiga\n")
	tl, err := OpenTail(log, nil, false, nil) // começa no fim
	if err != nil {
		t.Fatal(err)
	}
	appendFile(t, log, "a1\na2\na")
	if got := readAll(t, tl); len(got) != 2 || got[1] != "a2" {
		t.Fatalf("leitura = %q", got)
	}
	appendFile(t, log, "3\n") // completa a linha que estava pela metade
	if got := readAll(t, tl); len(got) != 1 || got[0] != "a3" {
		t.Fatalf("linha completada = %q", got)
	}
	pos := tl.Position(tl.Offset())

	// Rotação: audit.log vira audit.log.1 e o auditd cria outro.
	appendFile(t, log, "a4\n")
	if err := os.Rename(log, log+".1"); err != nil {
		t.Fatal(err)
	}
	appendFile(t, log, "b1\n")
	if got := readAll(t, tl); len(got) != 2 || got[0] != "a4" || got[1] != "b1" {
		t.Fatalf("após rotação = %q", got)
	}
	tl.Close()

	// Reinício com a posição salva antes da rotação: lê o resto do .1 e o novo.
	tl, err = OpenTail(log, &pos, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tl.Close()
	if got := readAll(t, tl); len(got) != 2 || got[0] != "a4" || got[1] != "b1" {
		t.Fatalf("após reinício = %q", got)
	}
}
