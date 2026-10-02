package sender

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

func TestSendRetriesThenSucceeds(t *testing.T) {
	var calls atomic.Int32
	var got event.Batch
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "indisponível", http.StatusServiceUnavailable)
			return
		}
		if r.Header.Get("Authorization") != "Bearer segredo" {
			t.Errorf("token ausente: %q", r.Header.Get("Authorization"))
		}
		zr, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.NewDecoder(zr).Decode(&got); err != nil {
			t.Fatal(err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	s, _ := New(srv.URL, "segredo", "")
	s.MaxBackoff = 10 * time.Millisecond
	b := &event.Batch{AgentID: "fs01", Events: []event.Event{{RecordID: 7, Actions: []string{"write"}}}}
	if err := s.Send(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 || got.AgentID != "fs01" || len(got.Events) != 1 || got.Events[0].RecordID != 7 {
		t.Errorf("calls=%d got=%+v", calls.Load(), got)
	}
}

func TestSendDoesNotRetryClientError(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "token inválido", http.StatusUnauthorized)
	}))
	defer srv.Close()

	s, _ := New(srv.URL, "x", "")
	if err := s.Send(context.Background(), &event.Batch{}); err == nil {
		t.Fatal("esperava erro")
	}
	if calls.Load() != 1 {
		t.Errorf("calls=%d, esperado 1", calls.Load())
	}
}
