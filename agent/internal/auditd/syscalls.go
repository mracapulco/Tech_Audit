package auditd

// Números das chamadas de sistema que alteram ou abrem arquivos, por
// arquitetura (campo arch do SYSCALL). Com log_format = ENRICHED o próprio
// auditd informa o nome (SYSCALL=openat); a tabela serve para o formato RAW.
var syscallNames = map[string]map[uint64]string{
	"c000003e": { // x86_64
		2: "open", 85: "creat", 257: "openat", 437: "openat2",
		76: "truncate", 77: "ftruncate",
		82: "rename", 264: "renameat", 316: "renameat2",
		83: "mkdir", 258: "mkdirat", 84: "rmdir", 87: "unlink", 263: "unlinkat",
		86: "link", 265: "linkat", 88: "symlink", 266: "symlinkat", 133: "mknod", 259: "mknodat",
		90: "chmod", 91: "fchmod", 268: "fchmodat", 452: "fchmodat2",
		92: "chown", 93: "fchown", 94: "lchown", 260: "fchownat",
		188: "setxattr", 189: "lsetxattr", 190: "fsetxattr", 197: "removexattr", 198: "lremovexattr", 199: "fremovexattr",
		463: "setxattrat", 466: "removexattrat",
		132: "utime", 235: "utimes", 280: "utimensat", 261: "futimesat",
	},
	"c00000b7": { // aarch64
		56: "openat", 437: "openat2", 45: "truncate", 46: "ftruncate",
		38: "renameat", 276: "renameat2", 34: "mkdirat", 35: "unlinkat",
		37: "linkat", 36: "symlinkat", 33: "mknodat",
		52: "fchmod", 53: "fchmodat", 452: "fchmodat2", 55: "fchown", 54: "fchownat",
		5: "setxattr", 6: "lsetxattr", 7: "fsetxattr", 14: "removexattr", 15: "lremovexattr", 16: "fremovexattr",
		463: "setxattrat", 466: "removexattrat",
		88: "utimensat",
	},
	"40000003": { // i386 (programas 32 bits)
		5: "open", 8: "creat", 295: "openat", 437: "openat2",
		92: "truncate", 93: "ftruncate", 193: "truncate64", 194: "ftruncate64",
		38: "rename", 302: "renameat", 353: "renameat2",
		39: "mkdir", 296: "mkdirat", 40: "rmdir", 10: "unlink", 301: "unlinkat",
		9: "link", 303: "linkat", 83: "symlink", 304: "symlinkat", 14: "mknod", 297: "mknodat",
		15: "chmod", 94: "fchmod", 306: "fchmodat", 452: "fchmodat2",
		182: "chown", 95: "fchown", 16: "lchown", 212: "chown32", 207: "fchown32", 198: "lchown32", 298: "fchownat",
		226: "setxattr", 227: "lsetxattr", 228: "fsetxattr", 235: "removexattr", 236: "lremovexattr", 237: "fremovexattr",
		30: "utime", 271: "utimes", 320: "utimensat", 299: "futimesat",
	},
}

// Classes de chamada, que definem a ação.
const (
	opOpen     = "open"
	opTruncate = "truncate"
	opRename   = "rename"
	opMkdir    = "mkdir"
	opDelete   = "delete"
	opCreate   = "create" // link, symlink, mknod
	opChmod    = "chmod"
	opChown    = "chown"
	opXattr    = "xattr"
	opUtime    = "utime"
)

var syscallClass = map[string]string{
	"open": opOpen, "creat": opOpen, "openat": opOpen, "openat2": opOpen,
	"truncate": opTruncate, "ftruncate": opTruncate, "truncate64": opTruncate, "ftruncate64": opTruncate,
	"rename": opRename, "renameat": opRename, "renameat2": opRename,
	"mkdir": opMkdir, "mkdirat": opMkdir,
	"rmdir": opDelete, "unlink": opDelete, "unlinkat": opDelete,
	"link": opCreate, "linkat": opCreate, "symlink": opCreate, "symlinkat": opCreate, "mknod": opCreate, "mknodat": opCreate,
	"chmod": opChmod, "fchmod": opChmod, "fchmodat": opChmod, "fchmodat2": opChmod,
	"chown": opChown, "fchown": opChown, "lchown": opChown, "fchownat": opChown,
	"chown32": opChown, "fchown32": opChown, "lchown32": opChown,
	"setxattr": opXattr, "lsetxattr": opXattr, "fsetxattr": opXattr, "setxattrat": opXattr,
	"removexattr": opXattr, "lremovexattr": opXattr, "fremovexattr": opXattr, "removexattrat": opXattr,
	"utime": opUtime, "utimes": opUtime, "utimensat": opUtime, "futimesat": opUtime,
}

// dirfdArg é o argumento com a pasta de referência (dirfd) do caminho de
// cada chamada *at. As demais chamadas com caminho usam a pasta atual.
var dirfdArg = map[string]string{
	"openat": "a0", "openat2": "a0", "mkdirat": "a0", "unlinkat": "a0", "mknodat": "a0",
	"fchmodat": "a0", "fchmodat2": "a0", "fchownat": "a0", "utimensat": "a0", "futimesat": "a0",
	"setxattrat": "a0", "removexattrat": "a0",
	"renameat": "a0", "renameat2": "a0", "linkat": "a0", "symlinkat": "a1",
}

// newDirfdArg é o dirfd do caminho novo em renameat/linkat.
var newDirfdArg = map[string]string{"renameat": "a2", "renameat2": "a2", "linkat": "a2", "symlinkat": "a1"}

// pathless são chamadas sobre um descritor já aberto, sem caminho.
var pathless = map[string]bool{
	"ftruncate": true, "ftruncate64": true, "fchmod": true, "fchown": true, "fchown32": true,
	"fsetxattr": true, "fremovexattr": true,
}
