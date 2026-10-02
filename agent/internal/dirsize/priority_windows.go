package dirsize

import (
	"runtime"

	"golang.org/x/sys/windows"
)

var procSetThreadPriority = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadPriority")

const (
	threadModeBackgroundBegin = 0x00010000
	threadModeBackgroundEnd   = 0x00020000
)

// lowerPriority coloca a thread da varredura em modo de segundo plano (I/O e
// CPU em baixa prioridade), para não pesar no servidor de arquivos.
func lowerPriority() func() {
	runtime.LockOSThread()
	h := windows.CurrentThread()
	r, _, _ := procSetThreadPriority.Call(uintptr(h), threadModeBackgroundBegin)
	return func() {
		if r != 0 {
			procSetThreadPriority.Call(uintptr(h), threadModeBackgroundEnd)
		}
		runtime.UnlockOSThread()
	}
}
