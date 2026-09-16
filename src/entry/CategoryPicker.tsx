import { useState } from 'react'
import type { Taxonomy } from '../db/hooks'
import { addCategory } from '../db/mutations'
import { Sheet } from '../ui/Sheet'

interface Props {
  taxonomy: Taxonomy
  onPick: (categoryId: number) => void
  onClose: () => void
  title?: string
}

/** Full category list grouped by group, with search and inline "new category". */
export function CategoryPicker({ taxonomy, onPick, onClose, title = 'Categoria' }: Props) {
  const [q, setQ] = useState('')
  const [newGroupId, setNewGroupId] = useState<number | null>(null)
  const needle = q.trim().toLowerCase()

  const groups = taxonomy.groups
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((g) => ({
      group: g,
      cats: taxonomy.categories
        .filter((c) => c.groupId === g.id && !c.archived && (!needle || c.name.toLowerCase().includes(needle)))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt')),
    }))
    .filter((g) => g.cats.length || (needle && newGroupId === g.group.id))

  const exact = taxonomy.categories.some((c) => c.name.toLowerCase() === needle)

  return (
    <Sheet title={title} onClose={onClose}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Buscar ou criar…"
        data-testid="category-search"
        className="mb-3 w-full rounded-xl bg-slate-800 px-3 py-2.5 text-base outline-none placeholder:text-slate-500"
      />
      {needle && !exact && (
        <div className="mb-3 rounded-xl border border-dashed border-slate-700 p-3 text-sm">
          <p className="mb-2">
            Criar <span className="font-medium">“{q.trim()}”</span> em:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {taxonomy.groups
              .filter((g) => g.kind !== 'income')
              .map((g) => (
                <button
                  key={g.id}
                  className="rounded-full px-2.5 py-1 text-xs"
                  style={{ background: g.color + '33', color: g.color }}
                  onClick={async () => {
                    setNewGroupId(g.id!)
                    const id = await addCategory(q.trim(), g.id!)
                    onPick(id)
                  }}
                >
                  {g.name}
                </button>
              ))}
          </div>
        </div>
      )}
      <div className="space-y-4">
        {groups.map(({ group, cats }) => (
          <div key={group.id}>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <span className="h-2 w-2 rounded-full" style={{ background: group.color }} />
              {group.name}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {cats.map((c) => (
                <button
                  key={c.id}
                  data-testid="picker-category"
                  className="rounded-full bg-slate-800 px-3 py-1.5 text-sm active:scale-95"
                  onClick={() => onPick(c.id!)}
                >
                  {c.name}
                  {c.isTopUp === 1 && <span className="ml-1 text-[9px] uppercase tracking-wide text-slate-500">top-up</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Sheet>
  )
}
