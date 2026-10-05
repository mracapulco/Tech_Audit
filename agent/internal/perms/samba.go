package perms

import (
	"strings"

	"github.com/mracapulco/Tech_Audit/agent/internal/samba"
)

// FromSamba descreve quem acessa um compartilhamento do Samba pelos
// parâmetros dele (valid users, read only, write list...). O acesso real é o
// menor entre isto e as permissões da pasta no Linux.
func FromSamba(sh samba.Share) Folder {
	f := Folder{Path: sh.Path, Source: "share", Share: sh.Name, Reason: "share"}
	get := func(k string) string { return sh.Access[k] }
	yes := func(k string, def bool) bool {
		switch strings.ToLower(get(k)) {
		case "yes", "true", "1":
			return true
		case "no", "false", "0":
			return false
		}
		return def
	}
	readOnly := yes("read only", true)
	valid, writeList, readList := smbList(get("valid users")), smbList(get("write list")), smbList(get("read list"))
	inList := func(list []string, name string) bool {
		for _, n := range list {
			if strings.EqualFold(n, name) {
				return true
			}
		}
		return false
	}
	rights := func(name string) (string, string) {
		switch {
		case inList(writeList, name):
			return "Leitura e gravação", "write list"
		case inList(readList, name):
			return "Leitura", "read list"
		case readOnly:
			return "Leitura", "read only = yes"
		default:
			return "Leitura e gravação", "read only = no"
		}
	}
	seen := map[string]bool{}
	add := func(name, access, label, raw string) {
		key := strings.ToLower(name) + "|" + access
		if seen[key] {
			return
		}
		seen[key] = true
		p, kind := smbPrincipal(name)
		f.Entries = append(f.Entries, Entry{Principal: p, Kind: kind, Access: access, Rights: label, Raw: raw, AppliesTo: "Compartilhamento"})
	}

	if len(valid) == 0 {
		who := "Todos os usuários do Samba"
		if yes("guest ok", false) {
			who = "Todos, inclusive convidados (sem senha)"
		}
		label, raw := "Leitura e gravação", "read only = no"
		if readOnly {
			label, raw = "Leitura", "read only = yes"
		}
		f.Entries = append(f.Entries, Entry{Principal: who, Kind: "group", Access: "allow", Rights: label, Raw: raw, AppliesTo: "Compartilhamento"})
	}
	for _, n := range valid {
		label, raw := rights(n)
		add(n, "allow", label, "valid users; "+raw)
	}
	if len(valid) == 0 {
		for _, n := range writeList {
			add(n, "allow", "Leitura e gravação", "write list")
		}
		for _, n := range readList {
			add(n, "allow", "Leitura", "read list")
		}
	}
	for _, n := range smbList(get("admin users")) {
		add(n, "allow", "Controle total (como root)", "admin users")
	}
	for _, n := range smbList(get("invalid users")) {
		add(n, "deny", "Sem acesso", "invalid users")
	}
	return f
}

// smbList separa uma lista do smb.conf (vírgulas ou espaços; nomes com
// espaço entre aspas).
func smbList(v string) []string {
	var out []string
	var cur strings.Builder
	quoted := false
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, s)
		}
		cur.Reset()
	}
	for _, r := range v {
		switch {
		case r == '"':
			quoted = !quoted
		case !quoted && (r == ',' || r == ' ' || r == '\t'):
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}

// smbPrincipal: @grupo, +grupo e &grupo são grupos (Unix ou NIS).
func smbPrincipal(n string) (string, string) {
	if t := strings.TrimLeft(n, "@+&"); t != n {
		return t, "group"
	}
	return n, "user"
}
