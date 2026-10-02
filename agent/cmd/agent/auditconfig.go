package main

import (
	"context"
	"log"
	"net/http"

	"github.com/mracapulco/Tech_Audit/agent/internal/auditcfg"
	"github.com/mracapulco/Tech_Audit/agent/internal/config"
)

// auditExclusions acompanha os padrões ignorados configurados no portal;
// nil enquanto a sincronização não roda (nada é excluído).
var auditExclusions *auditcfg.Exclusions

// startAuditConfig sincroniza os caminhos auditados com o portal em segundo
// plano: aplica política de auditoria e SACL, registra cada alteração e mede
// o tamanho das pastas (docs/ARCHITECTURE.md, seções 4.6 e 9.2).
func startAuditConfig(ctx context.Context, cfg *config.Config, client *http.Client, token string) {
	if cfg.AuditConfig.Disabled {
		log.Print("configuração de auditoria pelo portal desligada (audit_config.disabled)")
		return
	}
	sys, err := auditcfg.NewSystem()
	if err != nil {
		log.Printf("configuração de auditoria pelo portal indisponível: %v", err)
		return
	}
	c, err := auditcfg.NewClient(client, cfg.Endpoint, token)
	if err != nil {
		log.Printf("configuração de auditoria: %v", err)
		return
	}
	s, err := auditcfg.NewSyncer(c, sys, cfg.AuditConfig)
	if err != nil {
		log.Printf("configuração de auditoria: %v", err)
		return
	}
	s.Logf = log.Printf
	s.Notify = auditcfg.NewNotifier(log.Printf)
	auditExclusions = &s.Exclusions
	log.Printf("configuração de auditoria: consulta a cada %s; log de alterações em %s", s.Opts.Interval, s.Opts.ChangeLog)
	go s.Run(ctx)
}
