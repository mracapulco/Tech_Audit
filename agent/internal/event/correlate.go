package event

import (
	"encoding/json"
	"hash/fnv"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// FS consulta o sistema de arquivos local para completar o que o log de
// Segurança não informa (se o caminho é pasta, nome novo após renomear,
// destino na Lixeira). Implementado em internal/fsinfo.
type FS interface {
	Stat(path string) (FileInfo, error)
	// ListDir lista até max itens da pasta, com os horários de cada um.
	ListDir(dir string, max int) ([]DirEntry, error)
	// RecycleBinFind procura na Lixeira do usuário (sid) um item excluído a
	// partir de since cujo caminho original é path, e devolve onde ele está.
	RecycleBinFind(path, sid string, since time.Time) (string, bool)
}

// FileInfo traz os horários do NTFS. Changed (ChangeTime) muda também ao
// renomear ou mover; Modified só muda quando o conteúdo é escrito.
type FileInfo struct {
	IsDir    bool
	Created  time.Time
	Modified time.Time
	Changed  time.Time
}

// DirEntry é um item de ListDir.
type DirEntry struct {
	Name string
	FileInfo
}

// CorrelationConfig ajusta as janelas de tempo da correlação.
type CorrelationConfig struct {
	// Window é quanto se espera por eventos relacionados (o 4660 de uma
	// exclusão, a pasta de destino de um renomear). Padrão 3s.
	Window time.Duration `json:"window"`
	// AggregateWindow junta repetições da mesma ação do mesmo usuário no mesmo
	// caminho em um só evento com contagem. Padrão 60s.
	AggregateWindow time.Duration `json:"aggregate_window"`
	// BulkThreshold: alterações de permissão ou dono feitas pelo mesmo
	// processo em sequência viram um único evento a partir desta quantidade. Padrão 10.
	BulkThreshold int `json:"bulk_threshold"`
	// BulkGap é o intervalo máximo entre duas alterações da mesma sequência. Padrão 5s.
	BulkGap time.Duration `json:"bulk_gap"`
	// MaxHandles limita o cache HandleId -> caminho usado pelo 4660. Padrão 10000.
	MaxHandles int `json:"max_handles"`
	// IgnoreProcessID descarta eventos do próprio agente (ex.: "0x1a2b"), que
	// lê horários e pastas e poderia gerar eventos de leitura em loop.
	IgnoreProcessID string `json:"-"`
}

func (c *CorrelationConfig) defaults() {
	if c.Window <= 0 {
		c.Window = 3 * time.Second
	}
	if c.AggregateWindow <= 0 {
		c.AggregateWindow = time.Minute
	}
	if c.BulkThreshold <= 0 {
		c.BulkThreshold = 10
	}
	if c.BulkGap <= 0 {
		c.BulkGap = 5 * time.Second
	}
	if c.MaxHandles <= 0 {
		c.MaxHandles = 10000
	}
}

const (
	maxDirScan    = 50000 // itens lidos por pasta ao procurar o arquivo criado ou renomeado
	maxBulkSample = 5
	clockSlack    = 2 * time.Second // diferença aceitável entre o horário do evento e os horários do NTFS
	logonIPTTL    = 24 * time.Hour
	maxLogonIPs   = 10000
	createdTTL    = 5 * time.Minute
)

// Correlator transforma a sequência de eventos brutos do Windows em ações
// lógicas: junta 4663 DELETE + 4660 em uma exclusão, identifica criação,
// renomear, mover e envio para a Lixeira, agrega repetições e alterações de
// permissão em massa.
//
// Alguns eventos ficam pendentes por alguns segundos esperando os eventos
// relacionados. O estado (pendentes e cache de handles) é serializável com
// State/LoadState e gravado junto com o bookmark do Event Log, para nada se
// perder num reinício.
type Correlator struct {
	cfg    CorrelationConfig
	filter Filter
	fs     FS
	st     corrState
}

type corrState struct {
	Clock    time.Time            `json:"clock"`
	Handles  []handleEntry        `json:"handles"`
	Pending  []*pending           `json:"pending"`
	LogonIPs map[string]logonIP   `json:"logon_ips"`
	Created  map[string]time.Time `json:"created"` // caminho (minúsculas) -> horário em que foi informado como criado
	handles  map[string]string
	idx      map[string]*pending // tipo+chave -> pendência ainda não consumida
	due      time.Time           // limite inferior do próximo prazo; zero = desconhecido
}

type handleEntry struct {
	Key  string `json:"k"`
	Path string `json:"p"`
}

type logonIP struct {
	IP   string    `json:"ip"`
	Seen time.Time `json:"seen"`
}

// Tipos de pendência.
const (
	pendDelete   = "delete"   // 4663 com DELETE: espera o 4660 ou descobre renomear/mover/Lixeira
	pendDirWrite = "dirwrite" // escrita numa pasta: um item foi criado (ou chegou) nela
	pendAgg      = "agg"      // repetições sendo agregadas
	pendBulk     = "bulk"     // alterações de permissão/dono em sequência
)

type pending struct {
	Type     string    `json:"type"`
	Key      string    `json:"key"`
	Deadline time.Time `json:"deadline"`
	Event    Event     `json:"event"`
	Consumed bool      `json:"consumed,omitempty"`
	// Somente delete: o 4660 confirmou a exclusão do objeto.
	Deleted bool `json:"deleted,omitempty"`
	// Somente bulk: itens individuais enquanto não passam do limite.
	Items   []Event         `json:"items,omitempty"`
	Total   int             `json:"total,omitempty"`
	Samples []string        `json:"samples,omitempty"`
	Root    string          `json:"root,omitempty"`
	Seen    map[string]bool `json:"seen,omitempty"` // hash dos caminhos já contados
}

// NewCorrelator cria um Correlator. fs pode ser nil (sem consultas ao disco:
// criação, renomear e Lixeira não são identificados).
func NewCorrelator(cfg CorrelationConfig, f Filter, fs FS) *Correlator {
	cfg.defaults()
	c := &Correlator{cfg: cfg, filter: f, fs: fs}
	c.st.reset()
	return c
}

func (s *corrState) reset() {
	*s = corrState{LogonIPs: map[string]logonIP{}, Created: map[string]time.Time{}, handles: map[string]string{}}
	s.reindex()
}

func (s *corrState) reindex() {
	s.idx = make(map[string]*pending, len(s.Pending))
	for _, p := range s.Pending {
		if !p.Consumed {
			s.idx[p.Type+"\x00"+p.Key] = p
		}
	}
}

// State serializa o estado para ser gravado junto com o bookmark.
func (c *Correlator) State() ([]byte, error) {
	c.prune()
	return json.Marshal(&c.st)
}

// LoadState restaura um estado gravado por State.
func (c *Correlator) LoadState(b []byte) error {
	var st corrState
	if err := json.Unmarshal(b, &st); err != nil {
		return err
	}
	if st.LogonIPs == nil {
		st.LogonIPs = map[string]logonIP{}
	}
	if st.Created == nil {
		st.Created = map[string]time.Time{}
	}
	st.handles = make(map[string]string, len(st.Handles))
	for _, h := range st.Handles {
		st.handles[h.Key] = h.Path
	}
	st.reindex()
	c.st = st
	return nil
}

// Pending informa quantos eventos estão aguardando correlação.
func (c *Correlator) Pending() int { return len(c.st.Pending) }

// Add processa um evento (na ordem do log) e devolve os eventos lógicos prontos para envio.
func (c *Correlator) Add(ev Event) []Event {
	if ev.Time.After(c.st.Clock) {
		c.st.Clock = ev.Time
	}
	var out []Event
	c.add(ev, &out)
	c.expire(c.st.Clock, &out)
	return sortByTime(out)
}

// Tick resolve as pendências vencidas até now. Chamado quando não chegam
// eventos novos, com o relógio da máquina.
func (c *Correlator) Tick(now time.Time) []Event {
	if now.After(c.st.Clock) {
		c.st.Clock = now
	}
	var out []Event
	c.expire(c.st.Clock, &out)
	return sortByTime(out)
}

// Flush resolve todas as pendências (fim de um arquivo de replay).
func (c *Correlator) Flush() []Event {
	var out []Event
	c.expire(time.Unix(1<<62, 0), &out)
	return sortByTime(out)
}

func (c *Correlator) add(ev Event, out *[]Event) {
	if c.cfg.IgnoreProcessID != "" && strings.EqualFold(ev.ProcessID, c.cfg.IgnoreProcessID) {
		return
	}
	key := handleKey(ev)
	if ev.EventID == IDShareSession || ev.EventID == IDShareAccess {
		c.rememberIP(ev)
		if ev.EventID == IDShareSession || ev.Outcome == "success" {
			return // sessão SMB e acesso detalhado bem-sucedido só servem para o IP de origem
		}
	}
	if ev.Outcome == "failure" {
		ev.Action = ActionDenied
		c.aggregate(ev, out)
		return
	}

	switch ev.EventID {
	case IDHandleRequest:
		c.rememberHandle(key, ev.Path) // o 4663 seguinte traz a ação
	case IDObjectDeleted:
		if p := c.find(pendDelete, key); p != nil {
			// Resolvido no fim da janela: o Explorer abre o item mais de uma
			// vez ao mandar para a Lixeira, e o Windows registra o 4660 numa
			// das aberturas.
			p.Deleted = true
			p.Event.RelatedRecords = append(p.Event.RelatedRecords, ev.RecordID)
			return
		}
		ev.Path = c.st.handles[key]
		ev.Action = ActionDeleted
		c.emit(ev, out)
	case IDPermsChanged:
		c.rememberHandle(key, ev.Path)
		if c.permsOnCreate(ev) || c.createdWithPerms(ev, out) {
			return
		}
		ev.Action = ActionPermissionChanged
		c.bulk(ev, out)
	case IDObjectAccess:
		c.rememberHandle(key, ev.Path)
		acts := map[string]bool{}
		for _, a := range ev.Actions {
			acts[a] = true
		}
		switch {
		case acts["delete"]:
			c.push(&pending{Type: pendDelete, Key: key, Deadline: ev.Time.Add(c.cfg.Window), Event: ev})
		case acts["permission_change"] && (c.permsOnCreate(ev) || c.createdWithPerms(ev, out)):
			// O Explorer ajusta a DACL ao copiar: faz parte do "criou".
		case acts["permission_change"]:
			ev.Action = ActionPermissionChanged
			c.bulk(ev, out)
		case acts["owner_change"]:
			ev.Action = ActionOwnerChanged
			c.bulk(ev, out)
		case acts["write"] || acts["append"]:
			info, err := c.stat(ev.Path)
			if err == nil && info.IsDir {
				// Escrever numa pasta = criar um item dentro dela. Espera o
				// dobro da janela: um renomear/mover pode consumir este evento.
				c.push(&pending{Type: pendDirWrite, Key: key, Deadline: ev.Time.Add(2 * c.cfg.Window), Event: ev})
				return
			}
			ev.ItemType = "file"
			ev.Action = ActionModified
			if err == nil && absDur(info.Created.Sub(ev.Time)) <= c.cfg.Window+clockSlack {
				ev.Action = ActionCreated
				c.st.Created[strings.ToLower(ev.Path)] = ev.Time
			}
			c.aggregate(ev, out)
		case acts["write_attributes"]:
			ev.Action = ActionAttributesChanged
			if info, err := c.stat(ev.Path); err == nil {
				ev.ItemType = itemType(info.IsDir)
			}
			c.aggregate(ev, out)
		case acts["read"]:
			ev.Action = ActionRead
			c.aggregate(ev, out)
		default:
			// execute/traverse e delete_child sozinhos: ruído. A exclusão do
			// item aparece no 4663 DELETE dele.
		}
	}
}

// permsOnCreate junta ao evento "criou" ainda pendente uma alteração de
// permissão feita logo em seguida pelo mesmo usuário e processo.
func (c *Correlator) permsOnCreate(ev Event) bool {
	t, ok := c.st.Created[strings.ToLower(ev.Path)]
	if !ok || absDur(ev.Time.Sub(t)) > c.cfg.Window+clockSlack {
		return false
	}
	key := strings.ToLower(strings.Join([]string{ev.Computer, userKey(ev.User), ev.Path, aggGroup(ActionCreated)}, "|"))
	p := c.find(pendAgg, key)
	if p == nil || p.Event.Action != ActionCreated || p.Event.ProcessID != ev.ProcessID {
		return false
	}
	p.Event.Actions = union(p.Event.Actions, ev.Actions)
	p.Event.RelatedRecords = append(p.Event.RelatedRecords, ev.RecordID)
	p.Event.Details = mergeDetails(p.Event.Details, map[string]string{"permissions_set_on_create": "true"})
	if ev.EventID == IDPermsChanged {
		p.Event.Details = mergeDetails(p.Event.Details, ev.Details) // SDDL antes/depois
	}
	return true
}

// createdWithPerms trata a alteração de permissão que chega antes da
// escrita: o Explorer define a DACL do arquivo copiado logo ao criá-lo. Se o
// item acabou de ser criado, o evento vira o "criou" (e as escritas
// seguintes se juntam a ele).
func (c *Correlator) createdWithPerms(ev Event, out *[]Event) bool {
	info, err := c.stat(ev.Path)
	if err != nil || absDur(info.Created.Sub(ev.Time)) > c.cfg.Window+clockSlack {
		return false
	}
	ev.Action = ActionCreated
	ev.ItemType = itemType(info.IsDir)
	ev.Details = mergeDetails(ev.Details, map[string]string{"permissions_set_on_create": "true"})
	c.st.Created[strings.ToLower(ev.Path)] = ev.Time
	c.aggregate(ev, out)
	return true
}

// --- pendências ---

func (c *Correlator) push(p *pending) {
	c.st.Pending = append(c.st.Pending, p)
	c.st.idx[p.Type+"\x00"+p.Key] = p
	if c.st.due.IsZero() || p.Deadline.Before(c.st.due) {
		c.st.due = p.Deadline
	}
}

func (c *Correlator) find(typ, key string) *pending {
	if p := c.st.idx[typ+"\x00"+key]; p != nil && !p.Consumed {
		return p
	}
	return nil
}

func (c *Correlator) remove(p *pending) {
	c.st.Pending = slices.DeleteFunc(c.st.Pending, func(x *pending) bool { return x == p })
	if k := p.Type + "\x00" + p.Key; c.st.idx[k] == p {
		delete(c.st.idx, k)
	}
}

// expire resolve, em ordem de prazo, as pendências vencidas até now.
// Exclusões são resolvidas antes das escritas em pasta do mesmo instante,
// pois podem consumi-las (destino de um renomear).
func (c *Correlator) expire(now time.Time, out *[]Event) {
	if !c.anyDue(now) {
		return
	}
	for {
		var next *pending
		for _, p := range c.st.Pending {
			if p.Deadline.After(now) {
				continue
			}
			if next == nil || p.Deadline.Before(next.Deadline) ||
				(p.Deadline.Equal(next.Deadline) && p.Type == pendDelete && next.Type != pendDelete) {
				next = p
			}
		}
		if next == nil {
			c.st.due = time.Time{}
			return
		}
		c.remove(next)
		if next.Consumed {
			continue
		}
		switch next.Type {
		case pendDelete:
			c.resolveDelete(next, out)
		case pendDirWrite:
			c.resolveDirWrite(next.Event, out)
		case pendAgg:
			c.emit(next.Event, out)
		case pendBulk:
			c.resolveBulk(next, out)
		}
	}
}

// anyDue evita percorrer as pendências a cada evento: guarda o menor prazo.
func (c *Correlator) anyDue(now time.Time) bool {
	if !c.st.due.IsZero() && now.Before(c.st.due) {
		return false
	}
	var min time.Time
	for _, p := range c.st.Pending {
		if min.IsZero() || p.Deadline.Before(min) {
			min = p.Deadline
		}
	}
	c.st.due = min
	return !min.IsZero() && !min.After(now)
}

// resolveDelete decide o que foi um 4663 DELETE. Com 4660, foi excluído (ou
// mandado para a Lixeira). Sem 4660: o item continua lá (salvamento do
// Office, que troca o arquivo), foi para a Lixeira, ou foi renomeado/movido.
func (c *Correlator) resolveDelete(p *pending, out *[]Event) {
	ev, deleted := p.Event, p.Deleted
	// Outras aberturas com DELETE do mesmo item, na mesma sessão: uma ação só.
	for _, q := range c.st.Pending {
		if q.Type == pendDelete && !q.Consumed && q != p && q.Event.Computer == ev.Computer &&
			q.Event.User.LogonID == ev.User.LogonID && strings.EqualFold(q.Event.Path, ev.Path) &&
			absDur(q.Event.Time.Sub(ev.Time)) <= c.cfg.Window {
			q.Consumed = true
			deleted = deleted || q.Deleted
			ev.RelatedRecords = append(append(ev.RelatedRecords, q.Event.RecordID), q.Event.RelatedRecords...)
		}
	}
	if deleted {
		ev.Action = ActionDeleted
		if c.fs != nil {
			if bin, ok := c.fs.RecycleBinFind(ev.Path, ev.User.SID, ev.Time.Add(-time.Minute)); ok {
				ev.Action = ActionRecycled
				ev.NewPath = bin
			}
		}
		c.emit(ev, out)
		return
	}
	if info, err := c.stat(ev.Path); err == nil {
		ev.Action = ActionModified
		ev.ItemType = itemType(info.IsDir)
		c.aggregate(ev, out)
		return
	}
	if c.fs != nil {
		if bin, ok := c.fs.RecycleBinFind(ev.Path, ev.User.SID, ev.Time.Add(-time.Minute)); ok {
			ev.Action = ActionRecycled
			ev.NewPath = bin
			c.emit(ev, out)
			return
		}
	}
	parent := parentDir(ev.Path)
	dirs := []string{}
	var writes []*pending
	for _, p := range c.st.Pending {
		w := p.Event
		if p.Type == pendDirWrite && !p.Consumed && w.Computer == ev.Computer &&
			w.User.LogonID == ev.User.LogonID && w.ProcessID == ev.ProcessID &&
			absDur(w.Time.Sub(ev.Time)) <= c.cfg.Window {
			writes = append(writes, p)
			dirs = append(dirs, w.Path)
		}
	}
	if !slices.ContainsFunc(dirs, func(d string) bool { return strings.EqualFold(d, parent) }) {
		dirs = append(dirs, parent)
	}
	ev.Action = ActionMoved
	for _, dir := range dirs {
		skip := "" // na mesma pasta, o item com o nome antigo não é o destino
		if strings.EqualFold(dir, parent) {
			skip = baseName(ev.Path)
		}
		name, info, ok := c.findRenamed(dir, skip, ev.Time)
		if !ok {
			continue
		}
		ev.NewPath = joinPath(dir, name)
		ev.ItemType = itemType(info.IsDir)
		if strings.EqualFold(dir, parent) {
			ev.Action = ActionRenamed
		}
		for _, w := range writes {
			if strings.EqualFold(w.Event.Path, dir) {
				w.Consumed = true
				break
			}
		}
		c.emit(ev, out)
		return
	}
	// Destino não encontrado (ex.: outra pasta sem auditoria). Se o Windows
	// registrou a pasta de destino, informa ao menos ela.
	for _, w := range writes {
		if !strings.EqualFold(w.Event.Path, parent) {
			w.Consumed = true
			ev.Details = mergeDetails(ev.Details, map[string]string{"destination_folder": w.Event.Path})
			break
		}
	}
	c.emit(ev, out)
}

// findRenamed procura na pasta um item que acabou de mudar de nome: o
// ChangeTime do NTFS muda ao renomear, mas a data de criação e a de
// modificação continuam antigas.
func (c *Correlator) findRenamed(dir, skip string, t time.Time) (string, FileInfo, bool) {
	if c.fs == nil {
		return "", FileInfo{}, false
	}
	entries, err := c.fs.ListDir(dir, maxDirScan)
	if err != nil {
		return "", FileInfo{}, false
	}
	from, to := t.Add(-clockSlack), t.Add(c.cfg.Window+clockSlack)
	old := t.Add(-c.cfg.Window)
	var best *DirEntry
	for i := range entries {
		e := &entries[i]
		if (skip != "" && strings.EqualFold(e.Name, skip)) || e.Changed.Before(from) || e.Changed.After(to) ||
			!e.Modified.Before(old) || !e.Created.Before(old) {
			continue
		}
		if best == nil || absDur(e.Changed.Sub(t)) < absDur(best.Changed.Sub(t)) {
			best = e
		}
	}
	if best == nil {
		return "", FileInfo{}, false
	}
	return best.Name, best.FileInfo, true
}

// resolveDirWrite procura o item criado na pasta (data de criação próxima
// do evento) que ainda não foi informado.
func (c *Correlator) resolveDirWrite(ev Event, out *[]Event) {
	if c.fs == nil {
		return
	}
	entries, err := c.fs.ListDir(ev.Path, maxDirScan)
	if err != nil {
		return
	}
	from, to := ev.Time.Add(-clockSlack), ev.Time.Add(c.cfg.Window+clockSlack)
	var best *DirEntry
	for i := range entries {
		e := &entries[i]
		if e.Created.Before(from) || e.Created.After(to) {
			continue
		}
		if _, done := c.st.Created[strings.ToLower(joinPath(ev.Path, e.Name))]; done {
			continue
		}
		if best == nil || e.Created.Before(best.Created) {
			best = e
		}
	}
	if best == nil {
		// Nada novo: o item já foi informado pelo próprio evento de escrita,
		// ou foi um temporário que já sumiu (a exclusão dele aparece à parte).
		return
	}
	ev.Path = joinPath(ev.Path, best.Name)
	ev.Action = ActionCreated
	ev.ItemType = itemType(best.IsDir)
	c.st.Created[strings.ToLower(ev.Path)] = ev.Time
	c.aggregate(ev, out)
}

// aggregate junta repetições da mesma ação (criar e alterar contam como
// uma só, prevalecendo "criou") do mesmo usuário no mesmo caminho.
func (c *Correlator) aggregate(ev Event, out *[]Event) {
	if ev.Path == "" {
		c.emit(ev, out)
		return
	}
	key := strings.ToLower(strings.Join([]string{ev.Computer, userKey(ev.User), ev.Path, aggGroup(ev.Action)}, "|"))
	if p := c.find(pendAgg, key); p != nil {
		a := &p.Event
		a.Count++
		end := ev.Time
		a.EndTime = &end
		a.Actions = union(a.Actions, ev.Actions)
		a.RelatedRecords = append(a.RelatedRecords, ev.RecordID)
		if aggRank(ev.Action) > aggRank(a.Action) {
			a.Action = ev.Action
		}
		if a.ItemType == "" {
			a.ItemType = ev.ItemType
		}
		return
	}
	ev.Count = 1
	c.push(&pending{Type: pendAgg, Key: key, Deadline: ev.Time.Add(c.cfg.AggregateWindow), Event: ev})
}

func aggGroup(action string) string {
	switch action {
	case ActionCreated, ActionModified, ActionAttributesChanged:
		return "write"
	}
	return action
}

func aggRank(action string) int {
	switch action {
	case ActionCreated:
		return 3
	case ActionModified:
		return 2
	}
	return 1
}

// bulk agrupa alterações de permissão ou dono do mesmo usuário e processo
// em sequência (ex.: icacls /T). Abaixo de BulkThreshold, cada item é
// enviado à parte; acima, vira um evento com a pasta comum e a contagem.
func (c *Correlator) bulk(ev Event, out *[]Event) {
	key := strings.ToLower(strings.Join([]string{ev.Computer, userKey(ev.User), ev.ProcessID, ev.Process, ev.Action}, "|"))
	p := c.find(pendBulk, key)
	if p == nil {
		p = &pending{Type: pendBulk, Key: key, Event: ev}
		c.push(p)
	}
	p.Deadline = ev.Time.Add(c.cfg.BulkGap)

	// Cada item conta uma vez: o 4670 vem logo depois do 4663 WRITE_DAC do
	// mesmo handle, e alterar a DACL de uma pasta faz o Windows regravar a
	// dos itens abaixo dela (herança), antes de o icacls /T chegar neles.
	h := pathHash(ev.Path)
	if p.Seen[h] {
		for i := range p.Items {
			it := &p.Items[i]
			if strings.EqualFold(it.Path, ev.Path) {
				it.Details = mergeDetails(it.Details, ev.Details)
				it.RelatedRecords = append(it.RelatedRecords, ev.RecordID)
				break
			}
		}
		return
	}
	if p.Seen == nil {
		p.Seen = map[string]bool{}
	}
	if len(p.Seen) < maxBulkSeen {
		p.Seen[h] = true
	}
	p.Total++
	if len(p.Samples) < maxBulkSample {
		p.Samples = append(p.Samples, ev.Path)
	}
	if p.Total == 1 {
		p.Root = ev.Path
	} else {
		p.Root = commonDir(p.Root, ev.Path)
	}
	end := ev.Time
	p.Event.EndTime = &end
	if p.Total < c.cfg.BulkThreshold {
		ev.Count = 1
		p.Items = append(p.Items, ev)
	} else {
		p.Items = nil // passou do limite: guarda só contagem e amostras
	}
}

// maxBulkSeen limita a memória da contagem de itens distintos; acima disso
// um item repetido pode ser contado duas vezes.
const maxBulkSeen = 50000

func pathHash(p string) string {
	h := fnv.New64a()
	h.Write([]byte(strings.ToLower(p)))
	return strconv.FormatUint(h.Sum64(), 36)
}

func (c *Correlator) resolveBulk(p *pending, out *[]Event) {
	if p.Total < c.cfg.BulkThreshold {
		for _, it := range p.Items {
			c.emit(it, out)
		}
		return
	}
	ev := p.Event
	ev.Path = p.Root
	ev.ItemType = "folder"
	ev.Count = p.Total
	ev.Details = map[string]string{"sample": strings.Join(p.Samples, "\n")}
	c.emit(ev, out)
}

// emit completa o evento (IP de origem, contagem) e aplica o filtro.
func (c *Correlator) emit(ev Event, out *[]Event) {
	if ev.ClientIP == "" {
		if ip, ok := c.st.LogonIPs[logonKey(ev)]; ok {
			ev.ClientIP = ip.IP
		}
	}
	if ev.Count == 0 {
		ev.Count = 1
	}
	if ev.Count <= 1 {
		ev.EndTime = nil
	}
	if ev.Actions == nil {
		ev.Actions = []string{}
	}
	if c.filter.Keep(ev) {
		*out = append(*out, ev)
	}
}

// --- caches ---

func (c *Correlator) rememberHandle(key, path string) {
	if path == "" || strings.HasSuffix(key, "|") || strings.HasSuffix(key, "|0x0") {
		return
	}
	if _, ok := c.st.handles[key]; ok {
		c.st.handles[key] = path
		for i := range c.st.Handles {
			if c.st.Handles[i].Key == key {
				c.st.Handles[i].Path = path
			}
		}
		return
	}
	c.st.handles[key] = path
	c.st.Handles = append(c.st.Handles, handleEntry{Key: key, Path: path})
	if over := len(c.st.Handles) - c.cfg.MaxHandles; over > 0 {
		for _, h := range c.st.Handles[:over] {
			delete(c.st.handles, h.Key)
		}
		c.st.Handles = slices.Clone(c.st.Handles[over:])
	}
}

func (c *Correlator) rememberIP(ev Event) {
	ip := ev.ClientIP
	if ip == "" || ip == "-" || ev.User.LogonID == "" {
		return
	}
	c.st.LogonIPs[logonKey(ev)] = logonIP{IP: ip, Seen: ev.Time}
}

// prune descarta IPs de sessões antigas e marcas de "criado" vencidas.
func (c *Correlator) prune() {
	for k, v := range c.st.LogonIPs {
		if c.st.Clock.Sub(v.Seen) > logonIPTTL {
			delete(c.st.LogonIPs, k)
		}
	}
	if over := len(c.st.LogonIPs) - maxLogonIPs; over > 0 {
		type kv struct {
			k string
			t time.Time
		}
		all := make([]kv, 0, len(c.st.LogonIPs))
		for k, v := range c.st.LogonIPs {
			all = append(all, kv{k, v.Seen})
		}
		sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })
		for _, x := range all[:over] {
			delete(c.st.LogonIPs, x.k)
		}
	}
	for k, t := range c.st.Created {
		if c.st.Clock.Sub(t) > createdTTL {
			delete(c.st.Created, k)
		}
	}
}

