import { useEffect, useState } from 'react'
import { ArrowDownToLine, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { useText } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/inline-alert'

type ModelStatus = 'pending' | 'downloading' | 'paused' | 'ready' | 'failed'
type ModelFile = { path: string; size: number; present: boolean }
type CatalogModel = { id: string; name: string; variant: string; purpose: string; optional: boolean; installed: boolean; busy: boolean; files: ModelFile[]; status?: ModelStatus; received: number; total: number; speed: number; error?: string }

const GB = 1024 ** 3, MB = 1024 ** 2
const size = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / MB)} MB`)

// Lists every local model with download for the extra Whisper sizes, and Remove for installed ones.
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

  // Keep progress lines fresh while any transfer is running; the interval stops itself when none is busy.
  const anyBusy = items.some(item => item.busy)
  useEffect(() => {
    if (!anyBusy) return
    const timer = setInterval(() => {
      fetch('/api/setup/models', { cache: 'no-store', credentials: 'same-origin' })
        .then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then(catalog => setItems(catalog.items))
        .catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [anyBusy])

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

  async function control(id: string, action: 'start' | 'pause') {
    setBusy(true); setFailure('')
    try {
      const response = await fetch(`/api/setup/models/${encodeURIComponent(id)}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-dubvibe_mini-Setup': token },
        body: JSON.stringify({ action }),
      })
      if (!response.ok) throw new Error(`Download failed (${response.status})`)
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
      <p className="mb-4 text-xs text-muted-foreground">{tx('Remove a model to free disk space, or download extra Whisper sizes here.', '删除模型以释放磁盘空间，也可在此下载其他 Whisper 规格。')}</p>
      {failure && <InlineAlert>{failure}</InlineAlert>}
      <ul className="divide-y divide-border">
        {items.map(model => {
          const total = model.files.reduce((sum, file) => sum + file.size, 0)
          const percent = model.total ? Math.min(100, Math.round(model.received / model.total * 100)) : 0
          return (
            <li key={model.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{model.name}{model.variant && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{model.variant}</span>}</p>
                <p className="text-xs text-muted-foreground">
                  {model.purpose} · {size(total)} ·{' '}
                  {model.busy ? `${tx('Downloading', '下载中')} ${percent}% · ${(model.speed / MB).toFixed(1)} MB/s`
                    : model.installed ? tx('Installed', '已安装')
                    : model.status === 'paused' ? tx('Paused', '已暂停')
                    : model.status === 'failed' ? tx('Failed', '失败')
                    : tx('Not installed', '未安装')}
                </p>
                {model.error && <p className="mt-0.5 text-xs text-status-danger-fg">{model.error}</p>}
              </div>
              {model.installed ? (
                <Button variant="outline" size="sm" disabled={busy || model.busy} onClick={() => void remove(model.id)}>
                  <Trash2 /> {tx('Remove', '删除')}
                </Button>
              ) : model.status === 'downloading' || model.busy ? (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void control(model.id, 'pause')}>
                  <Pause /> {tx('Pause', '暂停')}
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void control(model.id, 'start')}>
                  {model.status === 'paused' ? <><Play /> {tx('Resume', '继续')}</>
                    : model.status === 'failed' ? <><RotateCcw /> {tx('Retry', '重试')}</>
                    : <><ArrowDownToLine /> {tx('Download', '下载')}</>}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
