//go:build !windows && !linux

package auditcfg

import "errors"

// NewNotifier aqui só usa o log do agente.
func NewNotifier(logf func(string, ...any)) func(warning bool, msg string) {
	return func(bool, string) {}
}

// NewPlatformSyncer só existe no Windows e no Linux.
func NewPlatformSyncer(*Client, Options) (*Syncer, error) {
	return nil, errors.New("aplicação de auditoria disponível só no Windows e no Linux")
}
