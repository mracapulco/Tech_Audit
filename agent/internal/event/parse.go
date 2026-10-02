package event

import (
	"encoding/xml"
	"fmt"
	"strings"
	"time"
)

// IDs de eventos de auditoria de acesso a objetos coletados pelo agente.
const (
	IDHandleRequest = 4656 // handle para objeto solicitado (inclui tentativas negadas)
	IDObjectAccess  = 4663 // tentativa de acesso a objeto
	IDObjectDeleted = 4660 // objeto excluído (só traz HandleId, sem caminho)
	IDShareAccess   = 5145 // acesso a arquivo via compartilhamento de rede (SMB)
)

// EventIDs lista os IDs coletados, na ordem usada na consulta XPath.
var EventIDs = []int{IDHandleRequest, IDObjectAccess, IDObjectDeleted, IDShareAccess}

// Bits do campo Keywords que indicam o resultado da auditoria.
const (
	keywordAuditFailure = 0x0010000000000000
	keywordAuditSuccess = 0x0020000000000000
)

type rawEvent struct {
	System struct {
		EventID     int `xml:"EventID"`
		Keywords    string
		TimeCreated struct {
			SystemTime string `xml:"SystemTime,attr"`
		}
		EventRecordID uint64
		Computer      string
	}
	Data []struct {
		Name  string `xml:"Name,attr"`
		Value string `xml:",chardata"`
	} `xml:"EventData>Data"`
}

// Raw é um evento já decodificado do XML, antes da normalização.
type Raw struct {
	EventID  int
	RecordID uint64
	Time     time.Time
	Computer string
	Keywords uint64
	Data     map[string]string
}

// ParseXML decodifica o XML de um único evento, como retornado por EvtRender
// ou pelo Visualizador de Eventos ("Detalhes" > "Exibição XML").
func ParseXML(b []byte) (*Raw, error) {
	var re rawEvent
	if err := xml.Unmarshal(b, &re); err != nil {
		return nil, fmt.Errorf("xml do evento inválido: %w", err)
	}
	t, err := time.Parse(time.RFC3339Nano, re.System.TimeCreated.SystemTime)
	if err != nil {
		return nil, fmt.Errorf("TimeCreated inválido %q: %w", re.System.TimeCreated.SystemTime, err)
	}
	var kw uint64
	fmt.Sscanf(strings.TrimPrefix(strings.ToLower(re.System.Keywords), "0x"), "%x", &kw)
	r := &Raw{
		EventID:  re.System.EventID,
		RecordID: re.System.EventRecordID,
		Time:     t.UTC(),
		Computer: re.System.Computer,
		Keywords: kw,
		Data:     make(map[string]string, len(re.Data)),
	}
	for _, d := range re.Data {
		r.Data[d.Name] = strings.TrimSpace(d.Value)
	}
	return r, nil
}

func outcome(kw uint64) string {
	if kw&keywordAuditFailure != 0 {
		return "failure"
	}
	return "success"
}

// cleanPath remove o prefixo NT "\??\" e normaliza o separador final.
func cleanPath(p string) string {
	p = strings.TrimPrefix(p, `\??\`)
	if len(p) > 3 { // mantém "C:\"
		p = strings.TrimRight(p, `\`)
	}
	return p
}

func joinShare(local, rel string) string {
	local = cleanPath(local)
	rel = strings.Trim(rel, `\`)
	if rel == "" {
		return local
	}
	if local == "" {
		return rel
	}
	return strings.TrimRight(local, `\`) + `\` + rel
}
