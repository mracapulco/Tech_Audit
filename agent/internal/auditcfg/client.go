package auditcfg

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Client fala com /v1/config no mesmo servidor do endpoint de eventos.
type Client struct {
	HTTP  *http.Client
	Token string
	base  *url.URL
}

// NewClient deriva os endereços do endpoint de eventos
// (https://host/v1/events -> https://host/v1/config).
func NewClient(httpClient *http.Client, eventsEndpoint, token string) (*Client, error) {
	u, err := url.Parse(eventsEndpoint)
	if err != nil {
		return nil, err
	}
	return &Client{HTTP: httpClient, Token: token, base: u}, nil
}

func (c *Client) url(rel string) string { return c.base.ResolveReference(&url.URL{Path: rel}).String() }

// Fetch busca a configuração atual.
func (c *Client) Fetch(ctx context.Context) (*Config, error) {
	var cfg Config
	if err := c.do(ctx, http.MethodGet, c.url("config"), nil, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// SendResults informa o que foi aplicado na versão.
func (c *Client) SendResults(ctx context.Context, version int, results []Result) error {
	if results == nil {
		results = []Result{}
	}
	return c.do(ctx, http.MethodPost, c.url("config/result"), map[string]any{"version": version, "results": results}, nil)
}

// SizeReport é o tamanho de um caminho, ou o erro ao medir.
type SizeReport struct {
	PathID    string `json:"path_id"`
	SizeBytes *int64 `json:"size_bytes,omitempty"`
	Error     string `json:"error,omitempty"`
}

// SendSizes envia a medição das pastas.
func (c *Client) SendSizes(ctx context.Context, sizes []SizeReport) error {
	return c.do(ctx, http.MethodPost, c.url("config/sizes"), map[string]any{"paths": sizes}, nil)
}

func (c *Client) do(ctx context.Context, method, u string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%s %s: HTTP %d: %s", method, req.URL.Path, resp.StatusCode, bytes.TrimSpace(data[:min(len(data), 512)]))
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("%s %s: resposta inválida: %w", method, req.URL.Path, err)
		}
	}
	return nil
}
