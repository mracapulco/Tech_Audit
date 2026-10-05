package perms

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLinuxReader(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "restrita")
	same := filepath.Join(root, "igual")
	for _, d := range []string{sub, same} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.Chmod(root, 0o755)
	os.Chmod(sub, 0o700)
	if _, err := exec.LookPath("setfacl"); err == nil {
		if out, err := exec.Command("setfacl", "-m", "u:0:rx", sub).CombinedOutput(); err != nil {
			t.Logf("setfacl indisponível aqui: %v %s", err, out)
		}
	}
	r, err := NewReader()
	if err != nil {
		t.Fatal(err)
	}
	res := Scan(context.Background(), r, root, Options{})
	if res.Err != nil {
		t.Fatal(res.Err)
	}
	if len(res.Folders) != 2 || res.Folders[1].Path != sub || res.Folders[1].Reason != "changed" {
		t.Fatalf("pastas: %+v", res.Folders)
	}
	var lines []string
	for _, e := range res.Folders[1].Entries {
		lines = append(lines, e.Principal+" "+e.Raw)
	}
	t.Log(strings.Join(lines, "; "))
	if !strings.Contains(lines[0], "(dono) rwx") {
		t.Errorf("dono: %v", lines)
	}
}
