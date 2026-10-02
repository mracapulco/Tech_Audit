// Package source fornece os eventos brutos (XML) ao agente: do Security Event
// Log do Windows em produção, ou de um arquivo exportado para testes.
package source

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// Source entrega eventos em lotes. A posição (bookmark) é guardada pelo
// agente no buffer local, na mesma transação dos eventos já processados.
type Source interface {
	// Next devolve até max eventos em XML. Espera no máximo wait por eventos novos
	// e pode devolver um lote vazio. Retorna io.EOF quando a fonte acabou.
	Next(ctx context.Context, max int, wait time.Duration) ([][]byte, error)
	// Bookmark devolve a posição logo após o último evento devolvido por Next,
	// para retomar dali após um reinício. Vazio se a fonte não tem posição.
	Bookmark() (string, error)
	Close() error
}

// XPathQuery monta a consulta usada no EvtSubscribe para os IDs informados.
func XPathQuery(ids []int) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = fmt.Sprintf("EventID=%d", id)
	}
	return "*[System[(" + strings.Join(parts, " or ") + ")]]"
}

// File lê eventos de um XML exportado com
// `wevtutil qe Security /f:xml` ou "Salvar eventos como" > XML no Visualizador de Eventos.
type File struct {
	events [][]byte
	pos    int
}

// OpenFile carrega todos os elementos <Event> do arquivo.
func OpenFile(path string) (*File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	// wevtutil gera eventos concatenados sem elemento raiz; envolvemos para o decoder.
	wrapped := append(append([]byte("<root>"), data...), "</root>"...)
	d := xml.NewDecoder(bytes.NewReader(wrapped))
	f := &File{}
	for {
		off := d.InputOffset()
		tok, err := d.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "Event" {
			if err := d.Skip(); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			f.events = append(f.events, wrapped[off:d.InputOffset()])
		}
	}
	return f, nil
}

func (f *File) Next(_ context.Context, max int, _ time.Duration) ([][]byte, error) {
	if f.pos >= len(f.events) {
		return nil, io.EOF
	}
	end := min(f.pos+max, len(f.events))
	out := f.events[f.pos:end]
	f.pos = end
	return out, nil
}

func (f *File) Bookmark() (string, error) { return "", nil }
func (f *File) Close() error              { return nil }
