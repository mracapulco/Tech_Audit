package event

import (
	"os"
	"reflect"
	"testing"
	"time"
)

func load(t *testing.T, name string) *Raw {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	r, err := ParseXML(b)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestNormalize4663Write(t *testing.T) {
	n := NewNormalizer(Filter{ObjectTypes: []string{"File"}}, 0)
	ev, ok := n.Normalize(load(t, "4663_write.xml"))
	if !ok {
		t.Fatal("evento descartado")
	}
	want := Event{
		RecordID: 1001, EventID: 4663, Kind: "object_access",
		Time:     time.Date(2026, 10, 1, 14, 3, 22, 123456700, time.UTC),
		Computer: "FS01.corp.local",
		User: User{Name: "joao.silva", Domain: "CORP",
			SID: "S-1-5-21-1111111111-2222222222-3333333333-1104", LogonID: "0x3e7a1f"},
		Path: `D:\Shares\Financeiro\Relatorios\2026-09.xlsx`, ObjectType: "File",
		Actions: []string{"write"}, AccessMask: "0x2", Outcome: "success", HandleID: "0x1a2c",
	}
	if !reflect.DeepEqual(ev, want) {
		t.Errorf("got  %+v\nwant %+v", ev, want)
	}
}

func TestNormalize4660ResolvesPathFromHandle(t *testing.T) {
	n := NewNormalizer(Filter{}, 0)
	if _, ok := n.Normalize(load(t, "4663_delete.xml")); !ok {
		t.Fatal("4663 descartado")
	}
	ev, ok := n.Normalize(load(t, "4660.xml"))
	if !ok {
		t.Fatal("4660 descartado")
	}
	if ev.Kind != "object_deleted" || ev.Path != `D:\Shares\Financeiro\antigo.docx` ||
		!reflect.DeepEqual(ev.Actions, []string{"delete"}) {
		t.Errorf("4660 inesperado: %+v", ev)
	}
}

func TestNormalize4656Denied(t *testing.T) {
	n := NewNormalizer(Filter{}, 0)
	ev, _ := n.Normalize(load(t, "4656_denied.xml"))
	if ev.Outcome != "failure" || ev.Kind != "handle_request" || !reflect.DeepEqual(ev.Actions, []string{"read"}) {
		t.Errorf("4656 inesperado: %+v", ev)
	}
}

func TestNormalize5145(t *testing.T) {
	n := NewNormalizer(Filter{}, 0)
	ev, _ := n.Normalize(load(t, "5145.xml"))
	if ev.Path != `D:\Shares\Financeiro\Relatorios\2026-09.xlsx` || ev.ClientIP != "10.0.0.25" ||
		ev.ShareName != `\\*\Financeiro` || !reflect.DeepEqual(ev.Actions, []string{"read"}) {
		t.Errorf("5145 inesperado: %+v", ev)
	}
}

func TestFilter(t *testing.T) {
	r := load(t, "4663_write.xml")
	cases := []struct {
		name string
		f    Filter
		keep bool
	}{
		{"sem filtro", Filter{}, true},
		{"prefixo incluído", Filter{IncludePaths: []string{`d:\shares\financeiro\`}}, true},
		{"prefixo fora", Filter{IncludePaths: []string{`D:\Shares\RH`}}, false},
		{"trecho excluído", Filter{ExcludePathContains: []string{`\relatorios\`}}, false},
		{"tipo diferente", Filter{ObjectTypes: []string{"Key"}}, false},
	}
	for _, c := range cases {
		if _, ok := NewNormalizer(c.f, 0).Normalize(r); ok != c.keep {
			t.Errorf("%s: keep=%v, esperado %v", c.name, ok, c.keep)
		}
	}

	r.Data["SubjectUserName"] = "FS01$"
	if _, ok := NewNormalizer(Filter{ExcludeMachineAccounts: true}, 0).Normalize(r); ok {
		t.Error("conta de máquina deveria ser descartada")
	}
}

func TestActionsFromMask(t *testing.T) {
	cases := map[string][]string{
		"0x6":      {"append", "write"},
		"0x10000":  {"delete"},
		"0xc0000":  {"owner_change", "permission_change"},
		"0x120089": {"read"},
		"0x20080":  {},
		"lixo":     nil,
	}
	for mask, want := range cases {
		got := ActionsFromMask(mask)
		if len(got) == 0 && len(want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v want %v", mask, got, want)
		}
	}
	if got := ActionsFromAccessList("%%4416 %%1537\n"); !reflect.DeepEqual(got, []string{"delete", "read"}) {
		t.Errorf("AccessList: %v", got)
	}
}

func TestHandleCacheEviction(t *testing.T) {
	n := NewNormalizer(Filter{}, 2)
	for _, k := range []string{"a", "b", "c"} {
		n.remember(k, k)
	}
	if _, ok := n.handles["a"]; ok || len(n.handles) != 2 {
		t.Errorf("cache não respeitou o limite: %v", n.handles)
	}
}
