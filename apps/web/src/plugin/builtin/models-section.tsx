import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useText } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/inline-alert'

type ModelFile = { path: string; size: number; present: boolean }
type CatalogModel = { id: string; name: string; variant: string; purpose: string; installed: boolean; busy: boolean; files: ModelFile[] }

const GB = 1024 ** 3, MB = 1024 ** 2
const size = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / MB)} MB`)

// Lists every local model with Remove for installed ones. Downloads use the existing setup download action.
export function ModelsSection() {
  const tx = useText()
  const [items, setItems] = useState<CatalogModel[]>([])
  const [token, setToken] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    const [catalog, setup] = await Promise.all([
      fetch('/api/setup/models', { cache: 'no-store', credentials: 'same-origin' }).then(response => response.json()),
      fetch('/api/setup', { cache: 'no-store', credentials: 'same-origin' }).then(response => response.json()),
    ])
    setItems(catalog.items)
    setToken(setup.token)
  }

  useEffect(() => {
    let stopped = false
    void Promise.resolve().then(load).catch(error => {
      if (!stopped) setFailure(error instanceof Error ? error.message : String(error))
    })
    return () => { stopped = true }
  }, [])

  async function remove(id: string) {
    setBusy(true); setFailure('')
    try {
      const response = await fetch(`/api/setup/models/${encodeURIComponent(id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: { 'X-dubvibe_mini-Setup': token },
      })
      if (!response.ok) throw new Error(`Remove failed (${response.status})`)
      const next = await response.json()
      setItems(next.items)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-card">
      <h2 className="mb-1 text-base font-semibold">{tx('Local models', '本地模型')}</h2>
      <p className="mb-4 text-xs text-muted-foreground">{tx('Remove a model to free disk space. It can be downloaded again from the setup screen.', '删除模型以释放磁盘空间，之后可在环境准备页面重新下载。')}</p>
      {failure && <InlineAlert>{failure}</InlineAlert>}
      <ul className="divide-y divide-border">
        {items.map(model => {
          const total = model.files.reduce((sum, file) => sum + file.size, 0)
          return (
            <li key={model.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{model.name}{model.variant && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{model.variant}</span>}</p>
                <p className="text-xs text-muted-foreground">{model.purpose} · {size(total)} · {model.installed ? tx('Installed', '已安装') : tx('Not installed', '未安装')}</p>
              </div>
              {model.installed && (
                <Button variant="outline" size="sm" disabled={busy || model.busy} onClick={() => void remove(model.id)}>
                  <Trash2 /> {tx('Remove', '删除')}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
