//go:build linux

package source

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"

	"github.com/mracapulco/Tech_Audit/agent/internal/auditd"
	"github.com/mracapulco/Tech_Audit/agent/internal/event"
	"github.com/mracapulco/Tech_Audit/agent/internal/samba"
)

// LinuxOptions configura o coletor do Linux.
type LinuxOptions struct {
	// AuditLog é o log do auditd; vazio = log_file do /etc/audit/auditd.conf.
	AuditLog string
	// Bookmark é o que Bookmark devolveu antes (posição no audit.log e cursor do journald).
	Bookmark string
	// StartFrom sem bookmark: "now" (padrão) ou "oldest".
	StartFrom string
	Hostname  string
	// Scope diz se um caminho está entre os auditados (e, para read, com
	// leitura auditada). Nil aceita tudo.
	Scope func(path string, read bool) bool
	// Roots devolve as pastas auditadas, para o mapa de pastas do auditd;
	// known=false enquanto o portal não respondeu.
	Roots func() (roots []string, known bool)
	// NoSamba desliga a leitura do full_audit (sem Samba instalado).
	NoSamba bool
	Logf    func(format string, args ...any)
}

type linuxBookmark struct {
	Auditd *auditd.Position `json:"auditd,omitempty"`
	Samba  string           `json:"samba,omitempty"`
}

// Linux lê o audit.log (acesso direto ao servidor) e o full_audit do Samba
// pelo journald (acesso pela rede). Entrega eventos já com a ação definida,
// codificados em JSON (DecodeJSON).
type Linux struct {
	opts    LinuxOptions
	tail    *auditd.Tail
	asm     *auditd.Assembler
	conv    *auditd.Converter
	dirs    *auditd.DirMap
	journal *samba.Journal
	parser  *samba.Parser

	auditPos *auditd.Position
	lastLine time.Time
	opened   time.Time
	// scanned fecha quando o primeiro mapa de pastas fica pronto: até lá o
	// audit.log espera (sem o mapa, rm -r e outros caminhos relativos a uma
	// pasta aberta não teriam o caminho completo).
	scanned chan struct{}

	stop   chan struct{}
	rescan chan struct{}
	wg     sync.WaitGroup
}

// OpenLinux abre as duas fontes. Sem auditd (log inexistente) segue só com
// o Samba, e vice-versa; sem nenhuma, devolve erro.
func OpenLinux(o LinuxOptions) (*Linux, error) {
	if o.Logf == nil {
		o.Logf = func(string, ...any) {}
	}
	var bm linuxBookmark
	if o.Bookmark != "" {
		if err := json.Unmarshal([]byte(o.Bookmark), &bm); err != nil {
			o.Logf("aviso: posição salva ilegível (%v); começando do momento atual", err)
		}
	}
	fromStart := o.StartFrom == "oldest"
	l := &Linux{opts: o, stop: make(chan struct{}), rescan: make(chan struct{}, 1), lastLine: time.Now(), opened: time.Now(), scanned: make(chan struct{})}
	l.dirs = &auditd.DirMap{Stat: auditd.LocalStat}

	logPath := o.AuditLog
	if logPath == "" {
		logPath = auditd.LogFile("/etc/audit/auditd.conf")
	}
	var errs []string
	tail, err := auditd.OpenTail(logPath, bm.Auditd, fromStart, o.Logf)
	if err != nil {
		errs = append(errs, "auditd: "+err.Error())
		o.Logf("auditd indisponível (%v): acesso direto ao servidor não será auditado", err)
	} else {
		l.tail = tail
		l.asm = &auditd.Assembler{Keys: map[string]bool{auditd.KeyWrite: true, auditd.KeyRead: true}}
		users := newUserCache()
		l.conv = &auditd.Converter{
			Hostname: o.Hostname, Dirs: l.dirs, UserName: users.name,
			MissingDir: func() {
				select {
				case l.rescan <- struct{}{}:
				default:
				}
			},
		}
		l.wg.Add(1)
		go l.scanLoop()
	}
	if !o.NoSamba {
		j, err := samba.OpenJournal(bm.Samba, fromStart, o.Logf)
		if err != nil {
			errs = append(errs, "Samba: "+err.Error())
			o.Logf("leitura da auditoria do Samba indisponível: %v", err)
		} else {
			l.journal = j
			l.parser = &samba.Parser{Hostname: o.Hostname, Born: birthTime, Exists: exists}
		}
	}
	if l.tail == nil && l.journal == nil {
		return nil, errors.New("nenhuma fonte de auditoria disponível (" + strings.Join(errs, "; ") + ")")
	}
	return l, nil
}

// Next devolve até max eventos (JSON), esperando no máximo wait.
func (l *Linux) Next(ctx context.Context, limit int, wait time.Duration) ([][]byte, error) {
	deadline := time.Now().Add(wait)
	var out [][]byte
	for {
		n, err := l.readAudit(&out, limit)
		if err != nil {
			return out, err
		}
		if l.journal != nil && len(out) < limit {
			step := time.Duration(0)
			if len(out) == 0 && n == 0 {
				step = min(200*time.Millisecond, time.Until(deadline))
			}
			for _, ev := range l.parser.ParseBatch(l.journal.Next(limit-len(out), max(step, time.Millisecond))) {
				if l.inScope(ev) {
					out = appendJSON(out, ev)
				}
			}
		} else if len(out) == 0 && n == 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(min(200*time.Millisecond, time.Until(deadline))):
			}
		}
		if len(out) > 0 || n > 0 || !time.Now().Before(deadline) || ctx.Err() != nil {
			return out, ctx.Err()
		}
	}
}

