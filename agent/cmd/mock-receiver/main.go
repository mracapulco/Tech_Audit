// Comando mock-receiver é um endpoint de teste: recebe os lotes do agente e
// imprime uma linha por evento. Não grava nada; serve só para validar a coleta.
package main

import (
	"compress/gzip"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

func main() {
	addr := flag.String("addr", ":8080", "endereço de escuta")
	token := flag.String("token", "", "token Bearer exigido (vazio aceita qualquer um)")
	flag.Parse()

	http.HandleFunc("POST /v1/events", func(w http.ResponseWriter, r *http.Request) {
		if *token != "" && r.Header.Get("Authorization") != "Bearer "+*token {
			http.Error(w, "token inválido", http.StatusUnauthorized)
			return
		}
		var body io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			zr, err := gzip.NewReader(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			body = zr
		}
		var b event.Batch
		if err := json.NewDecoder(body).Decode(&b); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		log.Printf("lote de %s (%s, v%s): %d eventos", b.AgentID, b.Hostname, b.AgentVersion, len(b.Events))
		for _, e := range b.Events {
			log.Printf("  %s %s\\%s %-6s %s [%s] %s %s",
				e.Time.Local().Format("2006-01-02 15:04:05"), e.User.Domain, e.User.Name,
				e.Outcome, strings.Join(e.Actions, ","), e.Kind, e.Path, e.ClientIP)
		}
		w.WriteHeader(http.StatusAccepted)
	})
	log.Printf("mock-receiver ouvindo em %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
