package source

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows Event Log API (wevtapi.dll). Constantes de winevt.h.
var (
	modwevtapi            = windows.NewLazySystemDLL("wevtapi.dll")
	procEvtSubscribe      = modwevtapi.NewProc("EvtSubscribe")
	procEvtNext           = modwevtapi.NewProc("EvtNext")
	procEvtRender         = modwevtapi.NewProc("EvtRender")
	procEvtClose          = modwevtapi.NewProc("EvtClose")
	procEvtCreateBookmark = modwevtapi.NewProc("EvtCreateBookmark")
	procEvtUpdateBookmark = modwevtapi.NewProc("EvtUpdateBookmark")
)

const (
	evtSubscribeToFutureEvents      = 1
	evtSubscribeStartAtOldestRecord = 2
	evtSubscribeStartAfterBookmark  = 3
	evtSubscribeStrict              = 0x10000

	evtRenderEventXml = 1
	evtRenderBookmark = 2

	errorNoMoreItems        = syscall.Errno(259)
	errorInsufficientBuffer = syscall.Errno(122)
	errorInvalidOperation   = syscall.Errno(4317)
)

type evtHandle uintptr

func evtClose(h evtHandle) {
	if h != 0 {
		procEvtClose.Call(uintptr(h))
	}
}

// EventLog assina um canal do Event Log (modelo pull). Bookmark devolve a
// posição para retomar exatamente após o último evento processado.
type EventLog struct {
	sub      evtHandle
	signal   windows.Handle
	bookmark evtHandle
	pending  []evtHandle
	buf      []uint16
}

// OpenEventLog assina channel (ex.: "Security") filtrando por query (XPath),
// a partir de bookmark (XML devolvido por Bookmark). startFrom ("now" ou
// "oldest") só vale quando bookmark é vazio.
func OpenEventLog(channel, query, bookmark, startFrom string) (*EventLog, error) {
	l := &EventLog{buf: make([]uint16, 64*1024)}

	var flags uintptr = evtSubscribeToFutureEvents
	if startFrom == "oldest" {
		flags = evtSubscribeStartAtOldestRecord
	}
	var bmXML *uint16
	if bookmark != "" {
		var err error
		bmXML, err = windows.UTF16PtrFromString(bookmark)
		if err != nil {
			return nil, err
		}
		// Sem Strict: se o registro do bookmark já saiu do log (rotação),
		// a assinatura continua a partir do evento mais antigo disponível.
		flags = evtSubscribeStartAfterBookmark
	}
	h, _, err := procEvtCreateBookmark.Call(uintptr(unsafe.Pointer(bmXML)))
	if h == 0 {
		return nil, fmt.Errorf("EvtCreateBookmark: %w", err)
	}
	l.bookmark = evtHandle(h)

	l.signal, err = windows.CreateEvent(nil, 1, 1, nil)
	if err != nil {
		l.Close()
		return nil, err
	}
	ch, _ := windows.UTF16PtrFromString(channel)
	q, _ := windows.UTF16PtrFromString(query)
	var bm uintptr
	if flags == evtSubscribeStartAfterBookmark {
		bm = uintptr(l.bookmark)
	}
	h, _, err = procEvtSubscribe.Call(0, uintptr(l.signal),
		uintptr(unsafe.Pointer(ch)), uintptr(unsafe.Pointer(q)),
		bm, 0, 0, flags)
	if h == 0 {
		l.Close()
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return nil, fmt.Errorf("EvtSubscribe(%s): acesso negado; execute como SYSTEM ou administrador: %w", channel, err)
		}
		return nil, fmt.Errorf("EvtSubscribe(%s): %w", channel, err)
	}
	l.sub = evtHandle(h)
	return l, nil
}

func (l *EventLog) Next(ctx context.Context, n int, wait time.Duration) ([][]byte, error) {
	handles := make([]evtHandle, n)
	var returned uint32
	for attempt := 0; ; attempt++ {
		r, _, err := procEvtNext.Call(uintptr(l.sub), uintptr(n),
			uintptr(unsafe.Pointer(&handles[0])), 0, 0, uintptr(unsafe.Pointer(&returned)))
		if r != 0 {
			break
		}
		if !errors.Is(err, errorNoMoreItems) && !errors.Is(err, errorInvalidOperation) {
			return nil, fmt.Errorf("EvtNext: %w", err)
		}
		if attempt > 0 {
			return nil, nil // nada novo dentro de wait
		}
		// Sem eventos: zera o sinal e espera o próximo, sem perder sinais que
		// cheguem entre o EvtNext e o ResetEvent (o laço tenta mais uma vez).
		windows.ResetEvent(l.signal)
		ms := uint32(wait / time.Millisecond)
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) < wait {
			ms = uint32(max(time.Until(dl), 0) / time.Millisecond)
		}
		if _, err := windows.WaitForSingleObject(l.signal, ms); err != nil {
			return nil, err
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}

	out := make([][]byte, 0, returned)
	for _, h := range handles[:returned] {
		x, err := l.render(h, evtRenderEventXml)
		if err != nil {
			for _, h := range handles[:returned] {
				evtClose(h)
			}
			return nil, err
		}
		out = append(out, []byte(x))
		l.pending = append(l.pending, h)
	}
	return out, nil
}

// Bookmark avança o bookmark até o último evento devolvido por Next e o
// devolve em XML.
func (l *EventLog) Bookmark() (string, error) {
	if len(l.pending) > 0 {
		last := l.pending[len(l.pending)-1]
		r, _, err := procEvtUpdateBookmark.Call(uintptr(l.bookmark), uintptr(last))
		for _, h := range l.pending {
			evtClose(h)
		}
		l.pending = l.pending[:0]
		if r == 0 {
			return "", fmt.Errorf("EvtUpdateBookmark: %w", err)
		}
	}
	return l.render(l.bookmark, evtRenderBookmark)
}

func (l *EventLog) render(h evtHandle, flag uintptr) (string, error) {
	for {
		var used, props uint32
		r, _, err := procEvtRender.Call(0, uintptr(h), flag,
			uintptr(len(l.buf)*2), uintptr(unsafe.Pointer(&l.buf[0])),
			uintptr(unsafe.Pointer(&used)), uintptr(unsafe.Pointer(&props)))
		if r != 0 {
			return windows.UTF16ToString(l.buf[:used/2]), nil
		}
		if !errors.Is(err, errorInsufficientBuffer) {
			return "", fmt.Errorf("EvtRender: %w", err)
		}
		l.buf = make([]uint16, used/2+1)
	}
}

func (l *EventLog) Close() error {
	for _, h := range l.pending {
		evtClose(h)
	}
	l.pending = nil
	evtClose(l.sub)
	evtClose(l.bookmark)
	if l.signal != 0 {
		windows.CloseHandle(l.signal)
	}
	return nil
}
