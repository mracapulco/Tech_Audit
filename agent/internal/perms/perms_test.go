package perms

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/samba"
)

func resolveTest(s string) Principal {
	if p, ok := WellKnown[s]; ok {
		return p
	}
	if s == "S-1-5-21-1-2-3-1104" {
		return Principal{Name: `CORP\joao.silva`, SID: s, Kind: "user"}
	}
	if s == "S-1-5-21-1-2-3-2001" {
		return Principal{Name: `CORP\Financeiro`, SID: s, Kind: "group"}
	}
	return Principal{Name: s, SID: s, Kind: "unknown"}
}

func TestRightsLabel(t *testing.T) {
	cases := []struct {
		mask  uint32
		share bool
		want  string
	}{
		{0x1f01ff, false, "Controle total"},
		{0x10000000, false, "Controle total"}, // GA
		{0x1301bf, false, "Modificar"},
		{0x1301bf, true, "Alteração"},
		{0x1200a9, false, "Leitura e execução"},
		{0x120089, false, "Leitura"},
		{0x80000000, false, "Leitura"}, // GR
		{0x100116, false, "Gravação"},
		{0x1201bf, false, "Leitura e execução, Gravação"},
		{0x10000, false, "Especial"}, // só excluir
		{0x1200a9 | 0x40000, false, "Leitura e execução + especiais"},
	}
	for _, c := range cases {
		if got := RightsLabel(c.mask, c.share); got != c.want {
			t.Errorf("RightsLabel(%#x, %v) = %q, quero %q", c.mask, c.share, got, c.want)
		}
	}
}

func TestAppliesTo(t *testing.T) {
	cases := map[string]string{
		"OICI":   "Esta pasta, subpastas e arquivos",
		"CI":     "Esta pasta e subpastas",
		"OI":     "Esta pasta e arquivos",
		"":       "Somente esta pasta",
		"OICIIO": "Somente subpastas e arquivos",
		"CIIO":   "Somente subpastas",
		"OIIO":   "Somente arquivos",
		"OICINP": "Esta pasta, subpastas e arquivos (um nível)",
		"OICIID": "Esta pasta, subpastas e arquivos",
	}
	for in, want := range cases {
		var flags []string
		for i := 0; i+2 <= len(in); i += 2 {
			flags = append(flags, in[i:i+2])
		}
		if got := AppliesTo(flags); got != want {
			t.Errorf("AppliesTo(%s) = %q, quero %q", in, got, want)
		}
	}
}

