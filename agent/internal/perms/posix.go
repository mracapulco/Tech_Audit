package perms

import (
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

// Permissões no Linux: dono, grupo e outros do modo da pasta, mais a ACL
// POSIX (setfacl), lida dos atributos system.posix_acl_access e
// system.posix_acl_default. Sem chamadas ao sistema, para testar em qualquer lugar.

// Marcadores das entradas da ACL (linux/posix_acl_xattr.h).
const (
	aclUserObj  = 0x01
	aclUser     = 0x02
	aclGroupObj = 0x04
	aclGroup    = 0x08
	aclMask     = 0x10
	aclOther    = 0x20
)

// ACLEntry é uma entrada da ACL POSIX.
type ACLEntry struct {
	Tag  uint16
	Perm uint16 // bits rwx (4, 2, 1)
	ID   uint32
}

// ParseACL lê o valor binário de system.posix_acl_access/default.
func ParseACL(b []byte) ([]ACLEntry, error) {
	if len(b) == 0 {
		return nil, nil
	}
	if len(b) < 4 || (len(b)-4)%8 != 0 {
		return nil, errors.New("ACL com tamanho inválido")
	}
	if v := binary.LittleEndian.Uint32(b); v != 2 {
		return nil, fmt.Errorf("versão de ACL desconhecida: %d", v)
	}
	var out []ACLEntry
	for p := 4; p < len(b); p += 8 {
		out = append(out, ACLEntry{
			Tag:  binary.LittleEndian.Uint16(b[p:]),
			Perm: binary.LittleEndian.Uint16(b[p+2:]) & 7,
			ID:   binary.LittleEndian.Uint32(b[p+4:]),
		})
	}
	return out, nil
}

// Names traduz uid e gid em nomes.
type Names interface {
	User(uid uint32) string
	Group(gid uint32) string
}

// PosixInfo é o que o sistema informa de uma pasta.
type PosixInfo struct {
	UID, GID uint32
	Mode     uint32 // bits de permissão (0777)
	Access   []ACLEntry
	Default  []ACLEntry
}

// rwx escreve os bits como o ls (r-x).
func rwx(p uint16) string {
	b := []byte("---")
	if p&4 != 0 {
		b[0] = 'r'
	}
	if p&2 != 0 {
		b[1] = 'w'
	}
	if p&1 != 0 {
		b[2] = 'x'
	}
	return string(b)
}

// PosixLabel dá o nome da permissão de uma pasta: ler a lista exige r e x;
// criar, renomear e excluir dentro dela exige w e x.
func PosixLabel(p uint16) string {
	switch p & 7 {
	case 7:
		return "Leitura e gravação"
	case 5:
		return "Leitura"
	case 1:
		return "Somente atravessar"
	case 0:
		return "Sem acesso"
	default:
		return "Especial"
	}
}

const (
	appliesPosix    = "Somente esta pasta"
	appliesNewItems = "Novos itens criados dentro (ACL padrão)"
)

// FromPosix monta a pasta a partir do dono, grupo, modo e ACLs.
func FromPosix(info PosixInfo, names Names) Folder {
	f := Folder{Source: "posix", Owner: names.User(info.UID)}
	if len(info.Access) == 0 {
		f.Entries = []Entry{
			posixEntry(names.User(info.UID)+" (dono)", fmt.Sprintf("uid:%d", info.UID), "user", uint16(info.Mode>>6), appliesPosix),
			posixEntry(names.Group(info.GID)+" (grupo dono)", fmt.Sprintf("gid:%d", info.GID), "group", uint16(info.Mode>>3), appliesPosix),
			posixEntry("Todos os outros", "", "other", uint16(info.Mode), appliesPosix),
		}
	} else {
		f.Entries = aclEntries(info.Access, info.UID, info.GID, names, appliesPosix)
	}
	f.Entries = append(f.Entries, aclEntries(info.Default, info.UID, info.GID, names, appliesNewItems)...)
	f.sig = posixSig(info)
	return f
}

func posixEntry(name, id, kind string, perm uint16, applies string) Entry {
	perm &= 7
	return Entry{Principal: name, SID: id, Kind: kind, Access: "allow", Rights: PosixLabel(perm), Raw: rwx(perm), AppliesTo: applies}
}

// aclEntries aplica a máscara (o máximo que usuários nomeados e grupos podem
// ter) e devolve as permissões efetivas.
func aclEntries(acl []ACLEntry, uid, gid uint32, names Names, applies string) []Entry {
	mask := uint16(7)
	for _, e := range acl {
		if e.Tag == aclMask {
			mask = e.Perm
		}
	}
	// Na ACL padrão, dono e grupo são os de quem criar o item novo.
	owner, ownerID := names.User(uid)+" (dono)", fmt.Sprintf("uid:%d", uid)
	group, groupID, groupKind := names.Group(gid)+" (grupo dono)", fmt.Sprintf("gid:%d", gid), "group"
	if applies == appliesNewItems {
		// Não é um grupo de verdade: é o grupo que o item novo receber.
		owner, ownerID, group, groupID, groupKind = "Dono do item novo", "", "Grupo do item novo", "", "other"
	}
	var out []Entry
	for _, e := range acl {
		switch e.Tag {
		case aclUserObj:
			out = append(out, posixEntry(owner, ownerID, "user", e.Perm, applies))
		case aclUser:
			out = append(out, posixEntry(names.User(e.ID), fmt.Sprintf("uid:%d", e.ID), "user", e.Perm&mask, applies))
		case aclGroupObj:
			out = append(out, posixEntry(group, groupID, groupKind, e.Perm&mask, applies))
		case aclGroup:
			out = append(out, posixEntry(names.Group(e.ID), fmt.Sprintf("gid:%d", e.ID), "group", e.Perm&mask, applies))
		case aclOther:
			out = append(out, posixEntry("Todos os outros", "", "other", e.Perm, applies))
		}
	}
	return out
}

func posixSig(info PosixInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d:%d:%o", info.UID, info.GID, info.Mode&0o7777)
	for _, e := range info.Access {
		fmt.Fprintf(&b, ";a%d.%d.%d", e.Tag, e.ID, e.Perm)
	}
	for _, e := range info.Default {
		fmt.Fprintf(&b, ";d%d.%d.%d", e.Tag, e.ID, e.Perm)
	}
	return b.String()
}

// DiffersPosix: no Linux não há herança; a pasta entra quando dono, grupo,
// modo ou ACL são diferentes da pasta de cima.
func DiffersPosix(child, parent *Folder) string {
	if child.sig != parent.sig {
		return "changed"
	}
	return ""
}

// parseGroupLine lê uma linha do getent group: nome:x:gid:membro1,membro2.
func parseGroupLine(line string) (name, gid string, members []string) {
	f := strings.SplitN(line, ":", 4)
	if len(f) < 3 {
		return line, "", nil
	}
	name, gid = f[0], f[2]
	if len(f) == 4 && f[3] != "" {
		for _, m := range strings.Split(f[3], ",") {
			if m = strings.TrimSpace(m); m != "" {
				members = append(members, m)
			}
		}
	}
	return name, gid, members
}
