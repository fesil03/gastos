import { TOP_UP_CATEGORY_NAMES, type GastosDB } from './db'
import type { Category, Group } from './types'

// Three-tier taxonomy — spec §3.
// Tier 1: fixed, colour-coded groups. Tier 2: user-editable categories (seeded from Wallet).
// Tier 3: tags, many-per-transaction (seeded with the starter set below).

// Colours: 7 categorical hues validated for the dark surface (#020617) — lightness band,
// chroma floor, adjacent CVD ΔE ≥ 8, ≥ 3:1 contrast. "Outros" is the neutral fold slot and
// "Receita" never appears in expense charts.
export const GROUP_SEED: Omit<Group, 'id'>[] = [
  { name: 'Alimentação', color: '#d95926', sortOrder: 0, kind: 'expense' },
  { name: 'Transporte', color: '#3987e5', sortOrder: 1, kind: 'expense' },
  { name: 'Casa & Serviços', color: '#199e70', sortOrder: 2, kind: 'expense' },
  { name: 'Compras', color: '#9085e9', sortOrder: 3, kind: 'expense' },
  { name: 'Vida & Lazer', color: '#d55181', sortOrder: 4, kind: 'expense' },
  { name: 'Saúde', color: '#008300', sortOrder: 5, kind: 'expense' },
  { name: 'Contas & Taxas', color: '#c98500', sortOrder: 6, kind: 'expense' },
  { name: 'Receita', color: '#84cc16', sortOrder: 7, kind: 'income' },
  { name: 'Outros', color: '#64748b', sortOrder: 8, kind: 'other' },
]

export type GroupName = (typeof GROUP_SEED)[number]['name']

export const UNKNOWN_GROUP: GroupName = 'Outros'

// Wallet envelope_id → group. Every envelope observed in the 2023–2026 export is listed;
// anything else lands in Outros and is reported as "unmapped" by the importer.
export const ENVELOPE_TO_GROUP: Record<number, GroupName> = {
  1000: 'Alimentação', // Lojinhas · Café* · FamilyMart*
  1001: 'Alimentação', // Fora de Casa · Delivery* · Restaurante*
  1002: 'Alimentação', // Cantina · Johann/Millers*
  2000: 'Compras', // Roupas e sapatos
  2001: 'Compras', // Joias, acessórios
  2002: 'Saúde', // Saúde e beleza
  2004: 'Compras', // Casa, jardim
  2006: 'Compras', // Eletrônicos, acessórios
  2007: 'Compras', // Presentes, alegrias
  2008: 'Compras', // Papelaria, ferramentas
  2009: 'Vida & Lazer', // Tempo livre
  2011: 'Saúde', // Farmácia, drogaria
  3000: 'Vida & Lazer', // Hotel
  3002: 'Casa & Serviços', // Lavanderia
  3003: 'Casa & Serviços', // Serviços
  4000: 'Transporte', // Transporte público
  4001: 'Transporte', // Táxi
  4002: 'Transporte', // Longa distância · Trem*
  4004: 'Transporte', // Transporte
  6000: 'Saúde', // Cuidados de saúde, médico
  6001: 'Saúde', // Bem-estar, beleza
  6003: 'Vida & Lazer', // Cultura, eventos esportivos
  6004: 'Vida & Lazer', // Eventos de vida
  6005: 'Vida & Lazer', // Hobbies
  6006: 'Vida & Lazer', // Educação, desenvolvimento
  6007: 'Vida & Lazer', // Livros, áudio, assinaturas
  6008: 'Vida & Lazer', // TV, streaming
  6009: 'Vida & Lazer', // Férias, viagens, hotéis
  6010: 'Vida & Lazer', // Caridade, presentes
  6011: 'Vida & Lazer', // Álcool, tabaco
  7001: 'Contas & Taxas', // Telefone, celular
  7003: 'Contas & Taxas', // Software, aplicativos, jogos
  8005: 'Contas & Taxas', // Encargos, taxas
  10000: 'Receita', // Salário, faturas
  11000: 'Outros', // Outros
}

export const TAG_SEED = ['trabalho', 'lucia', 'viagem', 'recorrente', 'dku', 'reembolsável']

export function groupForEnvelope(envelopeId: number | null | undefined): {
  group: GroupName
  mapped: boolean
} {
  if (envelopeId != null && envelopeId in ENVELOPE_TO_GROUP) {
    return { group: ENVELOPE_TO_GROUP[envelopeId], mapped: true }
  }
  return { group: UNKNOWN_GROUP, mapped: false }
}

/** Seed groups and tags once. Idempotent: does nothing if groups already exist. */
export async function ensureTaxonomy(d: GastosDB): Promise<Map<GroupName, number>> {
  return d.transaction('rw', d.groups, d.tags, async () => {
    if ((await d.groups.count()) === 0) {
      await d.groups.bulkAdd(GROUP_SEED as Group[])
    }
    if ((await d.tags.count()) === 0) {
      await d.tags.bulkAdd(TAG_SEED.map((name) => ({ name })))
    }
    // Colours are not user-editable in v1: keep stored groups in sync with the seed palette.
    const groups = await d.groups.toArray()
    for (const g of groups) {
      const seed = GROUP_SEED.find((s) => s.name === g.name)
      if (seed && (g.color !== seed.color || g.sortOrder !== seed.sortOrder)) await d.groups.update(g.id!, { color: seed.color, sortOrder: seed.sortOrder })
    }
    return new Map(groups.map((g) => [g.name as GroupName, g.id!]))
  })
}

/** Find-or-create a category by name within a group. Names are unique app-wide. */
export async function ensureCategory(
  d: GastosDB,
  name: string,
  groupId: number,
  provenance?: { walletEnvelopeId?: number; walletCustom?: boolean },
): Promise<number> {
  const existing = await d.categories.where('name').equals(name).first()
  if (existing) return existing.id!
  const cat: Category = { name, groupId, archived: 0, isTopUp: TOP_UP_CATEGORY_NAMES.includes(name) ? 1 : 0, ...provenance }
  return (await d.categories.add(cat)) as number
}
