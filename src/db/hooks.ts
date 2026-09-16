import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo } from 'react'
import { db } from './db'
import type { BalanceCheck, Category, Group, Tag, Transaction, UntrackedPeriod } from './types'
import { DEFAULT_REF_CURRENCY } from './types'

// The dataset is small (a few thousand rows); loading it whole and deriving in memory is
// simpler and faster than per-screen queries. useLiveQuery re-runs on any write.

export function useAllTransactions(): Transaction[] | undefined {
  return useLiveQuery(() => db.transactions.toArray(), [])
}

export function useCategories(): Category[] | undefined {
  return useLiveQuery(() => db.categories.toArray(), [])
}

export function useGroups(): Group[] | undefined {
  return useLiveQuery(() => db.groups.orderBy('id').toArray(), [])
}

export function useTags(): Tag[] | undefined {
  return useLiveQuery(() => db.tags.toArray(), [])
}

export function useUntrackedPeriods(): UntrackedPeriod[] | undefined {
  return useLiveQuery(() => db.untrackedPeriods.orderBy('start').toArray(), [])
}

export function useBalanceChecks(): BalanceCheck[] | undefined {
  return useLiveQuery(() => db.balanceChecks.orderBy('date').toArray(), [])
}

export function useSetting<T>(key: string, fallback: T): T {
  const row = useLiveQuery(() => db.settings.get(key), [key])
  return row === undefined ? fallback : ((row?.value as T) ?? fallback)
}

export function useRefCurrency(): string {
  return useSetting('refCurrency', DEFAULT_REF_CURRENCY)
}

export interface Taxonomy {
  categories: Category[]
  groups: Group[]
  tags: Tag[]
  categoryById: Map<number, Category>
  groupById: Map<number, Group>
  tagById: Map<number, Tag>
  groupOfCategory: (categoryId: number) => Group | undefined
  /** Ids of categories flagged as prepaid top-ups (spec §3). */
  topUpIds: Set<number>
  ready: boolean
}

export function useTaxonomy(): Taxonomy {
  const categories = useCategories()
  const groups = useGroups()
  const tags = useTags()
  return useMemo(() => {
    const cats = categories ?? []
    const grps = groups ?? []
    const tgs = tags ?? []
    const categoryById = new Map(cats.map((c) => [c.id!, c]))
    const groupById = new Map(grps.map((g) => [g.id!, g]))
    const tagById = new Map(tgs.map((t) => [t.id!, t]))
    return {
      categories: cats,
      groups: grps,
      tags: tgs,
      categoryById,
      groupById,
      tagById,
      groupOfCategory: (id: number) => {
        const c = categoryById.get(id)
        return c ? groupById.get(c.groupId) : undefined
      },
      topUpIds: new Set(cats.filter((c) => c.isTopUp === 1).map((c) => c.id!)),
      ready: categories !== undefined && groups !== undefined && tags !== undefined,
    }
  }, [categories, groups, tags])
}
