package samba

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"strconv"
	"sync"
	"time"
)

// Identifier é o identificador do syslog usado pelo full_audit.
const Identifier = "smbd_audit"

// Journal acompanha as linhas do full_audit no journald com
// "journalctl -f -o json", recomeçando do último cursor se o comando parar.
type Journal struct {
	Logf func(format string, args ...any)

	ctx    context.Context
	cancel context.CancelFunc
	msgs   chan Message
	done   chan struct{}

	mu       sync.Mutex
	read     string // cursor da última linha lida do journalctl
	returned string // cursor da última linha entregue por Next
	err      error
}

// OpenJournal começa após cursor; sem cursor, do momento atual
// (fromStart=false) ou de tudo o que o journald ainda guarda.
func OpenJournal(cursor string, fromStart bool, logf func(string, ...any)) (*Journal, error) {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return nil, errors.New("journalctl não encontrado (o agente precisa do systemd/journald para ler a auditoria do Samba)")
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	j := &Journal{Logf: logf, ctx: ctx, cancel: cancel, msgs: make(chan Message, 10000), done: make(chan struct{}), read: cursor, returned: cursor}
	go j.loop(fromStart)
	return j, nil
}

func (j *Journal) loop(fromStart bool) {
	defer close(j.done)
	failing := false
	for {
		j.mu.Lock()
		cursor := j.read
		j.mu.Unlock()
		args := []string{"-f", "-o", "json", "--no-pager", "-q", "-t", Identifier}
		switch {
		case cursor != "":
			args = append(args, "--after-cursor", cursor)
		case fromStart:
			args = append(args, "-n", "all")
		default:
			args = append(args, "-n", "0")
		}
		err := j.run(args)
		if j.ctx.Err() != nil {
			return
		}
		if !failing {
			j.Logf("leitura do journald (auditoria do Samba) parou: %v; nova tentativa em 10s", err)
			failing = true
		}
		select {
		case <-j.ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

func (j *Journal) run(args []string) error {
	cmd := exec.CommandContext(j.ctx, "journalctl", args...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		m, ok := parseJournalLine(sc.Bytes())
		if !ok {
			continue
		}
		select {
		case j.msgs <- m:
		case <-j.ctx.Done():
			_ = cmd.Wait()
			return j.ctx.Err()
		}
		j.mu.Lock()
		j.read = m.Cursor
		j.mu.Unlock()
	}
	scanErr := sc.Err()
	if scanErr != nil {
		_, _ = io.Copy(io.Discard, out)
	}
	err = cmd.Wait()
	if scanErr != nil {
		return scanErr
	}
	if err == nil {
		err = errors.New("journalctl terminou")
	}
	return err
}

// parseJournalLine lê uma linha do "journalctl -o json". MESSAGE vem como
// lista de bytes quando não é UTF-8 válido.
func parseJournalLine(b []byte) (Message, bool) {
	var raw struct {
		Cursor   string          `json:"__CURSOR"`
		Realtime string          `json:"__REALTIME_TIMESTAMP"`
		PID      string          `json:"_PID"`
		Message  json.RawMessage `json:"MESSAGE"`
	}
	if err := json.Unmarshal(b, &raw); err != nil || raw.Cursor == "" {
		return Message{}, false
	}
	m := Message{Cursor: raw.Cursor, PID: raw.PID}
	if us, err := strconv.ParseInt(raw.Realtime, 10, 64); err == nil {
		m.Time = time.UnixMicro(us).UTC()
	}
	var s string
	if err := json.Unmarshal(raw.Message, &s); err == nil {
		m.Text = s
	} else {
		var bs []byte
		var ints []int
		if err := json.Unmarshal(raw.Message, &ints); err != nil {
			return Message{}, false
		}
		for _, v := range ints {
			bs = append(bs, byte(v))
		}
		m.Text = string(bs)
	}
	return m, true
}

// Next devolve até max linhas, esperando no máximo wait.
func (j *Journal) Next(max int, wait time.Duration) []Message {
	var out []Message
	timer := time.NewTimer(wait)
	defer timer.Stop()
	// Espera a primeira linha; depois pega as que já estiverem na fila.
	select {
	case m := <-j.msgs:
		out = append(out, m)
	case <-timer.C:
		return nil
	}
drain:
	for len(out) < max {
		select {
		case m := <-j.msgs:
			out = append(out, m)
		default:
			break drain
		}
	}
	if len(out) > 0 {
		j.mu.Lock()
		j.returned = out[len(out)-1].Cursor
		j.mu.Unlock()
	}
	return out
}

// Cursor é a posição após a última linha entregue por Next.
func (j *Journal) Cursor() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.returned
}

func (j *Journal) Close() {
	j.cancel()
	<-j.done
}
