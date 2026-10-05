package perms

import (
	"context"
	"os"
	"path/filepath"

	"github.com/mracapulco/Tech_Audit/agent/internal/dirsize"
)

// Options limitam a varredura.
type Options struct {
	// MaxFolders é o máximo de pastas no inventário de um caminho. Padrão 5000.
	MaxFolders int
	// MaxDepth limita a profundidade abaixo do caminho (0 = sem limite).
	MaxDepth int
}

// DefaultMaxFolders é o limite padrão de pastas por caminho.
const DefaultMaxFolders = 5000

// Result é o inventário de um caminho auditado.
type Result struct {
	Folders []Folder
	// Scanned é o total de pastas lidas (inclusive as iguais à de cima).
	Scanned   int
	Truncated bool
	// Err é preenchido quando o próprio caminho não pôde ser lido.
	Err error
}

// Scan percorre o caminho e devolve as pastas com permissão própria, mais os
// compartilhamentos ligados a ele. Links simbólicos e junções não são
// seguidos. Roda em baixa prioridade no Windows.
func Scan(ctx context.Context, r Reader, root string, o Options) Result {
	if o.MaxFolders <= 0 {
		o.MaxFolders = DefaultMaxFolders
	}
	restore := dirsize.LowerPriority()
	defer restore()

	root = filepath.Clean(root)
	info, err := os.Stat(root)
	if err == nil && !info.IsDir() {
		err = errNotDir
	}
	if err != nil {
		return Result{Err: err}
	}
	f, err := r.Read(root)
	if err != nil {
		return Result{Err: err}
	}
	f.Path, f.Depth, f.Reason = root, 0, "root"
	s := &scanner{ctx: ctx, r: r, o: o, res: Result{Scanned: 1}}
	s.res.Folders = append(s.res.Folders, f)
	if shares, err := r.Shares(root); err == nil {
		for _, sh := range shares {
			sh.Source, sh.Reason = "share", "share"
			s.res.Folders = append(s.res.Folders, sh)
		}
	}
	s.walk(root, 0, &f, 0)
	if ctx.Err() != nil {
		s.res.Err = ctx.Err()
	}
	return s.res
}

type notDir struct{}

func (notDir) Error() string { return "não é uma pasta" }

var errNotDir error = notDir{}

type scanner struct {
	ctx context.Context
	r   Reader
	o   Options
	res Result
}

func (s *scanner) full() bool {
	if len(s.res.Folders) >= s.o.MaxFolders {
		s.res.Truncated = true
		return true
	}
	return false
}

// walk lê as subpastas de dir. parent é a permissão de dir; idx é a posição
// de dir na lista (-1 quando ele não entrou), para anotar erro de listagem.
func (s *scanner) walk(dir string, depth int, parent *Folder, idx int) {
	if s.ctx.Err() != nil || s.res.Truncated {
		return
	}
	if s.o.MaxDepth > 0 && depth >= s.o.MaxDepth {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		msg := "não foi possível listar as subpastas: " + err.Error()
		if idx >= 0 {
			s.res.Folders[idx].Error = msg
		} else if !s.full() {
			s.res.Folders = append(s.res.Folders, Folder{Path: dir, Depth: depth, Source: parent.Source, Reason: "error", Error: msg})
		}
		return
	}
	for _, e := range entries {
		if s.ctx.Err() != nil || s.res.Truncated {
			return
		}
		// Junções e links aparecem como não-pasta: ficam de fora.
		if !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		full := filepath.Join(dir, e.Name())
		s.res.Scanned++
		f, err := s.r.Read(full)
		if err != nil {
			if s.full() {
				return
			}
			s.res.Folders = append(s.res.Folders, Folder{Path: full, Depth: depth + 1, Source: parent.Source, Reason: "error", Error: "não foi possível ler as permissões: " + err.Error()})
			continue
		}
		f.Path, f.Depth = full, depth+1
		child := -1
		if reason := s.r.Differs(&f, parent); reason != "" {
			if s.full() {
				return
			}
			f.Reason = reason
			s.res.Folders = append(s.res.Folders, f)
			child = len(s.res.Folders) - 1
		}
		s.walk(full, depth+1, &f, child)
	}
}
