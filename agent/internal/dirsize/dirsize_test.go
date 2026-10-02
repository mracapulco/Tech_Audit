package dirsize

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func write(t *testing.T, path string, size int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestMeasureNested(t *testing.T) {
	root := t.TempDir()
	dados := filepath.Join(root, "dados")
	write(t, filepath.Join(dados, "a.txt"), 100)
	write(t, filepath.Join(dados, "fin", "b.txt"), 40)
	write(t, filepath.Join(dados, "fin", "2026", "c.txt"), 10)
	write(t, filepath.Join(dados, "rh", "d.txt"), 7)
	outro := filepath.Join(root, "outro")
	write(t, filepath.Join(outro, "e.txt"), 5)
	// Link para outra pasta não é seguido.
	if err := os.Symlink(outro, filepath.Join(dados, "link")); err != nil && runtime.GOOS != "windows" {
		t.Fatal(err)
	}

	fin := filepath.Join(dados, "fin")
	fin2026 := filepath.Join(fin, "2026")
	missing := filepath.Join(root, "nao-existe")
	got := Measure(context.Background(), []string{dados, fin, fin2026, outro, missing, dados + string(filepath.Separator)})

	for path, want := range map[string]int64{dados: 157, fin: 50, fin2026: 10, outro: 5} {
		r := got[path]
		if r == nil || r.Err != nil || r.Bytes != want {
			t.Errorf("%s: %+v, esperado %d", path, r, want)
		}
	}
	if got[dados].Files != 4 {
		t.Errorf("arquivos: %d", got[dados].Files)
	}
	if got[dados+string(filepath.Separator)] != got[dados] {
		t.Error("mesmo caminho com barra final deveria reaproveitar o resultado")
	}
	if got[missing].Err == nil {
		t.Error("caminho inexistente deveria dar erro")
	}
}

func TestMeasureUnreadable(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("permissões POSIX; root lê tudo")
	}
	root := t.TempDir()
	write(t, filepath.Join(root, "ok.txt"), 3)
	locked := filepath.Join(root, "bloqueada")
	write(t, filepath.Join(locked, "x.txt"), 50)
	os.Chmod(locked, 0)
	defer os.Chmod(locked, 0o755)
	got := Measure(context.Background(), []string{root, locked})
	if got[root].Bytes != 3 || got[root].Skipped != 1 || got[root].Err != nil {
		t.Errorf("raiz: %+v", got[root])
	}
	if got[locked].Err == nil {
		t.Error("pasta bloqueada deveria dar erro")
	}
}

func TestMeasureCanceled(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "a"), 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if r := Measure(ctx, []string{root})[root]; r.Err == nil {
		t.Errorf("cancelado: %+v", r)
	}
}
