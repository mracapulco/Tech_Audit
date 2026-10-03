package samba

import (
	"strings"
	"testing"
	"time"
)

func TestParseSession(t *testing.T) {
	t0 := time.Date(2026, 10, 3, 18, 30, 17, 0, time.UTC)
	lines := []string{
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x80|dir|open|/dados/fin",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x12019f|file|overwrite_if|/dados/fin/n5.txt",
		"alice|VM|127.0.0.1|dados|/dados|ftruncate|ok|/dados/fin/n5.txt",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x12019f|file|overwrite_if|/dados/fin/velho.txt",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x120089|file|open|/dados/fin/n5.txt",
		"alice|VM|127.0.0.1|dados|/dados|create_file|fail (No such file or directory)|0x12019f|file|overwrite_if|/dados/fin/ro.txt",
		"alice|VM|127.0.0.1|dados|/dados|create_file|fail (No such file or directory)|0x80|file|open|/dados/fin/naoexiste.txt",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x10000|file|open|/dados/fin/ro.txt",
		"alice|VM|127.0.0.1|dados|/dados|unlinkat|ok|/dados/fin/ro.txt",
		"alice|VM|127.0.0.1|dados|/dados|mkdirat|ok|/dados/fin/dd",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x80|dir|create|/dados/fin/dd",
		"alice|VM|127.0.0.1|dados|/dados|renameat|ok|/dados/fin/n5.txt|/dados/fin/dd/n6.txt",
		"alice|VM|127.0.0.1|dados|/dados|renameat|ok|/dados/fin/dd/n6.txt|/dados/fin/dd/n7.txt",
		"alice|VM|127.0.0.1|dados|/dados|renameat|ok|/dados/fin/dd/n7.txt|/dados/.recycle/alice/fin/dd/n7.txt",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x10000|dir|open|/dados/fin/dd",
		"alice|VM|127.0.0.1|dados|/dados|unlinkat|ok|/dados/fin/dd",
		`TECHMASTER\rafael|TECHMASTER|::ffff:192.168.1.20|fin|/srv/fin|fset_nt_acl|ok|/srv/fin/a.xlsx`,
		"bob|VM|192.168.1.21|dados|/dados|unlink|ok|antigo/b.txt",
		"pam_unix(samba:session): session closed for user alice",
	}
	p := &Parser{
		Hostname: "srv",
		Born: func(path string) (time.Time, bool) {
			if strings.HasSuffix(path, "n5.txt") {
				return t0, true
			}
			return t0.Add(-time.Hour), true
		},
		Exists: func(path string) bool { return !strings.HasSuffix(path, "naoexiste.txt") },
	}
	var got []string
	for i, l := range lines {
		ev, ok := p.Parse(Message{Cursor: "c" + string(rune('a'+i)), Time: t0, PID: "1700", Text: l})
		if !ok {
			continue
		}
		s := ev.Action + " " + ev.ItemType + " " + ev.Path
		if ev.NewPath != "" {
			s += " -> " + ev.NewPath
		}
		s += " " + ev.User.Domain + `\` + ev.User.Name + " " + ev.ClientIP + " " + ev.ShareName
		got = append(got, s)
	}
	want := []string{
		`created file /dados/fin/n5.txt VM\alice 127.0.0.1 dados`,
		`modified file /dados/fin/n5.txt VM\alice 127.0.0.1 dados`,
		`modified file /dados/fin/velho.txt VM\alice 127.0.0.1 dados`,
		`read file /dados/fin/n5.txt VM\alice 127.0.0.1 dados`,
		`denied file /dados/fin/ro.txt VM\alice 127.0.0.1 dados`,
		`deleted file /dados/fin/ro.txt VM\alice 127.0.0.1 dados`,
		`created folder /dados/fin/dd VM\alice 127.0.0.1 dados`,
		`moved file /dados/fin/n5.txt -> /dados/fin/dd/n6.txt VM\alice 127.0.0.1 dados`,
		`renamed file /dados/fin/dd/n6.txt -> /dados/fin/dd/n7.txt VM\alice 127.0.0.1 dados`,
		`recycled file /dados/fin/dd/n7.txt -> /dados/.recycle/alice/fin/dd/n7.txt VM\alice 127.0.0.1 dados`,
		`deleted folder /dados/fin/dd VM\alice 127.0.0.1 dados`,
		`permission_changed file /srv/fin/a.xlsx TECHMASTER\rafael 192.168.1.20 fin`,
		`deleted file /dados/antigo/b.txt VM\bob 192.168.1.21 dados`,
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("eventos:\n%s", strings.Join(got, "\n"))
	}
}

// Lote real do Samba 4.19: permissões gravadas ao criar, arquivo criado e
// logo renomeado, temporário apagado e descritor depois do caminho.
func TestParseBatch(t *testing.T) {
	t0 := time.Date(2026, 10, 3, 19, 0, 0, 0, time.UTC)
	texts := []string{
		"alice|VM|127.0.0.1|dados|/dados|mkdirat|ok|/dados/fin/nova",
		"alice|VM|127.0.0.1|dados|/dados|sys_acl_set_fd|ok|/dados/fin/nova",
		"alice|VM|127.0.0.1|dados|/dados|sys_acl_set_fd|ok|/dados/fin/~tmp1.tmp",
		"alice|VM|127.0.0.1|dados|/dados|fset_nt_acl|ok|/dados/fin/~tmp1.tmp []",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x12019f|file|overwrite_if|/dados/fin/~tmp1.tmp",
		"alice|VM|127.0.0.1|dados|/dados|renameat|ok|/dados/fin/~tmp1.tmp|/dados/fin/plano.docx",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x12019f|file|overwrite_if|/dados/fin/lixo.tmp",
		"alice|VM|127.0.0.1|dados|/dados|sys_acl_set_fd|ok|/dados/fin/apagado.txt",
		"alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x12019f|file|create|/dados/fin/apagado.txt",
		"alice|VM|127.0.0.1|dados|/dados|unlinkat|ok|/dados/fin/apagado.txt",
		"alice|VM|127.0.0.1|dados|/dados|fset_nt_acl|ok|/dados/fin/antigo.xlsx [O:S-1-5-21G:S-1-5-21D:(A;;FA;;;WD)]",
	}
	born := map[string]time.Time{"/dados/fin/nova": t0, "/dados/fin/plano.docx": t0, "/dados/fin/antigo.xlsx": t0.Add(-24 * time.Hour)}
	p := &Parser{
		Born:   func(path string) (time.Time, bool) { b, ok := born[path]; return b, ok },
		Exists: func(path string) bool { _, ok := born[path]; return ok },
	}
	var ms []Message
	for i, s := range texts {
		ms = append(ms, Message{Cursor: string(rune('a' + i)), Time: t0, PID: "1", Text: s})
	}
	var got []string
	for _, ev := range p.ParseBatch(ms) {
		s := ev.Action + " " + ev.ItemType + " " + ev.Path
		if ev.NewPath != "" {
			s += " -> " + ev.NewPath
		}
		got = append(got, s)
	}
	want := []string{
		"created folder /dados/fin/nova",
		"created folder /dados/fin/nova",
		"created file /dados/fin/~tmp1.tmp",
		"created file /dados/fin/~tmp1.tmp",
		"created file /dados/fin/~tmp1.tmp",
		"renamed file /dados/fin/~tmp1.tmp -> /dados/fin/plano.docx",
		"created file /dados/fin/lixo.tmp",
		"created file /dados/fin/apagado.txt",
		"created file /dados/fin/apagado.txt",
		"deleted file /dados/fin/apagado.txt",
		"permission_changed file /dados/fin/antigo.xlsx",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("eventos:\n%s", strings.Join(got, "\n"))
	}
}

// Lote cortado entre a permissão e o create_file de um arquivo já apagado.
func TestParseBatchSplit(t *testing.T) {
	t0 := time.Date(2026, 10, 3, 19, 0, 0, 0, time.UTC)
	clock := t0
	p := &Parser{Exists: func(string) bool { return false }, now: func() time.Time { return clock }}
	msg := func(c, text string) Message { return Message{Cursor: c, Time: t0, PID: "1", Text: text} }
	if evs := p.ParseBatch([]Message{msg("a", "alice|VM|127.0.0.1|dados|/dados|sys_acl_set_fd|ok|/dados/x.txt")}); len(evs) != 0 {
		t.Fatalf("permissão deveria esperar: %v", evs)
	}
	evs := p.ParseBatch([]Message{
		msg("b", "alice|VM|127.0.0.1|dados|/dados|create_file|ok|0x12019f|file|create|/dados/x.txt"),
		msg("c", "alice|VM|127.0.0.1|dados|/dados|fchmod|ok|/dados/y.txt"),
	})
	if len(evs) != 2 || evs[0].Action != "created" || evs[0].Details["permissions_set_on_create"] != "true" || evs[1].Action != "created" {
		t.Fatalf("eventos: %+v", evs)
	}
	// y.txt não teve create_file: sai como permissão depois de holdFor.
	if evs := p.ParseBatch(nil); len(evs) != 0 {
		t.Fatalf("saiu antes da hora: %v", evs)
	}
	clock = clock.Add(holdFor)
	if evs := p.ParseBatch(nil); len(evs) != 1 || evs[0].Action != "permission_changed" || evs[0].Path != "/dados/y.txt" {
		t.Fatalf("eventos: %+v", evs)
	}
}

func TestParseJournalLine(t *testing.T) {
	m, ok := parseJournalLine([]byte(`{"__CURSOR":"s=1;i=2","__REALTIME_TIMESTAMP":"1791052217000000","_PID":"1700","MESSAGE":[97,124,98]}`))
	if !ok || m.Text != "a|b" || m.PID != "1700" || m.Time.Unix() != 1791052217 {
		t.Fatalf("%+v", m)
	}
}
