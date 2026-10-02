// Package sender envia lotes de eventos ao servidor central via HTTP.
package sender

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/mracapulco/Tech_Audit/agent/internal/event"
)

// Sender faz POST de lotes JSON (gzip) para Endpoint.
type Sender struct {
	Endpoint string
	Token    string
	Client   *http.Client
	// MaxBackoff limita a espera entre novas tentativas.
	MaxBackoff time.Duration
	// Logf recebe mensagens de erro de envio. Opcional.
	Logf func(format string, args ...any)
}

// New cria um Sender com timeout de 30s por requisição. caFile, se informado,
// é um PEM com a CA que assinou o certificado do servidor (ex.: CA interna),
// adicionada às CAs do sistema.
func New(endpoint, token, caFile string) (*Sender, error) {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	if caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s: nenhum certificado PEM válido", caFile)
		}
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	return &Sender{
		Endpoint:   endpoint,
		Token:      token,
		Client:     &http.Client{Timeout: 30 * time.Second, Transport: tr},
		MaxBackoff: 5 * time.Minute,
	}, nil
}

// Send tenta enviar até conseguir ou até ctx ser cancelado. Erros 4xx (exceto
// 408 e 429) não são retentados, pois reenviar o mesmo lote não resolveria.
func (s *Sender) Send(ctx context.Context, b *event.Batch) error {
	body, err := encode(b)
	if err != nil {
		return err
	}
	backoff := time.Second
	for {
		retry, err := s.post(ctx, body)
		if err == nil {
			return nil
		}
		if !retry {
			return err
		}
		if s.Logf != nil {
			s.Logf("envio falhou (%v); nova tentativa em %s", err, backoff)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > s.MaxBackoff {
			backoff = s.MaxBackoff
		}
	}
}

func encode(b *event.Batch) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if err := json.NewEncoder(zw).Encode(b); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (s *Sender) post(ctx context.Context, body []byte) (retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Content-Encoding", "gzip")
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
	}
	resp, err := s.Client.Do(req)
	if err != nil {
		return true, err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return false, nil
	case resp.StatusCode == http.StatusRequestTimeout, resp.StatusCode == http.StatusTooManyRequests, resp.StatusCode >= 500:
		return true, fmt.Errorf("HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	default:
		return false, fmt.Errorf("HTTP %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}
}
