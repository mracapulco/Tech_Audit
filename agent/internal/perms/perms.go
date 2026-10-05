// Package perms faz o inventário de permissões das pastas auditadas: quem tem
// acesso a cada pasta e com qual permissão (recurso do plano Enterprise).
//
// No Windows lê o dono e a DACL (NTFS) de cada pasta e as permissões dos
// compartilhamentos; no Linux lê dono, grupo, modo, ACL POSIX e os
// parâmetros de acesso dos compartilhamentos do Samba.
//
// Para o relatório não repetir a mesma permissão em milhares de subpastas,
// entram a pasta auditada e só as subpastas cuja permissão é diferente da
// pasta de cima (no Windows: com entrada explícita ou herança desligada).
package perms

// Entry é uma permissão: quem, o quê e onde vale.
type Entry struct {
	// Principal é o usuário ou grupo (DOMINIO\nome no Windows; nome no Linux).
	Principal string `json:"principal"`
	// SID no Windows; uid:N ou gid:N no Linux.
	SID string `json:"sid,omitempty"`
	// Kind: user, group, other (todos os outros no Linux) ou unknown.
	Kind string `json:"kind"`
	// Access: allow ou deny.
	Access string `json:"access"`
	// Rights é o nome da permissão (Controle total, Modificar, Leitura...).
	Rights string `json:"rights"`
	// Raw é a máscara de acesso (0x1301bf) ou os bits rwx.
	Raw       string `json:"raw"`
	Inherited bool   `json:"inherited"`
	// AppliesTo diz onde a entrada vale (esta pasta, subpastas e arquivos...).
	AppliesTo string `json:"applies_to"`
}

// Folder é uma pasta (ou compartilhamento) com as permissões dela.
type Folder struct {
	Path string `json:"path"`
	// Depth abaixo do caminho auditado (0 = o próprio caminho).
	Depth int `json:"depth"`
	// Source: ntfs, posix ou share.
	Source string `json:"source"`
	// Share é o nome do compartilhamento (Source share).
	Share string `json:"share,omitempty"`
	Owner string `json:"owner,omitempty"`
	// Protected: herança desligada (Windows).
	Protected bool `json:"protected,omitempty"`
	// Reason por que a pasta entrou: root, explicit, protected, changed, share.
	Reason  string  `json:"reason"`
	Entries []Entry `json:"entries"`
	Error   string  `json:"error,omitempty"`

	// sig resume a permissão no Linux, para comparar com a pasta de cima.
	sig string
}

// Reader lê as permissões de uma pasta no sistema.
type Reader interface {
	Read(path string) (Folder, error)
	// Differs diz se a pasta tem permissão própria, diferente da de cima.
	// Devolve o motivo (explicit, protected, changed) ou "".
	Differs(child, parent *Folder) string
	// Shares devolve os compartilhamentos ligados ao caminho (o próprio
	// caminho, uma pasta acima dele ou dentro dele).
	Shares(root string) ([]Folder, error)
}
