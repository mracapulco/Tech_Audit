//go:build !windows

package dirsize

// LowerPriority não faz nada fora do Windows.
func LowerPriority() func() { return func() {} }