func TestFromSDDL(t *testing.T) {
	desc := "O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(D;OICI;0x10000;;;S-1-5-21-1-2-3-1104)(A;OICI;0x1301bf;;;S-1-5-21-1-2-3-2001)(A;OICIIOID;GA;;;CO)(A;;0x1200a9;;;S-1-5-21-9-9-9-500)S:AI(AU;OICISAFA;0x10000;;;WD)"
	f, err := FromSDDL(desc, resolveTest, false)
	if err != nil {
		t.Fatal(err)
	}
	if f.Owner != `BUILTIN\Administradores` || !f.Protected {
		t.Fatalf("dono/proteção: %+v", f)
	}
	if len(f.Entries) != 6 {
		t.Fatalf("esperava 6 entradas (sem a SACL), veio %d: %+v", len(f.Entries), f.Entries)
	}
	e := f.Entries[2]
	if e.Principal != `CORP\joao.silva` || e.Access != "deny" || e.Rights != "Especial" || e.Kind != "user" {
		t.Errorf("negação: %+v", e)
	}
	if e := f.Entries[3]; e.Rights != "Modificar" || e.Kind != "group" || e.Inherited || e.AppliesTo != "Esta pasta, subpastas e arquivos" {
		t.Errorf("grupo: %+v", e)
	}
	if e := f.Entries[4]; !e.Inherited || e.Rights != "Controle total" || e.AppliesTo != "Somente subpastas e arquivos" {
		t.Errorf("criador proprietário: %+v", e)
	}
	if e := f.Entries[5]; e.AppliesTo != "Somente esta pasta" || e.Rights != "Leitura e execução" {
		t.Errorf("somente esta pasta: %+v", e)
	}
	if DiffersNTFS(&f, nil) != "protected" {
		t.Error("herança desligada deveria entrar no inventário")
	}

	inh, _ := FromSDDL("O:BAD:AI(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)", resolveTest, false)
	if inh.Protected || DiffersNTFS(&inh, nil) != "" {
		t.Errorf("pasta só com herança não deveria entrar: %+v", inh)
	}
	exp, _ := FromSDDL("O:BAD:AI(A;OICI;0x1301bf;;;S-1-5-21-1-2-3-2001)(A;OICIID;FA;;;BA)", resolveTest, false)
	if DiffersNTFS(&exp, nil) != "explicit" {
		t.Error("entrada explícita deveria entrar")
	}

	empty, _ := FromSDDL("O:BAD:PS:(AU;SA;FA;;;WD)", resolveTest, false)
	if len(empty.Entries) != 0 || !empty.Protected {
		t.Errorf("DACL vazia: %+v", empty)
	}
	null, _ := FromSDDL("O:BAD:NO_ACCESS_CONTROL", resolveTest, false)
	if len(null.Entries) != 1 || null.Entries[0].Rights != "Controle total" {
		t.Errorf("DACL nula: %+v", null)
	}
	share, _ := FromSDDL("D:(A;;0x1301bf;;;WD)(A;;FA;;;BA)", resolveTest, true)
	if share.Entries[0].Rights != "Alteração" || share.Entries[0].AppliesTo != "Compartilhamento" || share.Entries[0].Principal != "Todos" {
		t.Errorf("compartilhamento: %+v", share.Entries)
	}
}

type names struct{}

func (names) User(uid uint32) string {
	return map[uint32]string{0: "root", 1000: "rafael", 1001: "maria"}[uid]
}
func (names) Group(gid uint32) string {
	return map[uint32]string{0: "root", 100: "users", 2000: "financeiro"}[gid]
}

func acl(entries ...ACLEntry) []byte {
	b := make([]byte, 4, 4+8*len(entries))
	binary.LittleEndian.PutUint32(b, 2)
	for _, e := range entries {
		var x [8]byte
		binary.LittleEndian.PutUint16(x[0:], e.Tag)
		binary.LittleEndian.PutUint16(x[2:], e.Perm)
		binary.LittleEndian.PutUint32(x[4:], e.ID)
		b = append(b, x[:]...)
	}
	return b
}

func TestPosix(t *testing.T) {
	f := FromPosix(PosixInfo{UID: 1000, GID: 2000, Mode: 0o750}, names{})
	want := []string{"rafael (dono)|Leitura e gravação|rwx", "financeiro (grupo dono)|Leitura|r-x", "Todos os outros|Sem acesso|---"}
	if len(f.Entries) != 3 {
		t.Fatalf("%+v", f.Entries)
	}
	for i, e := range f.Entries {
		if got := e.Principal + "|" + e.Rights + "|" + e.Raw; got != want[i] {
			t.Errorf("entrada %d = %s, quero %s", i, got, want[i])
		}
	}

	raw := acl(ACLEntry{aclUserObj, 7, 0}, ACLEntry{aclUser, 7, 1001}, ACLEntry{aclGroupObj, 5, 0}, ACLEntry{aclGroup, 7, 100}, ACLEntry{aclMask, 5, 0}, ACLEntry{aclOther, 0, 0})
	access, err := ParseACL(raw)
	if err != nil {
		t.Fatal(err)
	}
	def, _ := ParseACL(acl(ACLEntry{aclUserObj, 7, 0}, ACLEntry{aclGroup, 7, 2000}, ACLEntry{aclGroupObj, 5, 0}, ACLEntry{aclMask, 7, 0}, ACLEntry{aclOther, 0, 0}))
	g := FromPosix(PosixInfo{UID: 0, GID: 0, Mode: 0o750, Access: access, Default: def}, names{})
	got := []string{}
	for _, e := range g.Entries {
		got = append(got, e.Principal+"|"+e.Raw+"|"+e.AppliesTo)
	}
	joined := strings.Join(got, "\n")
	for _, w := range []string{
		"maria|r-x|Somente esta pasta", // rwx limitado pela máscara r-x
		"users|r-x|Somente esta pasta",
		"financeiro|rwx|Novos itens criados dentro (ACL padrão)",
		"Grupo do item novo|r-x|Novos itens criados dentro (ACL padrão)",
	} {
		if !strings.Contains(joined, w) {
			t.Errorf("faltou %q em:\n%s", w, joined)
		}
	}
	if DiffersPosix(&g, &f) != "changed" || DiffersPosix(&f, &f) != "" {
		t.Error("comparação com a pasta de cima")
	}
	if _, err := ParseACL([]byte{1, 2, 3}); err == nil {
		t.Error("ACL inválida deveria dar erro")
	}
}

