package auditd

import (
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
)

// FileKey identifica um arquivo pelo dispositivo ("fd:01", como no campo
// dev do auditd) e inode.
type FileKey struct {
	Dev string
	Ino uint64
}

func (k FileKey) zero() bool { return k.Dev == "" && k.Ino == 0 }

// DirMap guarda as pastas dos caminhos auditados por inode. O kernel nem
// sempre registra o caminho completo: chamadas como unlinkat(dirfd, "x")
// (rm -r, tar, find -delete) trazem só o nome e o inode da pasta. O mapa é
// montado varrendo as pastas e atualizado com as criações, renomeações e
// exclusões vistas no log.
type DirMap struct {
	// Stat devolve a chave de um caminho sem seguir links; substituível nos testes.
	Stat func(path string) (FileKey, bool, error)

	mu    sync.Mutex
	nodes map[FileKey]dirNode
	// files são arquivos vistos há pouco (criados, renomeados), para as
	// chamadas sobre um descritor aberto (fchmod, fchown) logo depois.
	files map[FileKey]string
}

type dirNode struct {
	parent FileKey
	name   string
	root   string // caminho completo, só nas raízes da varredura
}

const (
	maxFiles     = 50000
	maxPathDepth = 4096
)

// Path devolve o caminho completo de uma pasta conhecida.
func (m *DirMap) Path(k FileKey) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.path(k)
}

func (m *DirMap) path(k FileKey) (string, bool) {
	var parts []string
	for range maxPathDepth {
		n, ok := m.nodes[k]
		if !ok {
			return "", false
		}
		if n.root != "" {
			for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
				parts[i], parts[j] = parts[j], parts[i]
			}
			return filepath.Join(append([]string{n.root}, parts...)...), true
		}
		parts = append(parts, n.name)
		k = n.parent
	}
	return "", false
}

// AddDir registra uma pasta criada (ou que chegou) em parent com o nome name.
func (m *DirMap) AddDir(k, parent FileKey, name string) {
	if k.zero() || name == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.nodes == nil {
		m.nodes = map[FileKey]dirNode{}
	}
	if n, ok := m.nodes[k]; ok && n.root != "" {
		return // a raiz auditada continua com o caminho configurado
	}
	m.nodes[k] = dirNode{parent: parent, name: name}
}

// AddRoot registra uma pasta pelo caminho completo.
func (m *DirMap) AddRoot(k FileKey, path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.nodes == nil {
		m.nodes = map[FileKey]dirNode{}
	}
	m.nodes[k] = dirNode{root: filepath.Clean(path)}
}

// Remove esquece uma pasta excluída.
func (m *DirMap) Remove(k FileKey) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if n, ok := m.nodes[k]; ok && n.root == "" {
		delete(m.nodes, k)
	}
}

// Known diz se a pasta está no mapa.
func (m *DirMap) Known(k FileKey) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.nodes[k]
	return ok
}

// RememberFile guarda o caminho de um arquivo visto há pouco.
func (m *DirMap) RememberFile(k FileKey, path string) {
	if k.zero() || path == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.files == nil || len(m.files) >= maxFiles {
		m.files = map[FileKey]string{}
	}
	m.files[k] = path
}

// ForgetFile esquece um arquivo excluído.
func (m *DirMap) ForgetFile(k FileKey) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.files, k)
}

// File devolve o caminho de um arquivo visto há pouco.
func (m *DirMap) File(k FileKey) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.files[k]
	return p, ok
}

// FindChild procura, entre as pastas conhecidas (no máximo limit), a que
// contém um item chamado name com a chave k. Último recurso para um caminho
// relativo a um descritor de pasta que o log não identifica.
func (m *DirMap) FindChild(name string, k FileKey, limit int) (string, bool) {
	if m.Stat == nil || name == "" || strings.Contains(name, "/") {
		return "", false
	}
	m.mu.Lock()
	var dirs []string
	for key := range m.nodes {
		if len(dirs) >= limit {
			break
		}
		if p, ok := m.path(key); ok {
			dirs = append(dirs, p)
		}
	}
	m.mu.Unlock()
	for _, d := range dirs {
		full := filepath.Join(d, name)
		if got, _, err := m.Stat(full); err == nil && got == k {
			return full, true
		}
	}
	return "", false
}

// Size é a quantidade de pastas no mapa.
func (m *DirMap) Size() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.nodes)
}

// Scan refaz o mapa varrendo as raízes (só pastas, sem seguir links).
// Pastas sem permissão de leitura ficam de fora.
func (m *DirMap) Scan(roots []string, stop func() bool) error {
	if m.Stat == nil {
		return nil
	}
	nodes := map[FileKey]dirNode{}
	for _, root := range roots {
		root = filepath.Clean(root)
		rk, isDir, err := m.Stat(root)
		if err != nil || !isDir {
			continue
		}
		nodes[rk] = dirNode{root: root}
		keys := map[string]FileKey{root: rk}
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if stop != nil && stop() {
				return filepath.SkipAll
			}
			if err != nil || !d.IsDir() || p == root {
				if err != nil && d != nil && d.IsDir() && p != root {
					return filepath.SkipDir
				}
				return nil
			}
			k, _, err := m.Stat(p)
			if err != nil {
				return filepath.SkipDir
			}
			parent, ok := keys[filepath.Dir(p)]
			if !ok {
				return filepath.SkipDir
			}
			keys[p] = k
			if _, exists := nodes[k]; !exists {
				nodes[k] = dirNode{parent: parent, name: filepath.Base(p)}
			}
			return nil
		})
	}
	m.mu.Lock()
	m.nodes = nodes
	m.mu.Unlock()
	return nil
}
