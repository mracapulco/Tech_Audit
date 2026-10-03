package auditd

import "os"

func fileIno(os.FileInfo) uint64 { return 0 }
