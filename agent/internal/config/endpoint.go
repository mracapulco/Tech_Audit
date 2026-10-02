package config

import "strings"

// NormalizeEndpoint completa o endereço digitado no instalador gráfico:
// "ingest.audit.techmaster.inf.br" ou "https://ingest.audit.techmaster.inf.br/"
// viram "https://ingest.audit.techmaster.inf.br/v1/events". Um endereço que já
// tem caminho (ex.: .../v1/events, como nas versões anteriores) fica como está.
func NormalizeEndpoint(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	scheme, rest, _ := strings.Cut(s, "://")
	if host, path, ok := strings.Cut(rest, "/"); ok && strings.Trim(path, "/") != "" {
		return scheme + "://" + host + "/" + strings.TrimRight(path, "/")
	}
	return scheme + "://" + strings.TrimRight(rest, "/") + "/v1/events"
}
