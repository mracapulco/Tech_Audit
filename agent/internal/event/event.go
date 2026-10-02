// Package event define o formato normalizado que o agente envia ao servidor
// e converte o XML bruto dos eventos de auditoria do Windows para esse formato.
package event

import "time"

// Event é um acesso a arquivo normalizado, independente do ID do evento de origem.
type Event struct {
	RecordID   uint64    `json:"record_id"`
	EventID    int       `json:"event_id"`
	Kind       string    `json:"kind"` // object_access, object_deleted, handle_request, share_access
	Time       time.Time `json:"time"`
	Computer   string    `json:"computer"`
	User       User      `json:"user"`
	Path       string    `json:"path,omitempty"`
	ObjectType string    `json:"object_type,omitempty"`
	ShareName  string    `json:"share_name,omitempty"`
	ClientIP   string    `json:"client_ip,omitempty"`
	Process    string    `json:"process,omitempty"`
	Actions    []string  `json:"actions"`
	AccessMask string    `json:"access_mask,omitempty"`
	Outcome    string    `json:"outcome"` // success ou failure
	HandleID   string    `json:"handle_id,omitempty"`
}

// User identifica quem executou a ação.
type User struct {
	Name    string `json:"name"`
	Domain  string `json:"domain"`
	SID     string `json:"sid,omitempty"`
	LogonID string `json:"logon_id,omitempty"`
}

// Batch é o corpo de cada POST enviado ao servidor.
type Batch struct {
	// BatchID é único por lote e se mantém nas novas tentativas de envio,
	// para o servidor ignorar lotes repetidos.
	BatchID      string    `json:"batch_id"`
	AgentID      string    `json:"agent_id"`
	Hostname     string    `json:"hostname"`
	AgentVersion string    `json:"agent_version"`
	SentAt       time.Time `json:"sent_at"`
	Events       []Event   `json:"events"`
}
