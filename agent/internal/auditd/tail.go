package auditd

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// Position é onde a leitura parou: inode do arquivo e posição nele. Pelo
// inode o arquivo é encontrado mesmo depois de o auditd rotacioná-lo
// (audit.log vira audit.log.1).
type Position struct {
	Ino    uint64 `json:"ino"`
	Offset int64  `json:"off"`
}

// Tail lê o audit.log linha a linha, acompanhando a rotação.
type Tail struct {
	Path string
	// Warn recebe avisos (eventos possivelmente perdidos na rotação).
	Warn func(format string, args ...any)

	f       *os.File
	r       *bufio.Reader
	ino     uint64
	off     int64 // início da próxima linha a devolver
	partial []byte
	queue   []string // arquivos rotacionados a ler antes do atual, do mais antigo ao mais novo
	cur     string
}

const maxRotated = 99

// OpenTail abre o log. Com pos, continua de onde parou (procurando o
// arquivo também entre os rotacionados); sem pos, começa no fim (fromStart
// false) ou no início dos arquivos existentes.
func OpenTail(path string, pos *Position, fromStart bool, warn func(string, ...any)) (*Tail, error) {
	if warn == nil {
		warn = func(string, ...any) {}
	}
	t := &Tail{Path: path, Warn: warn}
	files := []string{path}
	for i := 1; i <= maxRotated; i++ {
		p := path + "." + strconv.Itoa(i)
		if _, err := os.Stat(p); err != nil {
			break
		}
		files = append(files, p)
	}
	if pos != nil {
		for i, p := range files {
			fi, err := os.Stat(p)
			if err != nil || fileIno(fi) != pos.Ino {
				continue
			}
			// files[i] é o arquivo do bookmark; os mais novos vêm antes dele na lista.
			for j := i - 1; j >= 1; j-- {
				t.queue = append(t.queue, files[j])
			}
			if err := t.open(p, pos.Offset); err != nil {
				return nil, err
			}
			return t, nil
		}
		if len(files) > 1 {
			warn("posição salva do audit.log não encontrada (log rotacionado enquanto o agente estava parado); lendo desde %s", files[len(files)-1])
		} else {
			warn("posição salva do audit.log não encontrada; lendo desde o início de %s", path)
		}
		fromStart = true
	}
	if !fromStart {
		fi, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		return t, t.open(path, fi.Size())
	}
	for j := len(files) - 1; j >= 1; j-- {
		t.queue = append(t.queue, files[j])
	}
	if len(t.queue) > 0 {
		first := t.queue[0]
		t.queue = t.queue[1:]
		return t, t.open(first, 0)
	}
	return t, t.open(path, 0)
}

func (t *Tail) open(path string, off int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	if off > fi.Size() {
		off = 0 // arquivo menor que a posição: foi recriado
	}
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		f.Close()
		return err
	}
	if t.f != nil {
		t.f.Close()
	}
	t.f, t.r, t.ino, t.off, t.partial, t.cur = f, bufio.NewReaderSize(f, 256<<10), fileIno(fi), off, nil, path
	return nil
}

// ReadLine devolve a próxima linha completa e a posição em que ela começa.
// io.EOF significa que não há linha nova por enquanto. switched indica que
// a leitura passou para outro arquivo (os grupos pendentes do anterior
// devem ser encerrados).
func (t *Tail) ReadLine() (line string, off int64, switched bool, err error) {
	for {
		b, err := t.r.ReadSlice('\n')
		if err == nil || (errors.Is(err, bufio.ErrBufferFull)) {
			if errors.Is(err, bufio.ErrBufferFull) {
				// Linha maior que o buffer: junta as partes.
				t.partial = append(t.partial, b...)
				continue
			}
			start := t.off
			full := b
			if len(t.partial) > 0 {
				full = append(t.partial, b...)
				t.partial = nil
			}
			t.off += int64(len(full))
			return string(bytes.TrimRight(full, "\r\n")), start, switched, nil
		}
		if !errors.Is(err, io.EOF) {
			return "", 0, switched, err
		}
		// Fim do arquivo: guarda a linha incompleta para a próxima leitura.
		if len(b) > 0 {
			t.partial = append(t.partial, b...)
		}
		next, err := t.nextFile()
		if err != nil {
			return "", 0, switched, err
		}
		if !next {
			return "", 0, switched, io.EOF
		}
		switched = true
	}
}

// nextFile passa para o próximo arquivo quando o atual acabou de vez:
// rotacionado (arquivo da fila ou o audit.log trocado) ou truncado.
func (t *Tail) nextFile() (bool, error) {
	if len(t.queue) > 0 {
		next := t.queue[0]
		t.queue = t.queue[1:]
		return true, t.open(next, 0)
	}
	if t.cur != t.Path {
		return true, t.open(t.Path, 0)
	}
	fi, err := os.Stat(t.Path)
	if err != nil {
		return false, nil // no meio da rotação; tenta de novo depois
	}
	if fileIno(fi) != t.ino {
		// O auditd rotacionou: o arquivo aberto já foi lido até o fim.
		if len(t.partial) > 0 {
			t.Warn("linha incompleta no fim do audit.log rotacionado descartada")
		}
		return true, t.open(t.Path, 0)
	}
	if fi.Size() < t.off+int64(len(t.partial)) {
		t.Warn("audit.log diminuiu (truncado?); lendo desde o início")
		return true, t.open(t.Path, 0)
	}
	return false, nil
}

// Position devolve o bookmark para uma posição off do arquivo atual.
func (t *Tail) Position(off int64) Position { return Position{Ino: t.ino, Offset: off} }

// Offset é a posição após a última linha devolvida.
func (t *Tail) Offset() int64 { return t.off }

func (t *Tail) Close() error {
	if t.f == nil {
		return nil
	}
	return t.f.Close()
}

func (t *Tail) String() string { return fmt.Sprintf("%s@%d", t.cur, t.off) }

// LogFile lê o log_file do auditd.conf (padrão /var/log/audit/audit.log).
func LogFile(conf string) string {
	const def = "/var/log/audit/audit.log"
	b, err := os.ReadFile(conf)
	if err != nil {
		return def
	}
	for _, l := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(l, "=")
		if ok && strings.TrimSpace(k) == "log_file" && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return def
}