func (c *Correlator) stat(path string) (FileInfo, error) {
	if c.fs == nil || path == "" {
		return FileInfo{}, errNoFS
	}
	return c.fs.Stat(path)
}

type noFSError struct{}

func (noFSError) Error() string { return "sem acesso ao sistema de arquivos" }

var errNoFS error = noFSError{}

// --- utilidades ---

func handleKey(ev Event) string {
	return ev.Computer + "|" + ev.ProcessID + "|" + ev.HandleID
}

func logonKey(ev Event) string { return strings.ToLower(ev.Computer + "|" + ev.User.LogonID) }

func userKey(u User) string {
	if u.SID != "" {
		return u.SID
	}
	return u.Domain + `\` + u.Name
}

func itemType(dir bool) string {
	if dir {
		return "folder"
	}
	return "file"
}

func absDur(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

func parentDir(p string) string {
	i := strings.LastIndex(p, `\`)
	if i < 0 {
		return ""
	}
	if i == 2 && len(p) > 1 && p[1] == ':' { // "D:\arquivo" -> "D:\"
		return p[:3]
	}
	return p[:i]
}

func baseName(p string) string { return p[strings.LastIndex(p, `\`)+1:] }

func joinPath(dir, name string) string { return strings.TrimRight(dir, `\`) + `\` + name }

// commonDir devolve a pasta comum mais profunda de dois caminhos.
func commonDir(a, b string) string {
	pa, pb := strings.Split(a, `\`), strings.Split(b, `\`)
	n := 0
	for n < len(pa) && n < len(pb) && strings.EqualFold(pa[n], pb[n]) {
		n++
	}
	if n == len(pa) && n == len(pb) {
		return a
	}
	if n == len(pa) { // a é ancestral de b
		return a
	}
	if n == len(pb) {
		return b
	}
	d := strings.Join(pa[:n], `\`)
	if len(d) == 2 && d[1] == ':' {
		d += `\`
	}
	return d
}

func union(a, b []string) []string {
	out := slices.Clone(a)
	for _, x := range b {
		if !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	sort.Strings(out)
	return out
}

func mergeDetails(a, b map[string]string) map[string]string {
	if a == nil {
		a = map[string]string{}
	}
	for k, v := range b {
		if v != "" {
			a[k] = v
		}
	}
	return a
}

func sortByTime(evs []Event) []Event {
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].Time.Before(evs[j].Time) })
	return evs
}
