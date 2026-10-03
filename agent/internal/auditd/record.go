// Package auditd lê o log do auditd (/var/log/audit/audit.log), o registro
// de auditoria do kernel Linux, e transforma as chamadas de sistema nas
// pastas auditadas em ações (criou, alterou, excluiu, renomeou...).
//
// Cobre o acesso direto ao servidor (SSH, console, sudo, tarefas agendadas
// de usuários). O acesso pela rede via Samba vem do módulo full_audit do
// Samba (pacote samba), que informa também o IP do computador.
package auditd

import (
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Record é uma linha do audit.log, como
//
//	type=PATH msg=audit(1791052098.520:6): item=1 name="rel.txt" inode=8175619 ...
//
// Com log_format = ENRICHED, o auditd acrescenta após o caractere 0x1d os
// valores traduzidos (UID="alice", SYSCALL=openat), guardados em Enriched.
type Record struct {
	Type     string
	Time     time.Time
	Serial   uint64
	Fields   map[string]string
	Enriched map[string]string
}

// EventKey identifica o evento do kernel ao qual o registro pertence: todos
// os registros de uma chamada (SYSCALL, CWD, PATH, PROCTITLE, EOE) têm o
// mesmo horário e número de série.
func (r *Record) EventKey() string {
	return fmt.Sprintf("%d.%03d:%d", r.Time.Unix(), r.Time.Nanosecond()/1e6, r.Serial)
}

// ParseRecord interpreta uma linha. Valores entre aspas perdem as aspas;
// os demais ficam como estão (hexadecimal é decodificado por Text).
func ParseRecord(line string) (*Record, error) {
	line = strings.TrimRight(line, "\r\n")
	enriched := ""
	if i := strings.IndexByte(line, 0x1d); i >= 0 {
		line, enriched = line[:i], line[i+1:]
	}
	if !strings.HasPrefix(line, "type=") {
		return nil, fmt.Errorf("linha sem type=")
	}
	sp := strings.IndexByte(line, ' ')
	if sp < 0 {
		return nil, fmt.Errorf("linha incompleta")
	}
	r := &Record{Type: line[5:sp]}
	rest := line[sp+1:]
	const pre = "msg=audit("
	if !strings.HasPrefix(rest, pre) {
		return nil, fmt.Errorf("linha sem msg=audit(")
	}
	end := strings.Index(rest, "):")
	if end < 0 {
		return nil, fmt.Errorf("msg=audit( sem fechamento")
	}
	stamp := rest[len(pre):end]
	colon := strings.IndexByte(stamp, ':')
	if colon < 0 {
		return nil, fmt.Errorf("horário inválido %q", stamp)
	}
	whole, frac, _ := strings.Cut(stamp[:colon], ".")
	sec, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("horário inválido %q", stamp)
	}
	ms, err := strconv.Atoi((frac + "000")[:3])
	if err != nil {
		return nil, fmt.Errorf("horário inválido %q", stamp)
	}
	r.Time = time.Unix(sec, int64(ms)*int64(time.Millisecond)).UTC()
	if r.Serial, err = strconv.ParseUint(stamp[colon+1:], 10, 64); err != nil {
		return nil, fmt.Errorf("número de série inválido %q", stamp)
	}
	r.Fields = parseFields(rest[end+2:])
	if enriched != "" {
		r.Enriched = parseFields(enriched)
	}
	return r, nil
}

// parseFields separa chave=valor. Valores com espaço vêm entre aspas (o
// auditd codifica em hexadecimal os que têm aspas ou caracteres especiais).
func parseFields(s string) map[string]string {
	out := map[string]string{}
	for {
		s = strings.TrimLeft(s, " ")
		if s == "" {
			return out
		}
		eq := strings.IndexByte(s, '=')
		if eq < 0 {
			return out
		}
		k := s[:eq]
		s = s[eq+1:]
		var v string
		switch {
		case strings.HasPrefix(s, `"`):
			if end := strings.IndexByte(s[1:], '"'); end >= 0 {
				v, s = `"`+s[1:end+1]+`"`, s[end+2:]
			} else {
				v, s = s, ""
			}
		case strings.HasPrefix(s, `'`):
			if end := strings.IndexByte(s[1:], '\''); end >= 0 {
				v, s = s[:end+2], s[end+2:]
			} else {
				v, s = s, ""
			}
		default:
			if sp := strings.IndexByte(s, ' '); sp >= 0 {
				v, s = s[:sp], s[sp:]
			} else {
				v, s = s, ""
			}
		}
		out[k] = v
	}
}

// Text devolve um campo de texto (name, cwd, exe, comm, key, proctitle):
// tira as aspas ou decodifica o hexadecimal. "(null)" vira vazio.
func (r *Record) Text(key string) string {
	return decodeText(r.Fields[key])
}

func decodeText(v string) string {
	switch {
	case v == "" || v == "(null)" || v == "(none)":
		return ""
	case strings.HasPrefix(v, `"`) && strings.HasSuffix(v, `"`) && len(v) >= 2:
		return v[1 : len(v)-1]
	case isHex(v):
		b, err := hex.DecodeString(v)
		if err != nil {
			return v
		}
		// proctitle separa os argumentos com NUL.
		return strings.TrimRight(strings.ReplaceAll(string(b), "\x00", " "), " ")
	}
	return v
}

func isHex(s string) bool {
	if len(s) == 0 || len(s)%2 != 0 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'A' && c <= 'F' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Uint lê um número decimal (uid=1000) ou hexadecimal (a0=ffffff9c, hex=true).
func (r *Record) Uint(key string, hexa bool) (uint64, bool) {
	v := r.Fields[key]
	if v == "" {
		return 0, false
	}
	base := 10
	if hexa {
		base = 16
	}
	n, err := strconv.ParseUint(v, base, 64)
	return n, err == nil
}

// Int lê um número decimal com sinal (exit=-13).
func (r *Record) Int(key string) (int64, bool) {
	n, err := strconv.ParseInt(r.Fields[key], 10, 64)
	return n, err == nil
}
