package auditcfg

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/samba"
)

// fakeLinux simula auditd (regras carregadas) e Samba (smb.conf).
type fakeLinux struct {
	dirs    map[string]bool
	active  bool
	rules   map[AuditRule]bool
	saved   []AuditRule
	smb     *fakeSamba
	addFail map[string]error
}

func (f *fakeLinux) IsDir(p string) bool { return f.dirs[p] }
func (f *fakeLinux) AuditdActive() bool  { return f.active }
func (f *fakeLinux) StartAuditd() error  { f.active = true; return nil }
func (f *fakeLinux) Rules() ([]AuditRule, error) {
	var out []AuditRule
	for r := range f.rules {
		out = append(out, r)
	}
	sortRules(out)
	return out, nil
}
func (f *fakeLinux) AddRule(r AuditRule) error {
	if err := f.addFail[r.Dir]; err != nil {
		return err
	}
	f.rules[r] = true
	return nil
}
func (f *fakeLinux) DeleteRule(r AuditRule) error      { delete(f.rules, r); return nil }
func (f *fakeLinux) RuleText(r AuditRule) string       { return "dir=" + r.Dir }
func (f *fakeLinux) SaveRules(rules []AuditRule) error { f.saved = rules; return nil }
func (f *fakeLinux) Samba() SambaSystem {
	if f.smb == nil {
		return nil
	}
	return f.smb
}

type fakeSamba struct {
	conf   string
	writes int
	rate   bool
}

func (s *fakeSamba) Shares() ([]samba.Share, error) {
	shares := []samba.Share{{Name: "dados", Path: "/srv/dados", VFS: []string{"acl_xattr"}}, {Name: "outros", Path: "/srv/outros"}}
	for _, m := range samba.Managed(s.conf) {
		if m == "dados" {
			shares[0].VFS = append(shares[0].VFS, "full_audit")
		}
	}
	return shares, nil
}
func (s *fakeSamba) ReadConf() (string, error) { return s.conf, nil }
func (s *fakeSamba) WriteConf(t string) error  { s.conf = t; s.writes++; return nil }
func (s *fakeSamba) Ops() ([]string, []string, error) {
	return []string{"create_file", "renameat"}, []string{"create_file"}, nil
}
func (s *fakeSamba) LogRate(on bool) (bool, error) {
	changed := s.rate != on
	s.rate = on
	return changed, nil
}

const finLinux = "/srv/dados/financeiro"

func setupLinux(t *testing.T) (*Syncer, *fakeLinux, *fakeServer) {
	t.Helper()
	srv := &fakeServer{}
	hs := httptest.NewServer(srv.handler(t))
	t.Cleanup(hs.Close)
	client, err := NewClient(hs.Client(), hs.URL+"/v1/events", "ta_agt_x")
	if err != nil {
		t.Fatal(err)
	}
	sys := &fakeLinux{
		dirs:  map[string]bool{finLinux: true},
		rules: map[AuditRule]bool{},
		smb:   &fakeSamba{conf: "[global]\n\tworkgroup = X\n\n[dados]\n\tpath = /srv/dados\n\tvfs objects = acl_xattr\n\n[outros]\n\tpath = /srv/outros\n"},
	}
	dir := t.TempDir()
	s, err := NewSyncer(client, nil, Options{StateFile: filepath.Join(dir, "state.json"), ChangeLog: filepath.Join(dir, "changes.log")})
	if err != nil {
		t.Fatal(err)
	}
	s.Linux = sys
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	return s, sys, srv
}

