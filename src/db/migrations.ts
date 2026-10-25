import type { GastosDB } from './db'
import { getSetting, setSetting } from './db'
import { ensureTaxonomy, type GroupName } from './taxonomy'
import type { Category } from './types'
import { nowIso } from '../lib/dates'

// Taxonomy migrations — changes to the category list that must reach databases that already
// exist (the phone's), not just fresh installs.
//
// Rules, because these run unattended on the device that holds the only real copy of the data:
//  - Renames change a category's name and nothing else. Transactions join by categoryId, so no
//    transaction row is touched and every past entry simply shows the new name.
//  - The old name is kept in `aliases`, so a later Wallet CSV import maps rows carrying the old
//    name onto the renamed category instead of recreating it.
//  - A rename never merges. If both the old and the new name already exist, it is skipped and
//    reported. Merges are their own explicit step, listed only after the user chose them; each
//    one logs the ids of the transactions it moved (settings 'taxonomyLog') so it can be undone.
//  - Archiving only hides a category from pickers and chips; its history stays as it is.
//  - Additions don't duplicate: a category whose name matches any of `alsoMatches` counts as
//    already present.
//  - Each version runs once per database (settings 'taxonomyVersion'). Every step is also
//    idempotent on its own, so a restored older backup re-running a version is harmless.

export interface CategoryRename {
  /** Names this category may currently have (matched ignoring case, accents and punctuation). */
  from: string[]
  to: string
  /** Move to this group as part of the rename (optional). */
  group?: GroupName
}

export interface CategoryAddition {
  name: string
  group: GroupName
  /** Existing names that already mean this category — if one exists, nothing is added. */
  alsoMatches?: string[]
}

export interface CategoryMerge {
  /** The category to empty (any of these names). Its transactions move to `into`, then it is removed. */
  from: string[]
  /** The surviving category, by its name after this version's renames. */
  into: string
}

export interface TaxonomyMigration {
  version: number
  /** Applied in this order: renames, merges, archive, additions. */
  renames?: CategoryRename[]
  merges?: CategoryMerge[]
  /** Hide from pickers and chips. History is untouched. */
  archive?: string[]
  additions?: CategoryAddition[]
}

/** One merge as it happened, kept in settings 'taxonomyLog' so it can be reversed. */
export interface MergeLogEntry {
  version: number
  at: string
  from: { id: number; name: string; groupId: number; isTopUp: 0 | 1; walletEnvelopeId?: number }
  intoId: number
  intoName: string
  movedTransactionIds: number[]
}

export const TAXONOMY_MIGRATIONS: TaxonomyMigration[] = [
  {
    // Oct 2026 clean-up, decided by Felipe against his own category rollup.
    version: 1,
    renames: [
      // Saúde: Wallet's names said the same thing four ways. Classify by WHAT was bought.
      { from: ['Saúde e beleza'], to: 'Higiene & skincare' }, // creme, sabonete, desodorante, retinol…
      { from: ['Bem-estar, beleza'], to: 'Massagem & salão' }, // massagem, cabelo, barbeiro, spa
      { from: ['Cuidados de saúde, médico'], to: 'Médico & exames' }, // consultas, exames, dentista
      { from: ['Farmácia, drogaria'], to: 'Farmácia' }, // kept broad: 2026 skincare was logged here
      // The two gift categories become one, in Vida & Lazer.
      { from: ['Caridade, presentes'], to: 'Presentes & doações', group: 'Vida & Lazer' },
    ],
    merges: [{ from: ['Presentes, alegrias'], into: 'Presentes & doações' }],
    // Replaced in Jul 2025 (by Restaurante + Delivery, and FamilyMart + Café); history kept as is.
    archive: ['Fora de Casa', 'Lojinhas'],
    additions: [{ name: 'Bike', group: 'Transporte', alsoMatches: ['Bicicleta', 'Shared bike', 'Bike compartilhada', 'Hellobike', 'Meituan bike'] }],
  },
]

export const TAXONOMY_LOG_KEY = 'taxonomyLog'

export const TAXONOMY_VERSION_KEY = 'taxonomyVersion'

export interface MigrationReport {
  fromVersion: number
  toVersion: number
  renamed: { from: string; to: string }[]
  merged: { from: string; into: string; moved: number }[]
  archived: string[]
  added: string[]
  skipped: { step: string; reason: string }[]
}

