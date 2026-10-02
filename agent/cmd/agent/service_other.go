//go:build !windows

package main

import (
	"errors"
	"os"
)

const defaultConfigFile = "agent.json"

var errWindowsOnly = errors.New("disponível só no Windows")

func isService() bool                { return false }
func runService(options) error       { return errWindowsOnly }
func install([]string) error         { return errWindowsOnly }
func uninstall() error               { return errWindowsOnly }
func ensureDataDir(dir string) error { return os.MkdirAll(dir, 0o700) }