func TestLinuxApplyAndRemove(t *testing.T) {
	s, sys, srv := setupLinux(t)
	ctx := context.Background()
	srv.cfg = Config{Version: 1, Paths: []PathConfig{{ID: finID, Path: finLinux, State: "active", Status: "pending", Recursive: true, AuditRead: true}}}
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if !sys.active {
		t.Fatal("auditd deveria ter sido iniciado")
	}
	if !sys.rules[AuditRule{Dir: finLinux}] || !sys.rules[AuditRule{Dir: finLinux, Read: true}] || len(sys.saved) != 2 {
		t.Fatalf("regras: %v salvas: %v", sys.rules, sys.saved)
	}
	if m := samba.Managed(sys.smb.conf); len(m) != 1 || m[0] != "dados" || !sys.smb.rate {
		t.Fatalf("Samba: %v\n%s", m, sys.smb.conf)
	}
	if !strings.Contains(sys.smb.conf, "vfs objects = acl_xattr full_audit") {
		t.Fatalf("vfs objects:\n%s", sys.smb.conf)
	}
	res := srv.lastResults()
	if len(res) != 1 {
		t.Fatalf("resultados: %v", res)
	}
	r := result(t, res[0])
	if r["status"] != "applied" || !strings.Contains(r["message"].(string), "compartilhamento dados") {
		t.Fatalf("resultado: %v", r)
	}
	after := r["after"].(map[string]any)
	if !strings.Contains(after["sacl"].(string), "auditd: dir="+finLinux) || !strings.Contains(after["sacl"].(string), "samba [dados]") {
		t.Fatalf("depois: %v", after)
	}

	// Nada mudou: nenhuma escrita nova.
	srv.cfg.Paths[0].Status = "applied"
	writes := sys.smb.writes
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if sys.smb.writes != writes {
		t.Fatal("smb.conf regravado sem mudança")
	}

	// auditd reiniciado apagou as regras: o agente recoloca.
	sys.rules = map[AuditRule]bool{}
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if !sys.rules[AuditRule{Dir: finLinux}] {
		t.Fatal("regra não foi recolocada")
	}

	// Remoção pelo portal.
	srv.cfg = Config{Version: 2, Paths: []PathConfig{{ID: finID, Path: finLinux, State: "removed", Status: "removing", Recursive: true, AuditRead: true}}}
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sys.rules) != 0 || len(samba.Managed(sys.smb.conf)) != 0 || sys.smb.rate {
		t.Fatalf("sobrou configuração: %v\n%s", sys.rules, sys.smb.conf)
	}
	if !strings.Contains(sys.smb.conf, "[dados]\n\tpath = /srv/dados\n\tvfs objects = acl_xattr\n") {
		t.Fatalf("smb.conf não voltou ao original:\n%s", sys.smb.conf)
	}
	r = result(t, srv.lastResults()[0])
	if r["operation"] != "remove" || r["status"] != "removed" {
		t.Fatalf("remoção: %v", r)
	}
}

func TestLinuxMissingFolderAndRuleError(t *testing.T) {
	s, sys, srv := setupLinux(t)
	sys.smb = nil
	srv.cfg = Config{Version: 1, Paths: []PathConfig{
		{ID: finID, Path: finLinux, State: "active", Status: "pending", Recursive: true},
		{ID: rhID, Path: "/srv/naoexiste", State: "active", Status: "pending", Recursive: true},
	}}
	sys.addFail = map[string]error{finLinux: errString("Operation not permitted")}
	if err := s.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	byID := map[string]map[string]any{}
	for _, v := range srv.lastResults() {
		r := result(t, v)
		byID[r["path_id"].(string)] = r
	}
	if r := byID[finID]; r["status"] != "error" || !strings.Contains(r["message"].(string), "Operation not permitted") {
		t.Fatalf("fin: %v", r)
	}
	if r := byID[rhID]; r["status"] != "error" || r["message"] != "a pasta não existe no servidor" {
		t.Fatalf("rh: %v", r)
	}
	// O erro não é repetido a cada consulta.
	n := len(srv.results)
	srv.cfg.Paths[0].Status, srv.cfg.Paths[1].Status = "error", "error"
	if err := s.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(srv.results) != n {
		t.Fatalf("erro reenviado: %v", srv.lastResults())
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestExclusionsLinux(t *testing.T) {
	var x Exclusions
	if !x.InScope("/qualquer", false) {
		t.Fatal("antes da configuração tudo passa")
	}
	x.set([]PathConfig{
		{Path: "/srv/dados/fin", State: "active", Recursive: true, AuditRead: false, Exclusions: []string{"*.tmp", "Backup/Antigo"}},
		{Path: "/srv/rh", State: "active", Recursive: false, AuditRead: true},
	})
	cases := []struct {
		path string
		read bool
		want bool
	}{
		{"/srv/dados/fin/a/b.txt", false, true},
		{"/srv/dados/fin/a/b.txt", true, false},
		{"/srv/dados/financeiro/x", false, false},
		{"/srv/rh/a.txt", true, true},
		{"/srv/rh/sub/a.txt", false, false},
		{"/srv/rh", false, true},
	}
	for _, c := range cases {
		if got := x.InScope(c.path, c.read); got != c.want {
			t.Errorf("InScope(%q, %v) = %v", c.path, c.read, got)
		}
	}
	if !x.Excluded("/srv/dados/fin/x/arquivo.tmp") || !x.Excluded("/srv/dados/fin/Backup/Antigo/a.txt") || x.Excluded("/srv/dados/fin/Backup/a.txt") {
		t.Fatal("exclusões com / não funcionam")
	}
}
