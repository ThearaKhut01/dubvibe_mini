import { useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, ChevronDown, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { useText } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { InlineAlert } from '@/components/inline-alert'
import { useClient } from '../sdk'

type ModelStatus = 'pending' | 'downloading' | 'paused' | 'ready' | 'failed'
type ModelFile = { path: string; size: number; present: boolean }
type CatalogModel = { id: string; name: string; variant: string; purpose: string; category: string; optional: boolean; installed: boolean; busy: boolean; files: ModelFile[]; status?: ModelStatus; received: number; total: number; speed: number; error?: string }

const GB = 1024 ** 3, MB = 1024 ** 2
const size = (bytes: number) => (bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.round(bytes / MB)} MB`)

// Fixed display order for known model categories; unexpected categories are appended.
const CATEGORY_LABELS: Record<string, readonly [string, string, string?]> = {
  asr: ['Speech recognition', '语音识别', 'ការសម្គាល់សំឡេង'],
  translation: ['Local translation', '本地翻译', 'ការបកប្រែក្នុងស្រុក'],
  tts: ['Voice cloning', '声音克隆', 'ការក្លូនសំឡេង'],
  separation: ['Vocal separation', '人声分离', 'ការបំបែកសំឡេង'],
  alignment: ['Subtitle alignment', '字幕对齐', 'ការតម្រឹមចំណងជើង'],
}

// Groups models by category behind one collapsible header per category.
export function ModelsSection() {
  const tx = useText()
  const { apiClient } = useClient()
  const [items, setItems] = useState<CatalogModel[]>([])
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [token, setToken] = useState('')
  const [failure, setFailure] = useState('')
  const [busy, setBusy] = useState(false)

  const groups = useMemo(() => {
    const map = new Map<string, CatalogModel[]>()
    for (const item of items) {
      const known = map.get(item.category)
      if (known) known.push(item)
      else map.set(item.category, [item])
    }
    const keys = [...map.keys()].sort((a, b) => {
      const left = Object.keys(CATEGORY_LABELS).indexOf(a), right = Object.keys(CATEGORY_LABELS).indexOf(b)
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right)
    })
    return keys.map(key => ({ key, label: CATEGORY_LABELS[key] ?? ([key, key] as const), items: map.get(key)! }))
  }, [items])

  async function load() {
    const [catalog, setup] = await Promise.all([
      apiClient.request<{ items: CatalogModel[] }>('/api/setup/models'),
      apiClient.request<{ token: string }>('/api/setup'),
    ])
    setItems(catalog.items)
    // Downloads in progress stay visible: expand their category the first time we load.
    const opened: Record<string, boolean> = {}
    for (const item of catalog.items as CatalogModel[]) if (item.busy) opened[item.category] = true
    setOpen(previous => ({ ...previous, ...opened }))
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
      // Non-GET requests must carry the session CSRF token, so use the shared apiClient.
      const next = await apiClient.request<{ items: CatalogModel[] }>(`/api/setup/models/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { 'X-dubvibe_mini-Setup': token },
      })
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
      const next = await apiClient.request<{ items: CatalogModel[] }>(`/api/setup/models/${encodeURIComponent(id)}`, {
        method: 'POST', headers: { 'X-dubvibe_mini-Setup': token }, body: JSON.stringify({ action }),
      })
      setItems(next.items)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-card p-5 shadow-card">
      <h2 className="mb-1 text-base font-semibold">{tx('Local models', '本地模型', 'ម៉ូដែលក្នុងស្រុក')}</h2>
      <p className="mb-4 text-xs text-muted-foreground">{tx('Remove a model to free disk space, or download extra Whisper sizes here.', '删除模型以释放磁盘空间，也可在此下载其他 Whisper 规格。', 'លុបម៉ូដែលដើម្បីបញ្ចេញចន្លោះឌីសក ឬទាញយកទំហំ Whisper បន្ថែមទីនេះ។')}</p>
      {failure && <InlineAlert>{failure}</InlineAlert>}
      {groups.map(group => {
        const expanded = open[group.key] ?? false
        const installed = group.items.filter(item => item.installed).length
        const failed = group.items.filter(item => item.status === 'failed').length
        return (
          <div key={group.key} className="border-b border-border last:border-b-0">
            <button type="button" aria-expanded={expanded} className="flex w-full items-center justify-between gap-3 py-3 text-left"
              onClick={() => setOpen(previous => ({ ...previous, [group.key]: !expanded }))}>
              <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} />
                {tx(group.label[0], group.label[1], group.label[2])}
                {failed > 0 && <span className="font-normal text-xs text-status-danger-fg">· {tx('download failed', '下载失败', 'ការទាញយកបរាជ័យ')}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{tx('Installed', '已安装', 'បានដំឡើង')} {installed}/{group.items.length}</span>
            </button>
            {expanded && (
              <ul className="divide-y divide-border pb-3">
                {group.items.map(model => {
                  const total = model.files.reduce((sum, file) => sum + file.size, 0)
                  const percent = model.total ? Math.min(100, Math.round(model.received / model.total * 100)) : 0
                  return (
                    <li key={model.id} className="flex items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{model.name}{model.variant && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{model.variant}</span>}</p>
                        <p className="text-xs text-muted-foreground">
                          {size(total)} ·{' '}
                          {model.busy ? `${tx('Downloading', '下载中', 'កំពុងទាញយក')} ${percent}% · ${(model.speed / MB).toFixed(1)} MB/s`
                            : model.installed ? tx('Installed', '已安装', 'បានដំឡើង')
                            : model.status === 'paused' ? tx('Paused', '已暂停', 'បានផ្អាក')
                            : model.status === 'failed' ? tx('Failed', '失败', 'បរាជ័យ')
                            : tx('Not installed', '未安装', 'មិនបានដំឡើង')}
                        </p>
                        {model.error && <p className="mt-0.5 text-xs text-status-danger-fg">{model.error}</p>}
                      </div>
                      {model.installed ? (
                        <Button variant="outline" size="sm" disabled={busy || model.busy} onClick={() => void remove(model.id)}>
                          <Trash2 /> {tx('Remove', '删除', 'លុបចេញ')}
                        </Button>
                      ) : model.status === 'downloading' || model.busy ? (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => void control(model.id, 'pause')}>
                          <Pause /> {tx('Pause', '暂停', 'ផ្អាក')}
                        </Button>
                      ) : (
                        <Button variant="outline" size="sm" disabled={busy} onClick={() => void control(model.id, 'start')}>
                          {model.status === 'paused' ? <><Play /> {tx('Resume', '继续', 'បន្ត')}</>
                            : model.status === 'failed' ? <><RotateCcw /> {tx('Retry', '重试', 'ព្យាយាមឡើងវិញ')}</>
                            : <><ArrowDownToLine /> {tx('Download', '下载', 'ទាញយក')}</>}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </section>
  )
}
