// Package fsinfo consulta o sistema de arquivos local para o correlacionador
// de eventos (event.FS): horários do NTFS, conteúdo de pastas e Lixeira.
package fsinfo

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// Local implementa event.FS no sistema de arquivos da máquina.
type Local struct {
	// RecycleRoot devolve a pasta da Lixeira do volume de path para o SID
	// (ex.: D:\$Recycle.Bin\S-1-5-21-...). Substituível nos testes.
	RecycleRoot func(path, sid string) string
}

// New cria um Local com a Lixeira padrão do Windows.
func New() *Local { return &Local{RecycleRoot: recycleRoot} }

var _ event.FS = (*Local)(nil)

func recycleRoot(path, sid string) string {
	vol := filepath.VolumeName(path)
	if vol == "" || sid == "" {
		return ""
	}
	return vol + `\$Recycle.Bin\` + sid
}

// RecycleBinFind lê os arquivos $I da Lixeira do usuário, que guardam o
// caminho original de cada item excluído, e devolve o $R correspondente.
func (l *Local) RecycleBinFind(path, sid string, since time.Time) (string, bool) {
	root := l.RecycleRoot(path, sid)
	if root == "" {
		return "", false
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		name := e.Name()
		if len(name) < 3 || !strings.EqualFold(name[:2], "$I") {
			continue
		}
		if fi, err := e.Info(); err != nil || fi.ModTime().Before(since) {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			continue
		}
		orig, deleted, err := ParseRecycleInfo(b)
		if err != nil || deleted.Before(since) || !strings.EqualFold(orig, path) {
			continue
		}
		return root + `\$R` + name[2:], true
	}
	return "", false
}

// ParseRecycleInfo decodifica um arquivo $I da Lixeira (versão 1, Vista a
// 8.1, e versão 2, Windows 10 em diante): caminho original e horário da exclusão.
func ParseRecycleInfo(b []byte) (path string, deleted time.Time, err error) {
	if len(b) < 24 {
		return "", time.Time{}, errors.New("$I curto demais")
	}
	version := binary.LittleEndian.Uint64(b[0:8])
	deleted = filetime(binary.LittleEndian.Uint64(b[16:24]))
	var name []byte
	switch version {
	case 1:
		name = b[24:]
	case 2:
		if len(b) < 28 {
			return "", time.Time{}, errors.New("$I v2 curto demais")
		}
		n := int(binary.LittleEndian.Uint32(b[24:28])) * 2
		if n > len(b)-28 {
			return "", time.Time{}, errors.New("$I v2 com tamanho inválido")
		}
		name = b[28 : 28+n]
	default:
		return "", time.Time{}, errors.New("versão de $I desconhecida")
	}
	u := make([]uint16, 0, len(name)/2)
	for i := 0; i+1 < len(name); i += 2 {
		c := binary.LittleEndian.Uint16(name[i:])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u)), deleted, nil
}

// filetime converte um FILETIME (intervalos de 100 ns desde 1601) para time.Time.
func filetime(ft uint64) time.Time {
	const epochDiff = 116444736000000000 // 1601-01-01 até 1970-01-01, em 100 ns
	if ft < epochDiff {
		return time.Time{}
	}
	return time.Unix(0, int64(ft-epochDiff)*100).UTC()
}
