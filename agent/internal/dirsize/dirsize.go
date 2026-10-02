// Package dirsize mede o tamanho dos diretórios auditados, base do volume da
// licença (docs/ARCHITECTURE.md, seção 9.2). Caminhos aninhados são medidos
// na mesma varredura do caminho de cima, sem ler o disco duas vezes.
package dirsize

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Result é o tamanho de um caminho: soma dos arquivos, recursivamente.
type Result struct {
	Bytes int64
	Files int64
	// Pastas que não puderam ser lidas (ex.: acesso negado) ficam de fora da soma.
	Skipped int64
	// Err é preenchido quando o próprio caminho não pôde ser lido.
	Err error
}

// Measure mede cada caminho. Links simbólicos e junções não são seguidos,
// para não contar a mesma pasta duas vezes nem entrar em ciclos.
func Measure(ctx context.Context, paths []string) map[string]*Result {
	out := make(map[string]*Result, len(paths))
	byKey := map[string]*Result{}
	keys := []string{}
	for _, p := range paths {
		k := key(p)
		if r, ok := byKey[k]; ok {
			out[p] = r
			continue
		}
		r := &Result{}
		byKey[k] = r
		out[p] = r
		keys = append(keys, k)
	}
	sort.Strings(keys)

	restore := lowerPriority()
	defer restore()
	for _, k := range keys {
		if isNested(k, keys) {
			continue
		}
		root := byKey[k]
		info, err := os.Stat(k)
		if err == nil && !info.IsDir() {
			err = errors.New("não é uma pasta")
		}
		if err != nil {
			root.Err = err
			for _, n := range keys {
				if n != k && within(n, k) {
					byKey[n].Err = err
				}
			}
			continue
		}
		w := walker{ctx: ctx, nested: byKey}
		w.walk(k, []*Result{root}, root)
		if ctx.Err() != nil {
			for _, r := range byKey {
				if r.Err == nil {
					r.Err = ctx.Err()
				}
			}
			return out
		}
	}
	return out
}

type walker struct {
	ctx    context.Context
	nested map[string]*Result
}

// walk soma os arquivos de dir em todos os acumuladores: o do caminho raiz e
// os de caminhos aninhados já encontrados no trajeto. self é o resultado do
// próprio dir, quando ele é um caminho medido.
func (w *walker) walk(dir string, accs []*Result, self *Result) {
	if w.ctx.Err() != nil {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if self != nil {
			self.Err = err
		}
		for _, a := range accs {
			if a != self {
				a.Skipped++
			}
		}
		return
	}
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		switch {
		case e.IsDir():
			next, sub := accs, w.nested[key(full)]
			if sub != nil {
				next = append(append([]*Result{}, accs...), sub)
			}
			w.walk(full, next, sub)
		case e.Type().IsRegular():
			info, err := e.Info()
			if err != nil {
				continue
			}
			for _, a := range accs {
				a.Bytes += info.Size()
				a.Files++
			}
		}
	}
}

// key normaliza para comparar caminhos; no Windows sem diferenciar
// maiúsculas, como o NTFS.
func key(p string) string {
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

func within(child, parent string) bool {
	if child == parent {
		return true
	}
	if !strings.HasSuffix(parent, string(filepath.Separator)) {
		parent += string(filepath.Separator)
	}
	return strings.HasPrefix(child, parent)
}

func isNested(k string, keys []string) bool {
	for _, o := range keys {
		if o != k && within(k, o) {
			return true
		}
	}
	return false
}
