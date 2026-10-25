import { useEffect } from 'react'
import { EntryScreen } from './entry/EntryScreen'
import { ListScreen } from './list/ListScreen'
import { InsightsScreen } from './insights/InsightsScreen'
import { ExportScreen } from './export/ExportScreen'
import { db } from './db/db'
import { seedIfEmpty } from './db/mutations'
import { flush, watchForChanges, withSyncSuspended } from './sync/autopush'
import { migrateTaxonomy } from './db/migrations'
import { SettingsScreen } from './settings/SettingsScreen'
import { UpdateBanner } from './ui/UpdateBanner'
import { Shell, useTab } from './ui/Shell'

export default function App() {
  const [tab, setTab] = useTab()
  useEffect(() => {
    watchForChanges(db)
    void (async () => {
      await seedIfEmpty()
      // Category renames/additions for databases that already exist. Run with change-tracking
      // off so a migration never triggers a push by itself; the push right below carries it.
      try {
        await withSyncSuspended(() => migrateTaxonomy(db))
      } catch (e) {
        console.warn('taxonomy migration failed', e)
      }
      // Anything left unsent from the previous session goes out as soon as the app opens.
      await flush(db, { force: true })
    })()
  }, [])
  return (
    <Shell tab={tab} onTab={setTab}>
      {tab === 'entry' && <EntryScreen />}
      {tab === 'list' && <ListScreen />}
      {tab === 'insights' && <InsightsScreen />}
      {tab === 'export' && <ExportScreen />}
      {tab === 'settings' && <SettingsScreen />}
      <UpdateBanner />
    </Shell>
  )
}
