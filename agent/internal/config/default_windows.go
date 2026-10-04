package config

import (
	"strings"

	"golang.org/x/sys/windows/registry"
)

const defaultDataDir = `C:\ProgramData\TechAudit`

// RegistryKey é onde o instalador MSI grava o servidor e o token de registro.
const RegistryKey = `SOFTWARE\TechAudit\Agent`

func fromRegistry() (*Config, bool) {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, RegistryKey, registry.QUERY_VALUE)
	if err != nil {
		return nil, false
	}
	defer k.Close()
	get := func(name string) string {
		v, _, _ := k.GetStringValue(name)
		return strings.TrimSpace(v)
	}
	c := &Config{
		// O instalador gráfico aceita só o endereço do servidor.
		Endpoint:        NormalizeEndpoint(get("Endpoint")),
		EnrollmentToken: get("EnrollmentToken"),
		CAFile:          get("CAFile"),
		Filter:          defaultFilter,
	}
	return c, c.Endpoint != ""
}

// ForgetEnrollmentToken apaga o token de registro do registro do Windows
// depois que o agente já obteve o próprio token (o valor é legível por
// qualquer usuário local).
func ForgetEnrollmentToken() {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, RegistryKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	k.DeleteValue("EnrollmentToken")
}

func platformDefaults(*Config) {}

func rememberPath(string) {}
