// Apêndice do inventário: quem faz parte de cada grupo citado nas
// permissões, inclusive pelos grupos que estão dentro dele. Sem acesso a banco.

export interface GroupRecord {
  group_name: string;
  group_sid: string | null;
  note: string | null;
  error: string | null;
  truncated: boolean;
  member_name: string | null;
  member_sid: string | null;
  member_kind: string | null;
}

export interface AppendixMember {
  name: string;
  sid: string | null;
  kind: string;
  // Caminho de grupos até o membro ("Gerentes" ou "Gerentes › Diretoria"); nulo = direto.
  via: string | null;
}

export interface AppendixGroup {
  name: string;
  sid: string | null;
  note: string | null;
  error: string | null;
  truncated: boolean;
  members: AppendixMember[];
}

interface Group {
  name: string;
  sid: string | null;
  note: string | null;
  error: string | null;
  truncated: boolean;
  members: { name: string; sid: string | null; kind: string }[];
}

// Sufixos que o inventário do Linux põe no dono e no grupo dono.
const plain = (n: string) => n.replace(/ \((grupo dono|dono)\)$/, '');
const MAX_DEPTH = 5;
const MAX_MEMBERS = 5000;

export function buildAppendix(cited: { principal: string | null; sid: string | null; kind: string | null }[], records: GroupRecord[]): AppendixGroup[] {
  // Junta as linhas por grupo; o mesmo grupo pode vir de várias coletas.
  const groups: Group[] = [];
  const index = new Map<string, Group>();
  const keys = (name: string, sid: string | null) => [...(sid ? [`s:${sid.toUpperCase()}`] : []), `n:${name.toLowerCase()}`];
  const find = (name: string, sid: string | null) => {
    for (const k of keys(name, sid)) {
      const g = index.get(k);
      if (g) return g;
    }
    return undefined;
  };
  const scanSeen = new Map<Group, Set<string>>();
  for (const r of records) {
    let g = find(r.group_name, r.group_sid);
    if (!g) {
      g = { name: r.group_name, sid: r.group_sid, note: r.note, error: r.error, truncated: r.truncated, members: [] };
      groups.push(g);
      scanSeen.set(g, new Set());
      for (const k of keys(g.name, g.sid)) index.set(k, g);
    }
    if (r.member_name === null) continue;
    const mk = (r.member_sid ?? r.member_name).toLowerCase();
    if (scanSeen.get(g)!.has(mk)) continue;
    scanSeen.get(g)!.add(mk);
    g.members.push({ name: r.member_name, sid: r.member_sid, kind: r.member_kind ?? 'unknown' });
  }

  const out: AppendixGroup[] = [];
  const done = new Set<Group>();
  for (const c of cited) {
    if (c.kind !== 'group' || !c.principal) continue;
    const g = find(plain(c.principal), c.sid);
    if (!g || done.has(g)) continue;
    done.add(g);
    const members: AppendixMember[] = [];
    const expand = (cur: Group, via: string[], path: Set<Group>) => {
      for (const m of cur.members) {
        if (members.length >= MAX_MEMBERS) return;
        members.push({ name: m.name, sid: m.sid, kind: m.kind, via: via.length ? via.join(' › ') : null });
        if (m.kind !== 'group' || via.length >= MAX_DEPTH) continue;
        const inner = find(m.name, m.sid);
        if (inner && !path.has(inner)) expand(inner, [...via, inner.name], new Set([...path, inner]));
      }
    };
    expand(g, [], new Set([g]));
    out.push({ name: g.name, sid: g.sid, note: g.note, error: g.error, truncated: g.truncated, members });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
