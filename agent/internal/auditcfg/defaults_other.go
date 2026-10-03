//go:build !windows && !linux

package auditcfg

const (
	defaultStateFile = "techaudit-audit-config-state.json"
	defaultChangeLog = "techaudit-audit-changes.log"
)
