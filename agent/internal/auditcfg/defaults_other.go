//go:build !windows

package auditcfg

const (
	defaultStateFile = "techaudit-audit-config-state.json"
	defaultChangeLog = "techaudit-audit-changes.log"
)
