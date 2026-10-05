package main

import (
	"context"
	"log"
	"net/http"
	"path/filepath"
	"sync/atomic"

	"github.com/mracapulco/Tech_Audit/agent/internal/auditcfg"
	"github.com/mracapulco/Tech_Audit/agent/internal/config"
	"github.com/mracapulco/Tech_Audit/agent/internal/perms"
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
	startPermissions(ctx, cfg, c, s)
	auditExclusions.Store(&s.Exclusions)
	log.Printf("configuração de auditoria: consulta a cada %s; log de alterações em %s", s.Opts.Interval, s.Opts.ChangeLog)
	go s.Run(ctx)
}

// startPermissions liga o inventário de permissões (quem tem acesso a cada
// pasta auditada). Só coleta quando o portal liga o recurso (plano
// Enterprise); só lê permissões, nunca altera.
func startPermissions(ctx context.Context, cfg *config.Config, c *auditcfg.Client, s *auditcfg.Syncer) {
	reader, err := perms.NewReader()
	if err != nil {
		log.Printf("inventário de permissões indisponível: %v", err)
		return
	}
	send := func(ctx context.Context, u perms.Upload) error { return c.Post(ctx, "permissions", u) }
	r := perms.NewRunner(reader, send, filepath.Join(cfg.DataDir, "permissions-state.json"))
	r.Logf = log.Printf
	s.OnConfig = func(cfg *auditcfg.Config, active []auditcfg.PathConfig) {
		paths := make([]perms.Path, len(active))
		for i, p := range active {
			paths[i] = perms.Path{ID: p.ID, Path: p.Path}
		}
		p := cfg.Permissions
		r.Update(perms.Settings{Enabled: p.Enabled, IntervalHours: p.IntervalHours, RequestedAt: p.RequestedAt}, paths)
	}
	go r.Run(ctx)
}
