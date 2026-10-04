package samba

import (
	"strings"
	"testing"
)

const smbConf = `[global]
   workgroup = TECHMASTER
   vfs objects = acl_xattr

[Financeiro]
   path = /srv/fin
   read only = no
   vfs objects = acl_xattr recycle
   recycle:repository = .recycle/%U

[publico]
   path = /srv/publico
`

func TestEnableDisableRoundTrip(t *testing.T) {
	st := Settings{VFS: []string{"acl_xattr", "recycle"}, Success: []string{"create_file", "renameat"}, Failure: []string{"create_file"}}
	got, err := Enable(smbConf, "financeiro", st)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"[Financeiro]\n\t" + blockBegin + "\n\tvfs objects = acl_xattr recycle full_audit\n\tfull_audit:prefix = %u|%D|%I|%S|%P",
		"   # techaudit-desativado: vfs objects = acl_xattr recycle\n   recycle:repository",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("faltou %q em:\n%s", want, got)
		}
	}
	if m := Managed(got); len(m) != 1 || m[0] != "Financeiro" {
		t.Fatalf("Managed = %v", m)
	}
	if b := Block(got, "Financeiro"); !strings.Contains(b, "full_audit:success = create_file renameat") {
		t.Fatalf("Block = %q", b)
	}
	// Aplicar de novo não duplica.
	again, _ := Enable(got, "Financeiro", st)
	if again != got {
		t.Fatalf("segunda aplicação mudou o arquivo:\n%s", again)
	}
	back, changed := Disable(got, "Financeiro")
	if !changed || back != smbConf {
		t.Fatalf("Disable não restaurou o original:\n%s", back)
	}
	if _, err := Enable(smbConf, "naoexiste", st); err == nil {
		t.Fatal("esperava erro para seção inexistente")
	}
}

func TestParseTestparmAndOverlap(t *testing.T) {
	out := `# Global parameters
[global]
	vfs objects = acl_xattr
	workgroup = TECHMASTER

[Financeiro]
	path = /srv/fin
	read only = No
	vfs objects = acl_xattr recycle

[publico]
	path = /srv/publico/

[homes]
	browseable = No
`
	shares := ParseTestparm(out)
	if len(shares) != 3 || shares[0].Name != "Financeiro" || strings.Join(shares[1].VFS, ",") != "acl_xattr" || shares[1].Path != "/srv/publico" {
		t.Fatalf("%+v", shares)
	}
	if !shares[0].Overlaps("/srv/fin/contabil") || !shares[0].Overlaps("/srv") || shares[0].Overlaps("/srv/finance") || shares[2].Overlaps("/srv") {
		t.Fatal("Overlaps errado")
	}
}

func TestSupportedOps(t *testing.T) {
	mod := []byte("xx\x00mkdirat\x00renameat\x00create_file\x00")
	if got := SupportedOps(mod, []string{"create_file", "mkdir", "mkdirat", "rename"}); strings.Join(got, " ") != "create_file mkdirat" {
		t.Fatalf("%v", got)
	}
}
