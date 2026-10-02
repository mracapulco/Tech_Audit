package fsinfo

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unicode/utf16"
)

// recycleInfo monta um $I como o Windows grava.
func recycleInfo(version uint64, path string, deleted time.Time) []byte {
	name := utf16.Encode([]rune(path + "\x00"))
	b := binary.LittleEndian.AppendUint64(nil, version)
	b = binary.LittleEndian.AppendUint64(b, 12345) // tamanho do arquivo
	b = binary.LittleEndian.AppendUint64(b, uint64(deleted.UnixNano()/100)+116444736000000000)
	if version == 2 {
		b = binary.LittleEndian.AppendUint32(b, uint32(len(name)))
	}
	for _, c := range name {
		b = binary.LittleEndian.AppendUint16(b, c)
	}
	if version == 1 {
		b = append(b, make([]byte, 520-2*len(name))...)
	}
	return b
}

func TestParseRecycleInfo(t *testing.T) {
	when := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	for _, v := range []uint64{1, 2} {
		p, d, err := ParseRecycleInfo(recycleInfo(v, `D:\Dados\Relatório.docx`, when))
		if err != nil || p != `D:\Dados\Relatório.docx` || !d.Equal(when) {
			t.Errorf("v%d: %q %v %v", v, p, d, err)
		}
	}
	if _, _, err := ParseRecycleInfo([]byte{1, 2, 3}); err == nil {
		t.Error("esperava erro em $I curto")
	}
}

func TestRecycleBinFind(t *testing.T) {
	root := t.TempDir()
	l := &Local{RecycleRoot: func(string, string) string { return root }}
	now := time.Now().UTC()
	os.WriteFile(filepath.Join(root, "$IAAAAAA.txt"), recycleInfo(2, `D:\Dados\outro.txt`, now), 0o600)
	os.WriteFile(filepath.Join(root, "$IB1C2D3.docx"), recycleInfo(2, `D:\Dados\a.docx`, now), 0o600)

	got, ok := l.RecycleBinFind(`d:\dados\A.docx`, "S-1", now.Add(-time.Minute))
	if !ok || got != root+`\$RB1C2D3.docx` {
		t.Errorf("got %q %v", got, ok)
	}
	if _, ok := l.RecycleBinFind(`D:\Dados\a.docx`, "S-1", now.Add(time.Minute)); ok {
		t.Error("exclusão anterior a since não deveria contar")
	}
	if _, ok := l.RecycleBinFind(`D:\Dados\nada.docx`, "S-1", now.Add(-time.Minute)); ok {
		t.Error("caminho inexistente na Lixeira")
	}
}
