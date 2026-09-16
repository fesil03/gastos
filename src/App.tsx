import { useEffect } from 'react'
import { EntryScreen } from './entry/EntryScreen'
import { ListScreen } from './list/ListScreen'
import { InsightsScreen } from './insights/InsightsScreen'
import { ExportScreen } from './export/ExportScreen'
import { seedIfEmpty } from './db/mutations'
import { SettingsScreen } from './settings/SettingsScreen'
import { UpdateBanner } from './ui/UpdateBanner'
import { Shell, useTab } from './ui/Shell'

export default function App() {
  const [tab, setTab] = useTab()
  useEffect(() => {
    void seedIfEmpty()
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