/** Name comparison key: case, accents, punctuation and spacing ignored — "Farmácia, drogaria" ≡ "farmacia drogaria". */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function findByNames(cats: Category[], names: string[]): Category | undefined {
  const keys = new Set(names.map(nameKey))
  return cats.find((c) => keys.has(nameKey(c.name)))
}

export async function migrateTaxonomy(d: GastosDB, migrations: TaxonomyMigration[] = TAXONOMY_MIGRATIONS): Promise<MigrationReport> {
  const fromVersion = await getSetting<number>(d, TAXONOMY_VERSION_KEY, 0)
  const pending = migrations.filter((m) => m.version > fromVersion).sort((a, b) => a.version - b.version)
  const report: MigrationReport = { fromVersion, toVersion: fromVersion, renamed: [], merged: [], archived: [], added: [], skipped: [] }
  if (!pending.length) return report

  const groupIds = await ensureTaxonomy(d)
  await d.transaction('rw', d.categories, d.transactions, d.settings, async () => {
    for (const m of pending) {
      for (const r of m.renames ?? []) {
        const cats = await d.categories.toArray()
        const source = findByNames(cats, r.from)
        const target = findByNames(cats, [r.to])
        if (!source) {
          if (!target) report.skipped.push({ step: `rename → ${r.to}`, reason: 'nenhuma categoria com esses nomes' })
          continue // already renamed (target exists, source gone), or never existed
        }
        if (target && target.id !== source.id) {
          report.skipped.push({ step: `${source.name} → ${r.to}`, reason: `"${target.name}" já existe; não junto categorias automaticamente` })
          continue
        }
        const aliases = [...new Set([...(source.aliases ?? []), source.name].filter((a) => nameKey(a) !== nameKey(r.to)))]
        const patch: Partial<Category> = { name: r.to, aliases }
        if (r.group) {
          const gid = groupIds.get(r.group)
          if (gid != null) patch.groupId = gid
        }
        await d.categories.update(source.id!, patch)
        if (source.name !== r.to) report.renamed.push({ from: source.name, to: r.to })
      }
      for (const mg of m.merges ?? []) {
        const cats = await d.categories.toArray()
        const source = findByNames(cats, mg.from)
        const target = findByNames(cats, [mg.into])
        if (!source) continue // already merged, or never existed
        if (!target) {
          report.skipped.push({ step: `${source.name} → ${mg.into}`, reason: `"${mg.into}" não existe` })
          continue
        }
        if (source.id === target.id) continue
        const moved = (await d.transactions.where('categoryId').equals(source.id!).primaryKeys()) as number[]
        await d.transactions.where('categoryId').equals(source.id!).modify({ categoryId: target.id! })
        const log = await getSetting<MergeLogEntry[]>(d, TAXONOMY_LOG_KEY, [])
        log.push({
          version: m.version,
          at: nowIso(),
          from: { id: source.id!, name: source.name, groupId: source.groupId, isTopUp: source.isTopUp, walletEnvelopeId: source.walletEnvelopeId },
          intoId: target.id!,
          intoName: target.name,
          movedTransactionIds: moved,
        })
        await setSetting(d, TAXONOMY_LOG_KEY, log)
        // The emptied category's names now point at the survivor (CSV import, backup merge).
        const aliases = [...new Set([...(target.aliases ?? []), source.name, ...(source.aliases ?? [])])]
        await d.categories.update(target.id!, { aliases })
        await d.categories.delete(source.id!)
        report.merged.push({ from: source.name, into: target.name, moved: moved.length })
      }
      for (const name of m.archive ?? []) {
        const cat = findByNames(await d.categories.toArray(), [name])
        if (cat && cat.archived !== 1) {
          await d.categories.update(cat.id!, { archived: 1 })
          report.archived.push(cat.name)
        }
      }
      for (const a of m.additions ?? []) {
        const cats = await d.categories.toArray()
        if (findByNames(cats, [a.name, ...(a.alsoMatches ?? [])])) continue
        const gid = groupIds.get(a.group)
        if (gid == null) {
          report.skipped.push({ step: `+ ${a.name}`, reason: `grupo "${a.group}" não existe` })
          continue
        }
        await d.categories.add({ name: a.name, groupId: gid, archived: 0, isTopUp: 0 })
        report.added.push(a.name)
      }
      report.toVersion = m.version
    }
    await setSetting(d, TAXONOMY_VERSION_KEY, report.toVersion)
  })
  return report
}
