package auditcfg

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/dirsize"
	"github.com/mracapulco/Tech_Audit/agent/internal/sddl"
)

// fakeSys simula o Windows: SACL por pasta e a política de Sistema de arquivos.
type fakeSys struct {
	sacl       map[string]string
	policy     Policy
	writes     int
	policySets []Policy
	failWrite  error
	panicWrite bool
}

func (f *fakeSys) ReadSACL(p string) (string, error) {
	s, ok := f.sacl[p]
	if !ok {
		return "", fs.ErrNotExist
	}
	return s, nil
}

func (f *fakeSys) WriteSACL(p, s string) error {
	if f.panicWrite {
		panic("falha simulada")
	}
	if f.failWrite != nil {
		return f.failWrite
	}
	f.writes++
	f.sacl[p] = s
	return nil
}
func (f *fakeSys) ReadPolicy() (Policy, error) { return f.policy, nil }
func (f *fakeSys) WritePolicy(p Policy) error {
	f.policy = p
	f.policySets = append(f.policySets, p)
	return nil
}

// fakeServer faz o papel de /v1/config.
type fakeServer struct {
	mu      sync.Mutex
	cfg     Config
	results []map[string]any
	sizes   []map[string]any
	fail    bool
}

func (s *fakeServer) handler(t *testing.T) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer ta_agt_x" {
			w.WriteHeader(401)
			return
		}
		if s.fail {
			w.WriteHeader(503)
			return
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /v1/config":
			json.NewEncoder(w).Encode(s.cfg)
		case "POST /v1/config/result":
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			s.results = append(s.results, b)
			w.Write([]byte(`{}`))
		case "POST /v1/config/sizes":
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			s.sizes = append(s.sizes, b)
			w.Write([]byte(`{}`))
		default:
			t.Errorf("rota inesperada %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	})
}

func (s *fakeServer) lastResults() []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.results) == 0 {
		return nil
	}
	return s.results[len(s.results)-1]["results"].([]any)
}

const (
	fin   = `D:\Dados\Financeiro`
	rh    = `D:\Dados\RH`
	finID = "11111111-1111-4111-8111-111111111111"
	rhID  = "22222222-2222-4222-8222-222222222222"
)

func setup(t *testing.T) (*Syncer, *fakeSys, *fakeServer, *time.Time) {
	t.Helper()
	srv := &fakeServer{}
	hs := httptest.NewServer(srv.handler(t))
	t.Cleanup(hs.Close)
	client, err := NewClient(hs.Client(), hs.URL+"/v1/events", "ta_agt_x")
	if err != nil {
		t.Fatal(err)
	}
	sys := &fakeSys{sacl: map[string]string{
		fin: "S:AI(AU;SA;FA;;;BA)(AU;OICIIDSA;FA;;;WD)",
		rh:  "S:AI",
	}}
	dir := t.TempDir()
	s, err := NewSyncer(client, sys, Options{StateFile: filepath.Join(dir, "state.json"), ChangeLog: filepath.Join(dir, "changes.log")})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	return s, sys, srv, &now
}

func result(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("resultado inesperado: %#v", v)
	}
	return m
}

func TestApplyRemoveAndPolicy(t *testing.T) {
	s, sys, srv, now := setup(t)
	ctx := context.Background()
	ace := sddl.AuditACE(true, false)

	srv.cfg = Config{Version: 1, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true, Exclusions: []string{"*.tmp"}}}}
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if !sys.policy.Success || !sys.policy.Failure {
		t.Fatal("política deveria ser habilitada")
	}
	if got := sys.sacl[fin]; got != "S:AI(AU;SA;FA;;;BA)"+ace {
		t.Fatalf("SACL: %s", got)
	}
	r := result(t, srv.lastResults()[0])
	if r["status"] != "applied" || r["operation"] != "apply" {
		t.Fatalf("resultado: %v", r)
	}
	before := r["before"].(map[string]any)
	after := r["after"].(map[string]any)
	if before["policy"] != "Sistema de arquivos: sem auditoria" || after["policy"] != "Sistema de arquivos: sucesso e falha" {
		t.Fatalf("política antes/depois: %v %v", before, after)
	}
	if !strings.Contains(after["sacl"].(string), ace) {
		t.Fatalf("SACL depois: %v", after)
	}
	if !s.Exclusions.Excluded(fin+`\planilha.TMP`) || s.Exclusions.Excluded(fin+`\planilha.xlsx`) {
		t.Fatal("exclusões da configuração")
	}

	// Servidor já registrou: nada a fazer, nada a enviar.
	srv.cfg.Paths[0].Status = "applied"
	writes, sent := sys.writes, len(srv.results)
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if sys.writes != writes || len(srv.results) != sent {
		t.Fatal("configuração igual não deveria regravar nem reenviar")
	}

	// Opções mudam (passa a auditar leitura): troca a entrada do agente.
	srv.cfg = Config{Version: 2, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true, AuditRead: true}}}
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	ace2 := sddl.AuditACE(true, true)
	if got := sys.sacl[fin]; got != "S:AI(AU;SA;FA;;;BA)"+ace2 {
		t.Fatalf("SACL depois de alterar: %s", got)
	}

	// Remoção: retira só a entrada do agente e restaura a política.
	*now = now.Add(time.Minute)
	srv.cfg = Config{Version: 3, Paths: []PathConfig{{ID: finID, Path: fin, State: "removed", Status: "removing", Recursive: true, AuditRead: true}}}
	if err := s.Once(ctx); err != nil {
		t.Fatal(err)
	}
	if got := sys.sacl[fin]; got != "S:AI(AU;SA;FA;;;BA)" {
		t.Fatalf("SACL depois de remover: %s", got)
	}
	if sys.policy != (Policy{}) {
		t.Fatalf("política deveria voltar a ser a original: %+v", sys.policy)
	}
	r = result(t, srv.lastResults()[0])
	if r["status"] != "removed" || !strings.Contains(r["message"].(string), "restaurada") {
		t.Fatalf("remoção: %v", r)
	}

	// Log local íntegro, com a corrente de hash.
	n, err := VerifyChangeLog(s.Opts.ChangeLog)
	if err != nil || n < 5 {
		t.Fatalf("log local: %d linhas, %v", n, err)
	}
	b, _ := os.ReadFile(s.Opts.ChangeLog)
	os.WriteFile(s.Opts.ChangeLog, []byte(strings.Replace(string(b), "Financeiro", "Financeir0", 1)), 0o600)
	if _, err := VerifyChangeLog(s.Opts.ChangeLog); err == nil {
		t.Fatal("log alterado deveria ser detectado")
	}
}

