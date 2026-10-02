package enroll

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://audit.example.com/v1/events":    "https://audit.example.com/v1/enroll",
		"http://localhost:3001/v1/events":        "http://localhost:3001/v1/enroll",
		"https://x.example.com/ingest/v1/events": "https://x.example.com/ingest/v1/enroll",
	} {
		got, err := URL(in)
		if err != nil || got != want {
			t.Errorf("URL(%q) = %q, %v; quer %q", in, got, err, want)
		}
	}
}

func TestEnroll(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req Request
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || r.URL.Path != "/v1/enroll" {
			http.Error(w, "ruim", http.StatusBadRequest)
			return
		}
		if req.EnrollmentToken != "ta_enr_ok" {
			http.Error(w, `{"message":"token de registro inválido"}`, http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(Credentials{AgentID: "a1", TenantID: "t1", AgentToken: "ta_agt_x"})
	}))
	defer srv.Close()

	u, _ := URL(srv.URL + "/v1/events")
	c, err := Enroll(context.Background(), srv.Client(), u, Request{EnrollmentToken: "ta_enr_ok", MachineID: "m"})
	if err != nil || c.AgentID != "a1" || c.AgentToken != "ta_agt_x" {
		t.Fatalf("Enroll = %+v, %v", c, err)
	}
	_, err = Enroll(context.Background(), srv.Client(), u, Request{EnrollmentToken: "errado"})
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("esperava HTTP 401, veio %v", err)
	}
}

func TestSaveLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", "credentials.json")
	if c, err := Load(path); c != nil || err != nil {
		t.Fatalf("Load sem arquivo = %v, %v", c, err)
	}
	want := &Credentials{AgentID: "a1", TenantID: "t1", AgentToken: "ta_agt_x"}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil || *got != *want {
		t.Fatalf("Load = %+v, %v", got, err)
	}
}

func TestMachineIDStable(t *testing.T) {
	a, err := MachineID()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := MachineID()
	if a != b || len(a) != 64 {
		t.Fatalf("MachineID instável ou mal formado: %q %q", a, b)
	}
}
