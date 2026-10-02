package config

import "testing"

func TestCheckEndpoint(t *testing.T) {
	ok := []string{
		"https://ingest-audit.techmaster.inf.br/v1/events",
		"http://localhost:3101/v1/events",
		"http://127.0.0.1:3001/v1/events",
		"http://192.168.0.10:3101/v1/events",
		"http://10.1.2.3/v1/events",
		"http://[::1]:3001/v1/events",
	}
	for _, e := range ok {
		if err := checkEndpoint(e); err != nil {
			t.Errorf("%s: %v", e, err)
		}
	}
	bad := []string{
		"http://ingest-audit.techmaster.inf.br/v1/events",
		"http://200.150.1.1:3101/v1/events",
		"ftp://localhost/v1/events",
		"ingest-audit.techmaster.inf.br/v1/events",
	}
	for _, e := range bad {
		if err := checkEndpoint(e); err == nil {
			t.Errorf("%s: deveria recusar", e)
		}
	}
}