func TestSamba(t *testing.T) {
	shares := samba.ParseTestparm(`[global]
	workgroup = CORP
[Financeiro]
	path = /srv/financeiro
	valid users = @financeiro, maria, "CORP\joao silva"
	write list = maria
	invalid users = estagiario
[Publico]
	path = /srv/publico
	read only = No
	guest ok = Yes
`)
	f := FromSamba(shares[0])
	got := []string{}
	for _, e := range f.Entries {
		got = append(got, e.Principal+"|"+e.Kind+"|"+e.Access+"|"+e.Rights)
	}
	want := []string{
		"financeiro|group|allow|Leitura",
		"maria|user|allow|Leitura e gravação",
		`CORP\joao silva|user|allow|Leitura`,
		"estagiario|user|deny|Sem acesso",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("Financeiro:\n%s\nquero:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	p := FromSamba(shares[1])
	if len(p.Entries) != 1 || p.Entries[0].Rights != "Leitura e gravação" || !strings.Contains(p.Entries[0].Principal, "convidados") {
		t.Errorf("Publico: %+v", p.Entries)
	}
}

// fakeReader: permissão própria nas pastas com "explicita" no nome.
type fakeReader struct{ fail string }

func (r fakeReader) Read(path string) (Folder, error) {
	if r.fail != "" && strings.HasSuffix(path, r.fail) {
		return Folder{}, errors.New("acesso negado")
	}
	f := Folder{Source: "ntfs", Entries: []Entry{{Principal: "Todos", Inherited: true}}}
	if strings.Contains(filepath.Base(path), "explicita") {
		f.Entries = append(f.Entries, Entry{Principal: "Financeiro"})
	}
	return f, nil
}
func (fakeReader) Differs(c, p *Folder) string { return DiffersNTFS(c, p) }
func (fakeReader) Shares(root string) ([]Folder, error) {
	return []Folder{{Path: root, Share: "Dados", Entries: []Entry{{Principal: "Todos"}}}}, nil
}

func TestScan(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"a/b/c", "a/explicita1/d", "explicita2", "negada/x"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(root, "arquivo.txt"), []byte("x"), 0o644)
	os.Symlink(filepath.Join(root, "a"), filepath.Join(root, "link"))

	res := Scan(context.Background(), fakeReader{fail: "negada"}, root, Options{})
	if res.Err != nil {
		t.Fatal(res.Err)
	}
	var got []string
	for _, f := range res.Folders {
		rel, _ := filepath.Rel(root, f.Path)
		got = append(got, rel+":"+f.Reason)
	}
	want := ".:root .:share a/explicita1:explicit explicita2:explicit negada:error"
	if strings.Join(got, " ") != want {
		t.Errorf("pastas = %v, quero %s", got, want)
	}
	// raiz, a, a/b, a/b/c, a/explicita1, a/explicita1/d, explicita2, negada (sem o link)
	if res.Scanned != 8 {
		t.Errorf("lidas = %d, quero 8", res.Scanned)
	}

	res = Scan(context.Background(), fakeReader{}, root, Options{MaxFolders: 3})
	if !res.Truncated || len(res.Folders) != 3 {
		t.Errorf("limite: truncated=%v pastas=%d", res.Truncated, len(res.Folders))
	}
	if r := Scan(context.Background(), fakeReader{}, filepath.Join(root, "nao-existe"), Options{}); r.Err == nil {
		t.Error("caminho inexistente deveria dar erro")
	}
}

func TestRunner(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 3; i++ {
		os.MkdirAll(filepath.Join(root, "explicita"+string(rune('a'+i))), 0o755)
	}
	var sent []Upload
	fail := false
	send := func(_ context.Context, u Upload) error {
		if fail {
			return errors.New("fora do ar")
		}
		sent = append(sent, u)
		return nil
	}
	state := filepath.Join(t.TempDir(), "perms.json")
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC)
	r := NewRunner(fakeReader{}, send, state)
	r.now = func() time.Time { return now }
	paths := []Path{{ID: "p1", Path: root}}

	r.Update(Settings{Enabled: false}, paths)
	if r.dueLocked() {
		t.Fatal("desligado não coleta")
	}
	r.Update(Settings{Enabled: true}, paths)
	if !r.dueLocked() {
		t.Fatal("primeira coleta devida")
	}
	r.RunOnce(context.Background())
	if len(sent) != 1 || !sent[0].Final || len(sent[0].Folders) != 5 || sent[0].PathID != "p1" {
		t.Fatalf("envio: %+v", sent)
	}
	if r.dueLocked() {
		t.Error("logo depois da coleta não deveria estar devida")
	}
	r.Update(Settings{Enabled: true, RequestedAt: "2026-10-05T12:30:00Z"}, paths)
	if !r.dueLocked() {
		t.Error("Atualizar agora deveria disparar")
	}
	r.RunOnce(context.Background())
	r.Update(Settings{Enabled: true, RequestedAt: "2026-10-05T12:30:00Z"}, append(paths, Path{ID: "p2", Path: root}))
	if !r.dueLocked() {
		t.Error("caminho novo deveria disparar")
	}

	// Estado salvo sobrevive ao reinício.
	r2 := NewRunner(fakeReader{}, send, state)
	r2.now = func() time.Time { return now.Add(23 * time.Hour) }
	r2.Update(Settings{Enabled: true, RequestedAt: "2026-10-05T12:30:00Z"}, paths)
	if r2.dueLocked() {
		t.Error("depois de reiniciar, só coleta de novo após 24 h")
	}
	r2.now = func() time.Time { return now.Add(25 * time.Hour) }
	if !r2.dueLocked() {
		t.Error("24 h depois deveria coletar")
	}

	// Falha no envio: espera 30 min.
	fail = true
	r2.RunOnce(context.Background())
	if r2.dueLocked() {
		t.Error("depois de falhar deveria esperar")
	}
	r2.now = func() time.Time { return now.Add(26 * time.Hour) }
	if !r2.dueLocked() {
		t.Error("depois da espera deveria tentar de novo")
	}

	// Muitas pastas: várias partes.
	big := t.TempDir()
	for i := 0; i < PartSize+10; i++ {
		os.MkdirAll(filepath.Join(big, "explicita"+strings.Repeat("x", 1)+itoa(i)), 0o755)
	}
	fail, sent = false, nil
	r3 := NewRunner(fakeReader{}, send, filepath.Join(t.TempDir(), "s.json"))
	r3.Update(Settings{Enabled: true}, []Path{{ID: "p", Path: big}})
	r3.RunOnce(context.Background())
	if len(sent) != 2 || sent[0].Final || !sent[1].Final || sent[1].Part != 1 || sent[0].ScanID != sent[1].ScanID {
		t.Errorf("partes: %d", len(sent))
	}
}

func itoa(i int) string {
	s := ""
	for {
		s = string(rune('0'+i%10)) + s
		i /= 10
		if i == 0 {
			return s
		}
	}
}
