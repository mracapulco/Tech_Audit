// Package event define o formato normalizado que o agente envia ao servidor
// e converte o XML bruto dos eventos de auditoria do Windows para esse formato.
package event

import "time"

// Ações lógicas (campo Action): o que o usuário fez, já correlacionando os
// vários eventos brutos que o Windows gera para uma mesma operação.
const (
	ActionCreated           = "created"            // arquivo ou pasta criado
	ActionModified          = "modified"           // conteúdo alterado
	ActionRead              = "read"               // conteúdo lido (só se a SACL auditar leitura)
	ActionDeleted           = "deleted"            // excluído definitivamente
	ActionRecycled          = "recycled"           // movido para a Lixeira
	ActionRenamed           = "renamed"            // renomeado na mesma pasta
	ActionMoved             = "moved"              // movido para outra pasta (ou destino não identificado)
	ActionPermissionChanged = "permission_changed" // permissões (DACL) alteradas
	ActionOwnerChanged      = "owner_changed"      // dono alterado
	ActionAttributesChanged = "attributes_changed" // atributos alterados (somente leitura, oculto...)
	ActionDenied            = "denied"             // tentativa de acesso negada
)

// Event é um acesso a arquivo normalizado, independente do ID do evento de origem.
type Event struct {
	RecordID   uint64    `json:"record_id"`
	EventID    int       `json:"event_id"`
	Kind       string    `json:"kind"` // object_access, object_deleted, handle_request, share_access, permissions_changed
	Time       time.Time `json:"time"`
	Computer   string    `json:"computer"`
	User       User      `json:"user"`
	Path       string    `json:"path,omitempty"`
	ObjectType string    `json:"object_type,omitempty"`
	ShareName  string    `json:"share_name,omitempty"`
	ClientIP   string    `json:"client_ip,omitempty"`
	Process    string    `json:"process,omitempty"`
	ProcessID  string    `json:"process_id,omitempty"`
	// Actions são os direitos de acesso brutos do AccessMask (read, write, delete...).
	Actions    []string `json:"actions"`
	AccessMask string   `json:"access_mask,omitempty"`
	Outcome    string   `json:"outcome"` // success ou failure
	HandleID   string   `json:"handle_id,omitempty"`

	// Action é a ação lógica (ActionCreated, ActionDeleted...).
	Action string `json:"action,omitempty"`
	// NewPath é o destino de renomear, mover ou enviar para a Lixeira.
	NewPath string `json:"new_path,omitempty"`
	// ItemType é "file" ou "folder", quando o agente conseguiu identificar.
	ItemType string `json:"item_type,omitempty"`
	// Count é quantas operações iguais este evento representa (repetições
	// agregadas ou alteração de permissão em massa).
	Count int `json:"count,omitempty"`
	// EndTime é o horário da última operação agregada, quando Count > 1.
	EndTime *time.Time `json:"end_time,omitempty"`
	// RelatedRecords são outros RecordID do Event Log incorporados a este evento (ex.: o 4660 de uma exclusão).
	RelatedRecords []uint64 `json:"related_records,omitempty"`
	// Details traz informações extras: old_sd/new_sd (SDDL antes e depois),
	// sample (alguns caminhos de uma alteração em massa), destination_folder.
	Details map[string]string `json:"details,omitempty"`
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
