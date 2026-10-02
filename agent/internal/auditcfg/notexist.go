package auditcfg

import (
	"errors"
	"io/fs"
)

func isNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
