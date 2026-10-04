package auditcfg

import "testing"

func TestParseRules(t *testing.T) {
	out := `-w /etc/passwd -p wa -k identity
-a always,exit -S all -F dir=/dados -F perm=wa -F auid!=-1 -F key=techaudit
-a always,exit -F arch=b64 -S open,openat -F dir=/dados/Recursos Humanos -F perm=r -F auid!=-1 -F key=techaudit-r
-a always,exit -S all -F dir=/srv/x -F perm=wa -F auid!=unset -F key=outra
`
	got := parseRules(out)
	if len(got) != 2 || got[0] != (AuditRule{Dir: "/dados"}) || got[1] != (AuditRule{Dir: "/dados/Recursos Humanos", Read: true}) {
		t.Fatalf("%+v", got)
	}
}
