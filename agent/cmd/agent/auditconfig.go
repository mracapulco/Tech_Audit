package main

import (
	"context"
	"log"
	"net/http"
	"sync/atomic"

	"github.com/mracapulco/Tech_Audit/agent/internal/auditcfg"
	"github.com/mracapulco/Tech_Audit/agent/internal/config"
)

// auditExclusions acompanha os padrões ignorados e os caminhos ativos
// configurados no portal; nil enquanto a sincronização não roda (nada é
// excluído). Lido pelo coletor em outras goroutines.
var auditExclusions atomic.Pointer[auditcfg.Exclusions]

// startAuditConfig sincroniza os caminhos auditados com o portal em segundo
// plano: aplica a auditoria (SACL e política no Windows; auditd e Samba no
// Linux), registra cada alteração e mede o tamanho das pastas
// (docs/ARCHITECTURE.md, seções 4.6 e 9.2).
func startAuditConfig(ctx context.Context, cfg *config.Config, client *http.Client, token string) {
	if cfg.AuditConfig.Disabled {
		log.Print("configuração de auditoria pelo portal desligada (audit_config.disabled)")
		return
	}
	c, err := auditcfg.NewClient(client, cfg.Endpoint, token)
	if err != nil {
		log.Printf("configuração de auditoria: %v", err)
		return
	}
	s, err := auditcfg.NewPlatformSyncer(c, cfg.AuditConfig)
	if err != nil {
		log.Printf("configuração de auditoria pelo portal indisponível: %v", err)
		return
	}
	s.Logf = log.Printf
	s.Notify = auditcfg.NewNotifier(log.Printf)
	auditExclusions.Store(&s.Exclusions)
	log.Printf("configuração de auditoria: consulta a cada %s; log de alterações em %s", s.Opts.Interval, s.Opts.ChangeLog)
	go s.Run(ctx)
}
