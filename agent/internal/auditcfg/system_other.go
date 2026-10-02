//go:build !windows

package auditcfg

import "errors"

// NewSystem só existe no Windows por enquanto; no Linux a auditoria será
// configurada de outro jeito (Samba full_audit / auditd, seção 4.3).
func NewSystem() (System, error) {
	return nil, errors.New("aplicação de auditoria disponível só no Windows")
}

// NewNotifier fora do Windows só usa o log do agente.
func NewNotifier(logf func(string, ...any)) func(warning bool, msg string) {
	return func(bool, string) {}
}
