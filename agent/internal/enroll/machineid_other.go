//go:build !windows

package enroll

import (
	"os"
	"strings"
)

// rawMachineID usa o machine-id do systemd/dbus.
func rawMachineID() (string, error) {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(p); err == nil && strings.TrimSpace(string(b)) != "" {
			return strings.TrimSpace(string(b)), nil
		}
	}
	h, err := os.Hostname()
	return "hostname:" + h, err
}
