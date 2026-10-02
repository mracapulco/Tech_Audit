package event

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// fakeFS simula o disco: caminhos existentes, conteúdo de pastas e Lixeira.
type fakeFS struct {
	files   map[string]FileInfo   // caminho em minúsculas
	dirs    map[string][]DirEntry // pasta em minúsculas
	recycle map[string]string     // caminho original em minúsculas -> $R
}

func newFS() *fakeFS {
	return &fakeFS{files: map[string]FileInfo{}, dirs: map[string][]DirEntry{}, recycle: map[string]string{}}
}

func (f *fakeFS) Stat(p string) (FileInfo, error) {
	if i, ok := f.files[strings.ToLower(p)]; ok {
		return i, nil
	}
	return FileInfo{}, fmt.Errorf("%s não existe", p)
}

func (f *fakeFS) ListDir(d string, max int) ([]DirEntry, error) {
	return f.dirs[strings.ToLower(d)], nil
}

func (f *fakeFS) RecycleBinFind(p, sid string, since time.Time) (string, bool) {
	r, ok := f.recycle[strings.ToLower(p)]
	return r, ok
}

func (f *fakeFS) addDir(p string) { f.files[strings.ToLower(p)] = FileInfo{IsDir: true} }

// addEntry cria um item em dir com os horários informados (criado, modificado, ChangeTime).
func (f *fakeFS) addEntry(dir, name string, isDir bool, created, modified, changed time.Time) {
	i := FileInfo{IsDir: isDir, Created: created, Modified: modified, Changed: changed}
	f.dirs[strings.ToLower(dir)] = append(f.dirs[strings.ToLower(dir)], DirEntry{Name: name, FileInfo: i})
	f.files[strings.ToLower(dir+`\`+name)] = i
}

var t0 = time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)

const sid = "S-1-5-21-1-2-3-1104"

var rec uint64 = 5000

// raw monta um evento decodificado como o Decode faria.
func raw(id int, at time.Duration, path, mask, handle string) Event {
	rec++
	ev := Event{
		RecordID: rec, EventID: id, Time: t0.Add(at), Computer: "FS01",
		User:      User{Name: "joao", Domain: "CORP", SID: sid, LogonID: "0x3e7"},
		Path:      path,
		ProcessID: "0x100", Process: `C:\Windows\explorer.exe`,
		HandleID: handle, Outcome: "success", AccessMask: mask, ObjectType: "File",
	}
	switch id {
	case IDObjectDeleted:
		ev.Kind = "object_deleted"
		ev.Actions = []string{"delete"}
	default:
		ev.Kind = "object_access"
		ev.Actions = ActionsFromMask(mask)
	}
	if p, stream := splitStream(path); stream != "" {
		ev.Path = p
		ev.Details = map[string]string{"stream": stream}
	}
	return ev
}

type run struct {
	t   *testing.T
	c   *Correlator
	out []Event
}

func newRun(t *testing.T, fs FS) *run {
	return &run{t: t, c: NewCorrelator(CorrelationConfig{}, Filter{}, fs)}
}

func (r *run) add(evs ...Event) *run {
	for _, ev := range evs {
		r.out = append(r.out, r.c.Add(ev)...)
	}
	return r
}

func (r *run) flush() []Event {
	r.out = append(r.out, r.c.Flush()...)
	return r.out
}

func one(t *testing.T, out []Event) Event {
	t.Helper()
	if len(out) != 1 {
		for _, e := range out {
			t.Logf("  %s %s -> %s (x%d)", e.Action, e.Path, e.NewPath, e.Count)
		}
		t.Fatalf("esperava 1 evento, veio %d", len(out))
	}
	return out[0]
}

func TestDeleteWith4660IsOneEvent(t *testing.T) {
	out := newRun(t, newFS()).add(decode(t, "4663_delete.xml"), decode(t, "4660.xml")).flush()
	ev := one(t, out)
	if ev.Action != ActionDeleted || ev.Path != `D:\Shares\Financeiro\antigo.docx` || ev.RecordID != 1002 ||
		len(ev.RelatedRecords) != 1 || ev.RelatedRecords[0] != 1003 {
		t.Errorf("exclusão inesperada: %+v", ev)
	}
}

func TestPendingAndHandlesSurviveRestart(t *testing.T) {
	c := NewCorrelator(CorrelationConfig{}, Filter{}, newFS())
	if out := c.Add(decode(t, "4663_delete.xml")); len(out) != 0 {
		t.Fatalf("4663 DELETE deveria esperar o 4660: %+v", out)
	}
	st, err := c.State()
	if err != nil {
		t.Fatal(err)
	}
	c2 := NewCorrelator(CorrelationConfig{}, Filter{}, newFS())
	if err := c2.LoadState(st); err != nil {
		t.Fatal(err)
	}
	ev := one(t, append(c2.Add(decode(t, "4660.xml")), c2.Flush()...))
	if ev.Action != ActionDeleted || ev.Path != `D:\Shares\Financeiro\antigo.docx` {
		t.Errorf("após reinício: %+v", ev)
	}

	// 4660 cujo 4663 (sem DELETE) veio antes do reinício: caminho pelo cache de handles.
	c3 := NewCorrelator(CorrelationConfig{}, Filter{}, nil)
	c3.Add(raw(IDHandleRequest, 0, `D:\Dados\x.txt`, "0x10000", "0x50"))
	st, _ = c3.State()
	c4 := NewCorrelator(CorrelationConfig{}, Filter{}, nil)
	c4.LoadState(st)
	ev = one(t, c4.Add(raw(IDObjectDeleted, time.Second, "", "", "0x50")))
	if ev.Path != `D:\Dados\x.txt` || ev.Action != ActionDeleted {
		t.Errorf("4660 com handle salvo: %+v", ev)
	}
}

func TestWriteOnFolderIsCreatedItem(t *testing.T) {
	fs := newFS()
	fs.addDir(`D:\Dados`)
	fs.addEntry(`D:\Dados`, "antigo.txt", false, t0.Add(-time.Hour), t0.Add(-time.Hour), t0.Add(-time.Hour))
	fs.addEntry(`D:\Dados`, "Nova pasta", true, t0.Add(100*time.Millisecond), t0, t0)
	ev := one(t, newRun(t, fs).add(raw(IDObjectAccess, 0, `D:\Dados`, "0x4", "0x10")).flush())
	if ev.Action != ActionCreated || ev.Path != `D:\Dados\Nova pasta` || ev.ItemType != "folder" {
		t.Errorf("criação inesperada: %+v", ev)
	}
}

func TestCreatedFileThenWritesAggregated(t *testing.T) {
	fs := newFS()
	fs.addDir(`D:\Dados`)
	fs.addEntry(`D:\Dados`, "relatorio.xlsx", false, t0.Add(50*time.Millisecond), t0.Add(5*time.Second), t0.Add(5*time.Second))
	out := newRun(t, fs).add(
		raw(IDObjectAccess, 0, `D:\Dados`, "0x2", "0x10"),                                   // pasta: item criado
		raw(IDObjectAccess, 100*time.Millisecond, `D:\Dados\relatorio.xlsx`, "0x2", "0x11"), // o próprio arquivo
		raw(IDObjectAccess, 3*time.Second, `D:\Dados\relatorio.xlsx`, "0x6", "0x12"),
		raw(IDObjectAccess, 5*time.Second, `D:\Dados\relatorio.xlsx`, "0x100", "0x13"),
	).flush()
	ev := one(t, out)
	if ev.Action != ActionCreated || ev.Count != 3 || ev.EndTime == nil || !ev.EndTime.Equal(t0.Add(5*time.Second)) {
		t.Errorf("agregação inesperada: %+v", ev)
	}
}

func TestModifiedExistingFile(t *testing.T) {
	fs := newFS()
	fs.addEntry(`D:\Dados`, "a.docx", false, t0.Add(-48*time.Hour), t0, t0)
	ev := one(t, newRun(t, fs).add(raw(IDObjectAccess, 0, `D:\Dados\a.docx`, "0x2", "0x11")).flush())
	if ev.Action != ActionModified || ev.ItemType != "file" || ev.Count != 1 || ev.EndTime != nil {
		t.Errorf("alteração inesperada: %+v", ev)
	}
}

func TestDeleteToRecycleBin(t *testing.T) {
	fs := newFS()
	fs.recycle[strings.ToLower(`D:\Dados\a.docx`)] = `D:\$Recycle.Bin\` + sid + `\$RAB12CD.docx`
	ev := one(t, newRun(t, fs).add(raw(IDObjectAccess, 0, `D:\Dados\a.docx`, "0x10080", "0x20")).flush())
	if ev.Action != ActionRecycled || !strings.HasSuffix(ev.NewPath, `$RAB12CD.docx`) {
		t.Errorf("Lixeira inesperada: %+v", ev)
	}
}

// Explorer no Windows 11: duas aberturas com DELETE e um 4660 numa delas,
// em qualquer ordem. Deve sair um "recycled" só.
func TestRecycleBinTwoHandles(t *testing.T) {
	for _, order := range []string{"lixeira-primeiro", "4660-primeiro"} {
		fs := newFS()
		fs.recycle[strings.ToLower(`C:\Teste\c.txt`)] = `C:\$Recycle.Bin\` + sid + `\$RQX.txt`
		a := raw(IDObjectAccess, 0, `C:\Teste\c.txt`, "0x10000", "0x3e50")
		b := raw(IDObjectAccess, 10*time.Millisecond, `C:\Teste\c.txt`, "0x10000", "0x23f0")
		d := raw(IDObjectDeleted, 20*time.Millisecond, "", "", "0x23f0")
		evs := []Event{a, b, d}
		if order == "4660-primeiro" {
			evs = []Event{b, d, a}
		}
		ev := one(t, newRun(t, fs).add(evs...).flush())
		if ev.Action != ActionRecycled || !strings.HasSuffix(ev.NewPath, `$RQX.txt`) || len(ev.RelatedRecords) != 2 {
			t.Errorf("%s: %+v", order, ev)
		}
	}
}

func TestRenameInSameFolder(t *testing.T) {
	fs := newFS()
	fs.addDir(`D:\Dados`)
	old := t0.Add(-24 * time.Hour)
	fs.addEntry(`D:\Dados`, "outro.txt", false, old, old, old)
	fs.addEntry(`D:\Dados`, "novo nome.docx", false, old, old, t0.Add(10*time.Millisecond))
	ev := one(t, newRun(t, fs).add(
		raw(IDObjectAccess, 0, `D:\Dados\a.docx`, "0x10080", "0x20"),
		raw(IDObjectAccess, 5*time.Millisecond, `D:\Dados`, "0x2", "0x21"),
	).flush())
	if ev.Action != ActionRenamed || ev.Path != `D:\Dados\a.docx` || ev.NewPath != `D:\Dados\novo nome.docx` {
		t.Errorf("renomear inesperado: %+v", ev)
	}
}

func TestMoveToOtherFolder(t *testing.T) {
	fs := newFS()
	fs.addDir(`D:\Dados`)
	fs.addDir(`D:\Arquivo`)
	old := t0.Add(-24 * time.Hour)
	fs.addEntry(`D:\Arquivo`, "a.docx", false, old, old, t0.Add(10*time.Millisecond))
	ev := one(t, newRun(t, fs).add(
		raw(IDObjectAccess, 0, `D:\Arquivo`, "0x2", "0x21"), // pasta de destino antes do DELETE
		raw(IDObjectAccess, 5*time.Millisecond, `D:\Dados\a.docx`, "0x10080", "0x20"),
	).flush())
	if ev.Action != ActionMoved || ev.NewPath != `D:\Arquivo\a.docx` {
		t.Errorf("mover inesperado: %+v", ev)
	}
}

func TestMoveDestinationUnknown(t *testing.T) {
	ev := one(t, newRun(t, newFS()).add(raw(IDObjectAccess, 0, `D:\Dados\a.docx`, "0x10000", "0x20")).flush())
	if ev.Action != ActionMoved || ev.NewPath != "" {
		t.Errorf("mover sem destino: %+v", ev)
	}
}

// Salvamento do Office: o original é trocado pelo temporário, o caminho
// continua existindo e não há 4660.
func TestDeleteAccessButFileStillThereIsModified(t *testing.T) {
	fs := newFS()
	fs.addEntry(`D:\Dados`, "a.docx", false, t0.Add(-time.Hour), t0, t0)
	ev := one(t, newRun(t, fs).add(raw(IDObjectAccess, 0, `D:\Dados\a.docx`, "0x10000", "0x20")).flush())
	if ev.Action != ActionModified {
		t.Errorf("esperava modified: %+v", ev)
	}
}

func TestBulkPermissionChange(t *testing.T) {
	r := newRun(t, nil)
	for i := range 25 {
		ev := raw(IDObjectAccess, time.Duration(i)*100*time.Millisecond, fmt.Sprintf(`D:\Dados\Fin\%02d\f.txt`, i), "0x40000", fmt.Sprintf("0x%x", 0x500+i))
		ev.Process, ev.ProcessID = `C:\Windows\System32\icacls.exe`, "0x200"
		// Cada item gera 4663 WRITE_DAC + 4670 no mesmo handle: conta uma vez.
		b := raw(IDPermsChanged, ev.Time.Sub(t0)+time.Millisecond, ev.Path, "", ev.HandleID)
		b.Process, b.ProcessID = ev.Process, ev.ProcessID
		b.Kind, b.Actions = "permissions_changed", []string{"permission_change"}
		r.add(ev, b)
	}
	ev := one(t, r.flush())
	if ev.Action != ActionPermissionChanged || ev.Count != 25 || ev.Path != `D:\Dados\Fin` ||
		strings.Count(ev.Details["sample"], "\n") != maxBulkSample-1 {
		t.Errorf("permissão em massa: %+v", ev)
	}

	// icacls /T numa pasta com 12 arquivos, como no Windows 11: a DACL da
	// pasta é regravada nos filhos (herança) e depois o /T passa em cada um.
	r = newRun(t, nil)
	n := 0
	perm := func(path string) {
		n++
		a := raw(IDObjectAccess, time.Duration(n)*10*time.Millisecond, path, "0x40000", fmt.Sprintf("0x%x", 0x900+n))
		b := raw(IDPermsChanged, time.Duration(n)*10*time.Millisecond+time.Millisecond, path, "", a.HandleID)
		b.Kind, b.Actions = "permissions_changed", []string{"permission_change"}
		for _, e := range []*Event{&a, &b} {
			e.Process, e.ProcessID = `C:\Windows\System32\icacls.exe`, "0x300"
		}
		r.add(a, b)
	}
	perm(`C:\T\Lote`)
	for i := 1; i <= 12; i++ {
		perm(fmt.Sprintf(`C:\T\Lote\arq%d.txt`, i))
	}
	for i := 1; i <= 12; i++ {
		perm(fmt.Sprintf(`C:\T\Lote\arq%d.txt`, i))
	}
	if ev := one(t, r.flush()); ev.Count != 13 || ev.Path != `C:\T\Lote` {
		t.Errorf("icacls /T: %+v", ev)
	}

	// Poucos itens: cada um à parte, com o SDDL do 4670 do mesmo handle.
	r = newRun(t, nil)
	for i := range 3 {
		a := raw(IDObjectAccess, time.Duration(i)*time.Second, fmt.Sprintf(`D:\Dados\%d.txt`, i), "0x40000", fmt.Sprintf("0x%x", 0x600+i))
		b := raw(IDPermsChanged, time.Duration(i)*time.Second+time.Millisecond, a.Path, "", a.HandleID)
		b.Kind, b.Actions, b.Details = "permissions_changed", []string{"permission_change"}, map[string]string{"old_sd": "D:A", "new_sd": "D:AI"}
		r.add(a, b)
	}
	out := r.flush()
	if len(out) != 3 {
		t.Fatalf("esperava 3 eventos, veio %d", len(out))
	}
	for _, ev := range out {
		if ev.Action != ActionPermissionChanged || ev.Details["new_sd"] != "D:AI" || len(ev.RelatedRecords) != 1 {
			t.Errorf("item de permissão: %+v", ev)
		}
	}
}

func TestDeniedAndClientIP(t *testing.T) {
	r := newRun(t, nil)
	r.add(decode(t, "5140.xml"))
	ev := one(t, r.add(decode(t, "4656_denied.xml")).flush())
	if ev.Action != ActionDenied {
		t.Errorf("negado: %+v", ev)
	}
	r = newRun(t, nil)
	ev = one(t, r.add(decode(t, "5140.xml"), decode(t, "4663_write.xml")).flush())
	if ev.ClientIP != "10.0.0.25" {
		t.Errorf("IP da sessão SMB não aplicado: %+v", ev)
	}
}

func TestIgnoresOwnProcessAndNoise(t *testing.T) {
	c := NewCorrelator(CorrelationConfig{IgnoreProcessID: "0x100"}, Filter{}, nil)
	out := append(c.Add(raw(IDObjectAccess, 0, `D:\Dados\a`, "0x2", "0x1")), c.Flush()...)
	if len(out) != 0 {
		t.Errorf("evento do próprio agente: %+v", out)
	}
	c = NewCorrelator(CorrelationConfig{}, Filter{}, nil)
	out = append(c.Add(raw(IDObjectAccess, 0, `D:\Dados`, "0x20", "0x1")), c.Flush()...)
	if len(out) != 0 {
		t.Errorf("travessia deveria ser ignorada: %+v", out)
	}
}

func TestTickReleasesPendingAfterWindow(t *testing.T) {
	c := NewCorrelator(CorrelationConfig{}, Filter{}, nil)
	if out := c.Add(raw(IDObjectAccess, 0, `D:\Dados\a.docx`, "0x10000", "0x20")); len(out) != 0 {
		t.Fatal("deveria esperar")
	}
	if out := c.Tick(t0.Add(time.Second)); len(out) != 0 {
		t.Fatal("ainda dentro da janela")
	}
	if out := c.Tick(t0.Add(4 * time.Second)); len(out) != 1 || c.Pending() != 0 {
		t.Fatalf("depois da janela: %+v, pendentes %d", out, c.Pending())
	}
}

func TestHandleCacheEviction(t *testing.T) {
	c := NewCorrelator(CorrelationConfig{MaxHandles: 2}, Filter{}, nil)
	for _, k := range []string{"a", "b", "c"} {
		c.rememberHandle(k, k)
	}
	if _, ok := c.st.handles["a"]; ok || len(c.st.handles) != 2 || len(c.st.Handles) != 2 {
		t.Errorf("cache não respeitou o limite: %v", c.st.handles)
	}
}

func TestCommonDir(t *testing.T) {
	cases := [][3]string{
		{`D:\a\b\c.txt`, `D:\a\b\d.txt`, `D:\a\b`},
		{`D:\a\b`, `D:\a\b\d.txt`, `D:\a\b`},
		{`D:\x.txt`, `D:\y.txt`, `D:\`},
		{`D:\A\b.txt`, `d:\a\c.txt`, `D:\A`},
	}
	for _, c := range cases {
		if got := commonDir(c[0], c[1]); got != c[2] {
			t.Errorf("commonDir(%s, %s) = %s, esperado %s", c[0], c[1], got, c[2])
		}
	}
}

// Cópia pelo Explorer: o arquivo, o fluxo Zone.Identifier e a DACL ajustada
// logo depois viram um único "criou".
func TestExplorerCopyIsOneCreated(t *testing.T) {
	fs := newFS()
	fs.addDir(`C:\Dados`)
	fs.addEntry(`C:\Dados`, "qrcode.png", false, t0, t0.Add(time.Second), t0.Add(time.Second))
	out := newRun(t, fs).add(
		raw(IDObjectAccess, 0, `C:\Dados`, "0x2", "0x10"),
		raw(IDObjectAccess, 50*time.Millisecond, `C:\Dados\qrcode.png`, "0x6", "0x11"),
		raw(IDObjectAccess, 200*time.Millisecond, `C:\Dados\qrcode.png`, "0x2", "0x12"),
		raw(IDObjectAccess, 400*time.Millisecond, `C:\Dados\qrcode.png`, "0x40000", "0x13"),
	).flush()
	ev := one(t, out)
	if ev.Action != ActionCreated || ev.Details["permissions_set_on_create"] != "true" {
		t.Errorf("cópia: %+v", ev)
	}
}

// Sequência vista num Windows 11: o Explorer define a DACL do arquivo novo
// antes de escrever nele.
func TestExplorerCopyPermsFirst(t *testing.T) {
	fs := newFS()
	fs.addDir(`C:\Dados`)
	fs.addEntry(`C:\Dados`, "setup.exe", false, t0, t0.Add(-48*time.Hour), t0)
	out := newRun(t, fs).add(
		raw(IDObjectAccess, 0, `C:\Dados\setup.exe`, "0x40000", "0x20"),
		raw(IDObjectAccess, 100*time.Millisecond, `C:\Dados\setup.exe`, "0x2", "0x21"),
		raw(IDObjectAccess, 120*time.Millisecond, `C:\Dados\setup.exe`, "0x4", "0x21"),
		raw(IDObjectAccess, 150*time.Millisecond, `C:\Dados\setup.exe:Zone.Identifier`, "0x2", "0x22"),
		raw(IDObjectAccess, 200*time.Millisecond, `C:\Dados\setup.exe`, "0x100", "0x21"),
	).flush()
	ev := one(t, out)
	if ev.Action != ActionCreated || ev.Details["permissions_set_on_create"] != "true" || ev.ItemType != "file" {
		t.Errorf("cópia: %+v", ev)
	}
}

func TestSplitStream(t *testing.T) {
	cases := [][3]string{
		{`C:\a\b.txt`, `C:\a\b.txt`, ""},
		{`C:\a\b.txt:Zone.Identifier`, `C:\a\b.txt`, "Zone.Identifier"},
		{`C:\a\b.txt:x:$DATA`, `C:\a\b.txt`, "x"},
		{`C:\`, `C:\`, ""},
		{`\\srv\share\a.txt`, `\\srv\share\a.txt`, ""},
	}
	for _, c := range cases {
		if p, s := splitStream(c[0]); p != c[1] || s != c[2] {
			t.Errorf("splitStream(%s) = %q %q", c[0], p, s)
		}
	}
}
