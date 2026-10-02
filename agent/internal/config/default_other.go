//go:build !windows

package config

const defaultDataDir = "."

func fromRegistry() (*Config, bool) { return nil, false }

// ForgetEnrollmentToken só tem efeito no Windows.
func ForgetEnrollmentToken() {}
