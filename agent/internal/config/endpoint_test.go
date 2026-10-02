package config

import "testing"

func TestNormalizeEndpoint(t *testing.T) {
	cases := map[string]string{
		"":                                       "",
		"https://ingest-audit.techmaster.inf.br": "https://ingest-audit.techmaster.inf.br/v1/events",
		" https://ingest-audit.techmaster.inf.br/ ": "https://ingest-audit.techmaster.inf.br/v1/events",
		"ingest-audit.techmaster.inf.br":            "https://ingest-audit.techmaster.inf.br/v1/events",
		"http://192.168.0.10:3101":                  "http://192.168.0.10:3101/v1/events",
		"http://192.168.0.10:3101/v1/events":        "http://192.168.0.10:3101/v1/events",
		"https://x.example/v1/events/":              "https://x.example/v1/events",
	}
	for in, want := range cases {
		if got := NormalizeEndpoint(in); got != want {
			t.Errorf("NormalizeEndpoint(%q) = %q, quero %q", in, got, want)
		}
	}
}
