package perms

import (
	"errors"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"

	"github.com/mracapulco/Tech_Audit/agent/internal/samba"
)

// linuxReader lê dono, grupo, modo e ACL POSIX de cada pasta e o acesso dos
// compartilhamentos do Samba.
type linuxReader struct {
	mu     sync.Mutex
	users  map[uint32]string
	groups map[uint32]string
}

// NewReader devolve o leitor do sistema.
func NewReader() (Reader, error) {
	return &linuxReader{users: map[uint32]string{}, groups: map[uint32]string{}}, nil
}

func (r *linuxReader) Read(path string) (Folder, error) {
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		return Folder{}, err
	}
	info := PosixInfo{UID: st.Uid, GID: st.Gid, Mode: st.Mode & 0o7777}
	var err error
	if info.Access, err = readACL(path, "system.posix_acl_access"); err != nil {
		return Folder{}, err
	}
	if info.Default, err = readACL(path, "system.posix_acl_default"); err != nil {
		return Folder{}, err
	}
	return FromPosix(info, r), nil
}

// readACL devolve nil quando a pasta não tem ACL ou o sistema de arquivos
// não usa ACL.
func readACL(path, attr string) ([]ACLEntry, error) {
	buf := make([]byte, 1024)
	for {
		n, err := unix.Getxattr(path, attr, buf)
		switch {
		case errors.Is(err, unix.ERANGE):
			buf = make([]byte, len(buf)*4)
			continue
		case errors.Is(err, unix.ENODATA), errors.Is(err, unix.ENOTSUP), errors.Is(err, unix.EOPNOTSUPP):
			return nil, nil
		case err != nil:
			return nil, err
		}
		return ParseACL(buf[:n])
	}
}

func (r *linuxReader) Differs(child, parent *Folder) string { return DiffersPosix(child, parent) }

// User traduz o uid; contas do domínio (SSSD, winbind) vêm pelo getent.
func (r *linuxReader) User(uid uint32) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n, ok := r.users[uid]; ok {
		return n
	}
	id := strconv.FormatUint(uint64(uid), 10)
	n := id
	if u, err := user.LookupId(id); err == nil {
		n = u.Username
	} else if s := getent("passwd", id); s != "" {
		n = s
	}
	r.users[uid] = n
	return n
}

// Group traduz o gid.
func (r *linuxReader) Group(gid uint32) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n, ok := r.groups[gid]; ok {
		return n
	}
	id := strconv.FormatUint(uint64(gid), 10)
	n := id
	if g, err := user.LookupGroupId(id); err == nil {
		n = g.Name
	} else if s := getent("group", id); s != "" {
		n = s
	}
	r.groups[gid] = n
	return n
}

func getent(db, id string) string {
	out, err := exec.Command("getent", db, id).Output()
	if err != nil {
		return ""
	}
	name, _, _ := strings.Cut(strings.TrimSpace(string(out)), ":")
	return name
}

// Shares lista os compartilhamentos do Samba ligados ao caminho.
func (r *linuxReader) Shares(root string) ([]Folder, error) {
	if _, err := exec.LookPath("testparm"); err != nil {
		return nil, nil // Samba não instalado
	}
	out, err := exec.Command("testparm", "-s", "--suppress-prompt").Output()
	if err != nil {
		return nil, err
	}
	var folders []Folder
	for _, sh := range samba.ParseTestparm(string(out)) {
		if sh.Overlaps(root) {
			folders = append(folders, FromSamba(sh))
		}
	}
	return folders, nil
}