func TestPreexistingACEIsKept(t *testing.T) {
	s, sys, srv, _ := setup(t)
	ace := sddl.AuditACE(true, false)
	sys.sacl[rh] = "S:AI" + ace
	sys.policy = Policy{Success: true, Failure: true}
	srv.cfg = Config{Version: 1, Paths: []PathConfig{{ID: rhID, Path: rh, State: "active", Status: "pending", Recursive: true}}}
	if err := s.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sys.writes != 0 || len(sys.policySets) != 0 {
		t.Fatal("nada deveria ser gravado: entrada e política já existiam")
	}
	srv.cfg = Config{Version: 2, Paths: []PathConfig{{ID: rhID, Path: rh, State: "removed", Status: "removing", Recursive: true}}}
	if err := s.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sys.sacl[rh] != "S:AI"+ace {
		t.Fatalf("entrada que já existia foi removida: %s", sys.sacl[rh])
	}
}

func TestErrorIsNotRetriedUntilReapply(t *testing.T) {
	s, sys, srv, _ := setup(t)
	sys.failWrite = errors.New("acesso negado")
	srv.cfg = Config{Version: 1, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true}}}
	s.Once(context.Background())
	r := result(t, srv.lastResults()[0])
	if r["status"] != "error" || !strings.Contains(r["message"].(string), "acesso negado") {
		t.Fatalf("erro: %v", r)
	}
	srv.cfg.Paths[0].Status = "error"
	sent := len(srv.results)
	s.Once(context.Background())
	if len(srv.results) != sent {
		t.Fatal("o mesmo erro não deveria ser repetido a cada consulta")
	}
	// Reaplicar no portal: volta a pending e o agente tenta de novo.
	sys.failWrite = nil
	srv.cfg = Config{Version: 2, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true}}}
	s.Once(context.Background())
	if r := result(t, srv.lastResults()[0]); r["status"] != "applied" {
		t.Fatalf("reaplicar: %v", r)
	}
}

func TestVerifyReportsDivergenceOnce(t *testing.T) {
	s, sys, srv, now := setup(t)
	srv.cfg = Config{Version: 1, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true}}}
	s.Once(context.Background())
	srv.cfg.Paths[0].Status = "applied"

	// Alguém removeu a entrada; na próxima verificação vira divergente.
	sys.sacl[fin] = "S:AI(AU;SA;FA;;;BA)"
	*now = now.Add(31 * time.Minute)
	s.Once(context.Background())
	r := result(t, srv.lastResults()[0])
	if r["status"] != "divergent" || r["operation"] != "verify" || !strings.Contains(r["message"].(string), "removida") {
		t.Fatalf("divergência: %v", r)
	}
	if strings.Contains(sys.sacl[fin], "WD") {
		t.Fatal("verificação não reaplica")
	}
	sent := len(srv.results)
	*now = now.Add(31 * time.Minute)
	s.Once(context.Background())
	if len(srv.results) != sent {
		t.Fatal("divergência repetida não deveria ser reenviada")
	}

	// GPO desligando a política também é divergência.
	srv.cfg = Config{Version: 2, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true}}}
	s.Once(context.Background())
	srv.cfg.Paths[0].Status = "applied"
	sys.policy = Policy{}
	*now = now.Add(31 * time.Minute)
	s.Once(context.Background())
	r = result(t, srv.lastResults()[0])
	if r["status"] != "divergent" || !strings.Contains(r["message"].(string), "GPO") {
		t.Fatalf("GPO: %v", r)
	}
}

