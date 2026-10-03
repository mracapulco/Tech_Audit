package auditd

import (
	"bufio"
	"os"
	"strings"
	"testing"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

func readGroups(t *testing.T, file string) []*Group {
	t.Helper()
	f, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	a := &Assembler{Keys: map[string]bool{KeyWrite: true, KeyRead: true}}
	var out []*Group
	sc := bufio.NewScanner(f)
	var off int64
	for sc.Scan() {
		r, err := ParseRecord(sc.Text())
		if err != nil {
			t.Fatalf("%v: %q", err, sc.Text())
		}
		out = append(out, a.Add(r, off)...)
		off += int64(len(sc.Text()) + 1)
	}
	return append(out, a.Flush()...)
}

func TestParseRecord(t *testing.T) {
	r, err := ParseRecord("type=PATH msg=audit(1791052098.520:6): item=1 name=\"rel.txt\" inode=8175619 dev=fe:00 mode=0100744 nametype=CREATE\x1dOUID=\"alice\"")
	if err != nil {
		t.Fatal(err)
	}
	if r.Type != "PATH" || r.Serial != 6 || r.Time.UnixMilli() != 1791052098520 {
		t.Fatalf("cabeçalho: %+v", r)
	}
	if r.Text("name") != "rel.txt" || r.Fields["nametype"] != "CREATE" || r.Enriched["OUID"] != `"alice"` {
		t.Fatalf("campos: %+v %+v", r.Fields, r.Enriched)
	}
	r, _ = ParseRecord(`type=PROCTITLE msg=audit(1.5:7): proctitle=736D62643A20636C69656E74205B3132372E302E302E315D`)
	if got := r.Text("proctitle"); got != "smbd: client [127.0.0.1]" {
		t.Fatalf("proctitle = %q", got)
	}
	r, _ = ParseRecord(`type=PATH msg=audit(1.5:7): item=0 name=2F6461646F732F6D657520617271756976652E747874 nametype=NORMAL`)
	if got := r.Text("name"); got != "/dados/meu arquive.txt" {
		t.Fatalf("nome em hexadecimal = %q", got)
	}
}

func TestConvertLocalSession(t *testing.T) {
	dirs := &DirMap{}
	dirs.AddRoot(FileKey{"fe:00", 8175617}, "/dados")
	dirs.AddDir(FileKey{"fe:00", 8175618}, FileKey{"fe:00", 8175617}, "fin")
	c := &Converter{Hostname: "srv-arquivos.local", Dirs: dirs}
	var got []string
	for _, g := range readGroups(t, "testdata/local.log") {
		ev, ok := c.Convert(g)
		if !ok {
			continue
		}
		if ev.User.Name != "alice" || ev.User.Domain != "SRV-ARQUIVOS" {
			t.Errorf("usuário = %+v", ev.User)
		}
		if ev.Details["run_as"] != "root" {
			t.Errorf("run_as = %q", ev.Details["run_as"])
		}
		s := ev.Action + " " + ev.ItemType + " " + ev.Path
		if ev.NewPath != "" {
			s += " -> " + ev.NewPath
		}
		got = append(got, s)
	}
	want := []string{
		"created file /dados/fin/l1.txt",
		"modified file /dados/fin/l1.txt",
		"renamed file /dados/fin/l1.txt -> /dados/fin/l2.txt",
		"created folder /dados/fin/d1",
		"created folder /dados/fin/d1/d2",
		"created file /dados/fin/d1/d2/l2.txt",
		"moved file /dados/fin/l2.txt -> /dados/fin/d1/l2.txt",
		"permission_changed file /dados/fin/d1/l2.txt",
		"owner_changed file /dados/fin/d1/l2.txt",
		"modified file /dados/fin/d1/l2.txt",
		"deleted file /dados/fin/d1/d2/l2.txt",
		"deleted folder /dados/fin/d1/d2",
		"deleted file /dados/fin/d1/l2.txt",
		"deleted folder /dados/fin/d1",
		"created file /dados/fin/abs.txt",
		"deleted file /dados/fin/abs.txt",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("eventos:\n%s\n\nesperado:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestRecordIDStable(t *testing.T) {
	a, b := RecordID("1791052098.520:6"), RecordID("1791052098.520:6")
	if a != b || a >= 1<<53 || RecordID("1791052098.520:7") == a {
		t.Fatal("RecordID instável")
	}
}

func TestConvertSaveAndRead(t *testing.T) {
	dirs := &DirMap{}
	dirs.AddRoot(FileKey{"fe:00", 8175618}, "/dados/fin")
	c := &Converter{Hostname: "srv", Dirs: dirs}
	var got []string
	for _, g := range readGroups(t, "testdata/save.log") {
		if ev, ok := c.Convert(g); ok {
			got = append(got, ev.Action+" "+ev.Path+" "+ev.Details["saved_from"])
		}
	}
	want := []string{
		"created /dados/fin/doc.txt ",
		"created /dados/fin/.doc.tmp ",
		"modified /dados/fin/doc.txt /dados/fin/.doc.tmp",
		event.ActionRead + " /dados/fin/doc.txt ",
		"deleted /dados/fin/doc.txt ",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("eventos:\n%s", strings.Join(got, "\n"))
	}
}
