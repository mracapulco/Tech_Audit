//go:build !linux && !windows

package perms

import "errors"

// NewReader: o inventário só existe no Windows e no Linux.
func NewReader() (Reader, error) {
	return nil, errors.New("inventário de permissões disponível só no Windows e no Linux")
}
