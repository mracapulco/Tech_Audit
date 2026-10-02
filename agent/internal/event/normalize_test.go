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

func decode(t *testing.T, name string) Event {
	t.Helper()
	ev, ok := Decode(load(t, name), Filter{})
	if !ok {
		t.Fatalf("%s descartado", name)
	}
	return ev
}

func TestDecode4663Write(t *testing.T) {
	ev, ok := Decode(load(t, "4663_write.xml"), Filter{ObjectTypes: []string{"File"}})
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
		ProcessID: "0x4",
	}
	if !reflect.DeepEqual(ev, want) {
		t.Errorf("got  %+v\nwant %+v", ev, want)
	}
}

func TestDecode4656Denied(t *testing.T) {
	ev := decode(t, "4656_denied.xml")
	if ev.Outcome != "failure" || ev.Kind != "handle_request" || !reflect.DeepEqual(ev.Actions, []string{"read"}) {
		t.Errorf("4656 inesperado: %+v", ev)
	}
}

func TestDecode5145(t *testing.T) {
	ev := decode(t, "5145.xml")
	if ev.Path != `D:\Shares\Financeiro\Relatorios\2026-09.xlsx` || ev.ClientIP != "10.0.0.25" ||
		ev.ShareName != `\\*\Financeiro` || !reflect.DeepEqual(ev.Actions, []string{"read"}) {
		t.Errorf("5145 inesperado: %+v", ev)
	}
}

func TestDecode4670(t *testing.T) {
	ev := decode(t, "4670.xml")
	if ev.Kind != "permissions_changed" || ev.Path != `D:\Shares\Financeiro\contrato.docx` ||
		ev.Details["old_sd"] == "" || ev.Details["new_sd"] == "" {
		t.Errorf("4670 inesperado: %+v", ev)
	}
}

func TestDecode5140(t *testing.T) {
	ev := decode(t, "5140.xml")
	if ev.ClientIP != "10.0.0.25" || ev.User.LogonID != "0x3e7a1f" || ev.ShareName != `\\*\Financeiro` {
		t.Errorf("5140 inesperado: %+v", ev)
	}
}

func TestFilter(t *testing.T) {
	ev := decode(t, "4663_write.xml")
	cases := []struct {
		name string
		f    Filter
		keep bool
	}{
		{"sem filtro", Filter{}, true},
		{"prefixo incluído", Filter{IncludePaths: []string{`d:\shares\financeiro\`}}, true},
		{"prefixo fora", Filter{IncludePaths: []string{`D:\Shares\RH`}}, false},
		{"trecho excluído", Filter{ExcludePathContains: []string{`\relatorios\`}}, false},
	}
	for _, c := range cases {
		if got := c.f.Keep(ev); got != c.keep {
			t.Errorf("%s: keep=%v, esperado %v", c.name, got, c.keep)
		}
	}
	if _, ok := Decode(load(t, "4663_write.xml"), Filter{ObjectTypes: []string{"Key"}}); ok {
		t.Error("tipo diferente deveria ser descartado")
	}

	ev.User.Name = "FS01$"
	if (Filter{ExcludeMachineAccounts: true}).Keep(ev) {
		t.Error("conta de máquina deveria ser descartada")
	}

	// Renomear de um temporário para o nome definitivo passa pelo filtro.
	ren := Event{Path: `D:\Dados\~WRD0001.tmp`, NewPath: `D:\Dados\contrato.docx`}
	if !(Filter{ExcludePathContains: []string{".tmp"}}).Keep(ren) {
		t.Error("renomear para caminho permitido deveria passar")
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

func TestDecodeAlternateStream(t *testing.T) {
	r := load(t, "4663_write.xml")
	r.Data["ObjectName"] += ":Zone.Identifier:$DATA"
	ev, _ := Decode(r, Filter{})
	if ev.Path != `D:\Shares\Financeiro\Relatorios\2026-09.xlsx` || ev.Details["stream"] != "Zone.Identifier" {
		t.Errorf("fluxo alternativo: %q %v", ev.Path, ev.Details)
	}
}
