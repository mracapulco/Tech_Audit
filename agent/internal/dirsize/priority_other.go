//go:build !windows

package dirsize

func lowerPriority() func() { return func() {} }
