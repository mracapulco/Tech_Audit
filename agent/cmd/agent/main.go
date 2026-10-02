// Command agent é o agente do Tech Audit instalado nos servidores de arquivos dos clientes.
// Por enquanto é apenas um esqueleto; a coleta é implementada no protótipo do agente Windows.
package main

import (
	"fmt"
	"os"
	"runtime"
)

var version = "dev"

func main() {
	hostname, _ := os.Hostname()
	fmt.Printf("tech-audit-agent %s (%s/%s) em %s\n", version, runtime.GOOS, runtime.GOARCH, hostname)
}