func TestResultsResentAfterServerFailure(t *testing.T) {
	s, sys, srv, _ := setup(t)
	srv.cfg = Config{Version: 1, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true}}}
	s.Once(context.Background())
	// Resposta perdida: o servidor continua com o pedido pendente.
	srv.results = nil
	writes := sys.writes
	if err := s.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if sys.writes != writes {
		t.Fatal("reaplicar o que já está aplicado não deveria regravar a SACL")
	}
	if r := result(t, srv.lastResults()[0]); r["status"] != "applied" {
		t.Fatalf("reenvio: %v", r)
	}
	srv.fail = true
	if err := s.Once(context.Background()); err == nil {
		t.Fatal("servidor fora do ar deveria dar erro")
	}
}

func TestMeasureOnce(t *testing.T) {
	s, _, srv, _ := setup(t)
	s.Measure = func(_ context.Context, paths []string) map[string]*dirsize.Result {
		return map[string]*dirsize.Result{fin: {Bytes: 1234}, rh: {Err: errors.New("acesso negado")}}
	}
	srv.cfg = Config{Version: 1, Paths: []PathConfig{
		{ID: finID, Path: fin, State: "active", Status: "applied", Recursive: true},
		{ID: rhID, Path: rh, State: "active", Status: "applied", Recursive: true},
	}}
	s.Once(context.Background())
	if err := s.MeasureOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := srv.sizes[0]["paths"].([]any)
	a, b := result(t, got[0]), result(t, got[1])
	if a["path_id"] != finID || a["size_bytes"].(float64) != 1234 || b["error"] != "acesso negado" {
		t.Fatalf("tamanhos: %v", got)
	}
}

func TestExclusionsGlob(t *testing.T) {
	var x Exclusions
	x.set([]PathConfig{{Path: `D:\Dados`, State: "active", Exclusions: []string{"~$*", "*.tmp", `Backup\Antigo`, "Temp"}}})
	for path, want := range map[string]bool{
		`D:\Dados\~$planilha.xlsx`:         true,
		`D:\Dados\a\b\arquivo.TMP`:         true,
		`D:\Dados\Backup\Antigo\x.doc`:     true,
		`D:\Dados\Backup\Novo\x.doc`:       false,
		`D:\Dados\Projetos\Temp\x.doc`:     true,
		`D:\Dados\Projetos\Temporario.doc`: false,
		`E:\Outro\a.tmp`:                   false,
	} {
		if got := x.Excluded(path); got != want {
			t.Errorf("Excluded(%s) = %v", path, got)
		}
	}
	var nilX *Exclusions
	if nilX.Excluded(`D:\x`) {
		t.Error("nil não exclui")
	}
}

func TestDescribeEmptySACL(t *testing.T) {
	msg := describe(ChangeEntry{Operation: "apply", Status: "applied", Path: fin,
		Before: &AuditState{Policy: "Sistema de arquivos: sucesso e falha"},
		After:  &AuditState{SACL: "S:AI(AU;OICISAFA;DCLCRPDTCRSDWDWO;;;WD)", Policy: "Sistema de arquivos: sucesso e falha"}})
	if !strings.Contains(msg, "Antes: SACL vazia; Sistema de arquivos") || !strings.Contains(msg, "Depois: SACL S:AI(AU;") {
		t.Fatal(msg)
	}
	if strings.Contains(describe(ChangeEntry{Operation: "policy", Status: "applied", Before: &AuditState{Policy: "x"}}), "SACL") {
		t.Fatal("mudança só de política não fala de SACL")
	}
}

func TestWindowsAliasMaskIsRecognized(t *testing.T) {
	// Como o Windows 11 devolveu a entrada no teste do Rafael (02/10/2026).
	s, _ := sddl.Parse("O:BAG:DUD:AI(A;OICIID;FA;;;BA)S:AI(AU;OICISAFA;DCLCRPDTCRSDWDWO;;;WD)")
	if !s.Has(sddl.AuditACE(true, false)) {
		t.Fatal("entrada com siglas não reconhecida")
	}
}

// Uma falha inesperada ao aplicar não pode derrubar o agente (a coleta de
// eventos roda no mesmo processo): vira erro e a próxima rodada tenta de novo.
func TestSafeOnceRecoversPanic(t *testing.T) {
	s, sys, srv, _ := setup(t)
	sys.panicWrite = true
	srv.cfg = Config{Version: 1, Paths: []PathConfig{{ID: finID, Path: fin, State: "active", Status: "pending", Recursive: true}}}
	err := s.safeOnce(context.Background())
	if err == nil || !strings.Contains(err.Error(), "falha simulada") {
		t.Fatalf("erro esperado, veio %v", err)
	}
}
