package event

import (
	"sort"
	"strconv"
	"strings"
)

// Bits de acesso de arquivo (FILE_* e direitos padrão) relevantes para auditoria.
var maskActions = []struct {
	bit    uint64
	action string
}{
	{0x00001, "read"},              // ReadData / ListDirectory
	{0x00002, "write"},             // WriteData / AddFile
	{0x00004, "append"},            // AppendData / AddSubdirectory
	{0x00020, "execute"},           // Execute / Traverse
	{0x00040, "delete_child"},      // DeleteChild
	{0x00100, "write_attributes"},  // WriteAttributes
	{0x00010, "write_attributes"},  // WriteEA
	{0x10000, "delete"},            // DELETE
	{0x40000, "permission_change"}, // WRITE_DAC
	{0x80000, "owner_change"},      // WRITE_OWNER
}

// Códigos %%NNNN usados no campo AccessList quando AccessMask não vem preenchido.
var accessListActions = map[string]string{
	"%%4416": "read",
	"%%4417": "write",
	"%%4418": "append",
	"%%4420": "write_attributes",
	"%%4421": "execute",
	"%%4422": "delete_child",
	"%%4424": "write_attributes",
	"%%1537": "delete",
	"%%1539": "permission_change",
	"%%1540": "owner_change",
}

// ActionsFromMask converte um AccessMask ("0x10080") em ações legíveis.
// Leituras de atributos, READ_CONTROL e SYNCHRONIZE são ignoradas por serem ruído.
func ActionsFromMask(mask string) []string {
	v, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(strings.TrimSpace(mask)), "0x"), 16, 64)
	if err != nil {
		return nil
	}
	set := map[string]bool{}
	for _, m := range maskActions {
		if v&m.bit != 0 {
			set[m.action] = true
		}
	}
	return sortedKeys(set)
}

// ActionsFromAccessList converte "%%4416 %%4417" em ações legíveis.
func ActionsFromAccessList(list string) []string {
	set := map[string]bool{}
	for _, tok := range strings.Fields(list) {
		if a, ok := accessListActions[tok]; ok {
			set[a] = true
		}
	}
	return sortedKeys(set)
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
