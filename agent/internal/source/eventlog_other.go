//go:build !windows

package source

import (
	"context"
	"errors"
	"time"
)

// EventLog só existe no Windows; em outros sistemas use OpenFile (-replay).
type EventLog struct{}

func OpenEventLog(channel, query, stateFile, startFrom string) (*EventLog, error) {
	return nil, errors.New("leitura do Event Log só é suportada no Windows; use -replay")
}

func (*EventLog) Next(context.Context, int, time.Duration) ([][]byte, error) { return nil, nil }
func (*EventLog) Commit() error                                              { return nil }
func (*EventLog) Close() error                                               { return nil }