// readAudit lê as linhas disponíveis do audit.log (até max eventos) e
// devolve quantas linhas leu.
func (l *Linux) readAudit(out *[][]byte, limit int) (int, error) {
	if l.tail == nil {
		return 0, nil
	}
	select {
	case <-l.scanned:
	default:
		if time.Since(l.opened) < time.Minute {
			return 0, nil // portal ainda não respondeu: espera até 1 min pelo mapa
		}
	}
	lines := 0
	emit := func(groups []*auditd.Group) {
		for _, g := range groups {
			if ev, ok := l.conv.Convert(g); ok && l.inScope(ev) {
				*out = appendJSON(*out, ev)
			}
		}
	}
	for len(*out) < limit && lines < 20000 {
		line, off, switched, err := l.tail.ReadLine()
		if switched {
			emit(l.asm.Flush())
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return lines, err
		}
		lines++
		l.lastLine = time.Now()
		r, err := auditd.ParseRecord(line)
		if err != nil {
			continue
		}
		emit(l.asm.Add(r, off))
	}
	// Sem linhas novas há um tempo: grupos sem EOE não vão se completar.
	if lines == 0 && time.Since(l.lastLine) > time.Second {
		emit(l.asm.Flush())
	}
	off := l.tail.Offset()
	if m, ok := l.asm.MinOffset(); ok {
		off = m
	}
	pos := l.tail.Position(off)
	l.auditPos = &pos
	return lines, nil
}

func (l *Linux) inScope(ev event.Event) bool {
	if l.opts.Scope == nil {
		return true
	}
	read := ev.Action == event.ActionRead
	return l.opts.Scope(ev.Path, read) || (ev.NewPath != "" && l.opts.Scope(ev.NewPath, read))
}

func appendJSON(out [][]byte, ev event.Event) [][]byte {
	b, err := json.Marshal(ev)
	if err != nil {
		return out
	}
	return append(out, b)
}

// Bookmark junta a posição do audit.log e o cursor do journald.
func (l *Linux) Bookmark() (string, error) {
	bm := linuxBookmark{Auditd: l.auditPos}
	if l.journal != nil {
		bm.Samba = l.journal.Cursor()
	}
	b, err := json.Marshal(bm)
	return string(b), err
}

func (l *Linux) Close() error {
	close(l.stop)
	l.wg.Wait()
	if l.journal != nil {
		l.journal.Close()
	}
	if l.tail != nil {
		return l.tail.Close()
	}
	return nil
}

// scanLoop monta o mapa de pastas das raízes auditadas: quando a lista de
// pastas muda, quando falta uma pasta (no máximo a cada 2 min) e a cada 6 h.
func (l *Linux) scanLoop() {
	defer l.wg.Done()
	var last []string
	var lastScan time.Time
	first := true
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		roots, known := []string(nil), false
		if l.opts.Roots != nil {
			roots, known = l.opts.Roots()
		}
		missing := false
		select {
		case <-l.rescan:
			missing = true
		default:
		}
		due := known && (!equalStrings(roots, last) || time.Since(lastScan) > 6*time.Hour ||
			(missing && time.Since(lastScan) > 2*time.Minute))
		if due {
			start := time.Now()
			_ = l.dirs.Scan(roots, func() bool {
				select {
				case <-l.stop:
					return true
				default:
					return false
				}
			})
			last, lastScan = roots, time.Now()
			l.opts.Logf("mapa de pastas do auditd: %d pastas em %s", l.dirs.Size(), time.Since(start).Round(time.Millisecond))
			if first {
				first = false
				close(l.scanned)
				tick.Reset(30 * time.Second)
			}
		}
		select {
		case <-l.stop:
			return
		case <-tick.C:
		case <-l.rescan:
			select { // devolve o pedido para a próxima volta
			case l.rescan <- struct{}{}:
			default:
			}
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// DecodeJSON é o Decode do pipeline para os eventos do coletor do Linux.
func DecodeJSON(raw []byte) (event.Event, bool, error) {
	var ev event.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		return ev, false, err
	}
	return ev, true, nil
}

// birthTime lê a data de criação (statx); ext4 e xfs informam.
func birthTime(path string) (time.Time, bool) {
	var st unix.Statx_t
	if err := unix.Statx(unix.AT_FDCWD, path, unix.AT_SYMLINK_NOFOLLOW, unix.STATX_BTIME, &st); err != nil {
		return time.Time{}, false
	}
	if st.Mask&unix.STATX_BTIME == 0 {
		return time.Time{}, false
	}
	return time.Unix(st.Btime.Sec, int64(st.Btime.Nsec)), true
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// userCache guarda as traduções uid -> nome (getent é um processo por consulta).
type userCache struct {
	mu    sync.Mutex
	names map[uint64]userEntry
}

type userEntry struct {
	name string
	at   time.Time
}

func newUserCache() *userCache { return &userCache{names: map[uint64]userEntry{}} }

func (c *userCache) name(uid uint64) string {
	c.mu.Lock()
	e, ok := c.names[uid]
	c.mu.Unlock()
	if ok && time.Since(e.at) < time.Hour {
		return e.name
	}
	n := auditd.LookupUser(uid)
	c.mu.Lock()
	if len(c.names) > 10000 {
		c.names = map[uint64]userEntry{}
	}
	c.names[uid] = userEntry{name: n, at: time.Now()}
	c.mu.Unlock()
	return n
}
