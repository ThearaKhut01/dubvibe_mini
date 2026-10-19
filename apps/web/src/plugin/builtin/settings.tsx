import { Context } from 'cordis'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, Loader2, Plug, RefreshCw, Settings2 } from 'lucide-react'
import { text, useClient, useSlot, type Catalog, type JsonObject, type SettingsSectionProps } from '../sdk'
import { useI18n, useText } from '@/lib/i18n'
import { ThemeToggle } from '@/components/theme-toggle'
import { LanguageSwitcher } from '@/components/language-switcher'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineAlert } from '@/components/inline-alert'
import { useQuery } from './use-query'
import { ModelsSection } from './models-section'
type Connection = { adapter: string; base_url: string; has_api_key: boolean }
type SettingsData = JsonObject & { connections?: Connection[]; ui_language?: string; plugins?: Record<string, JsonObject> }
type Extension = { id: string; version: string; source: string; installed: boolean; enabled: boolean; active: boolean; restartRequired: boolean }
function Section({ title, children }: { title: string; children: ReactNode }) { return <section className="rounded-2xl border border-border bg-card shadow-card"><h2 className="border-b border-border px-6 py-4 font-semibold">{title}</h2><div className="space-y-5 p-6">{children}</div></section> }
function ConnectionForm({ adapter, connection, refresh }: { adapter: string; connection?: Connection; refresh(): void }) {
  const tx = useText()
  const { apiClient } = useClient()
  // Ready-made defaults: the user types an API key, presses Test, and the
  // endpoint is already the provider's OpenAI-compatible URL.
  const defaultUrl = adapter === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai/' : 'https://api.openai.com/v1'
  const [url, setUrl] = useState(connection?.base_url ?? defaultUrl), [key, setKey] = useState(''), [clear, setClear] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [saved, setSaved] = useState(false)
  const [tested, setTested] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle'), [testError, setTestError] = useState('')
  async function test() {
    setTested('busy'); setTestError('')
    try {
      await apiClient.request('/api/v2/settings/test-connection', { method: 'POST', body: JSON.stringify({ base_url: url.trim(), ...(key.trim() ? { api_key: key.trim() } : {}) }) })
      setTested('ok'); refresh()
    } catch (failure) { setTested('fail'); setTestError(failure instanceof Error ? failure.message : String(failure)) }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(''); setSaved(false)
    try { await apiClient.request('/api/v2/settings', { method: 'PATCH', body: JSON.stringify({ connection: { adapter, base_url: url, ...(clear ? { api_key: null } : key ? { api_key: key } : {}) } }) }); setKey(''); setClear(false); setSaved(true); refresh() }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <form className="space-y-4 rounded-xl border border-border p-4" onSubmit={(event) => void save(event)}><h3 className="font-mono text-sm font-medium">{adapter}</h3><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`connection-${adapter}`}>{tx("Service URL", "服务地址", "អាសយដ្ឋានសេវាកម្ម")}</Label><Input id={`connection-${adapter}`} type="url" disabled={busy} value={url} onChange={(event) => { setUrl(event.target.value); setSaved(false) }} required /></div><div className="space-y-2"><Label htmlFor={`key-${adapter}`}>API Key{connection?.has_api_key ? tx(' · saved', ' · 已保存', ' · បានរក្សាទុក') : ''}</Label><Input id={`key-${adapter}`} type="password" disabled={busy} autoComplete="new-password" value={key} onChange={(event) => { setKey(event.target.value); setSaved(false) }} placeholder={connection?.has_api_key ? tx('Leave empty to keep the saved key', '留空保留已有密钥', 'ទុកទំនេរ ដើម្បីរក្សាកូនសោដែលមានស្រាប់') : ''} /></div></div>{connection?.has_api_key && <label className="flex gap-2 text-xs text-muted-foreground"><input type="checkbox" disabled={busy} checked={clear} onChange={(event) => { setClear(event.target.checked); setSaved(false) }} />{tx("Clear saved API key", "清除已保存密钥", "លុបកូនសោ API ដែលបានរក្សាទុក")}</label>}{error && <InlineAlert>{error}</InlineAlert>}<div className="flex flex-wrap items-center gap-2"><Button type="button" variant="ghost" disabled={busy || tested === 'busy' || !url.trim()} onClick={() => void test()}>{tested === 'busy' ? <Loader2 className="animate-spin" /> : tested === 'ok' ? <Check /> : <Plug />}{tested === 'busy' ? tx('Testing…', '正在测试…', 'កំពុងសាកល្បង…') : tx('Test connection', '测试连接', 'សាកល្បងការតភ្ជាប់')}</Button><Button type="submit" variant="outline" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : saved ? <Check /> : null}{saved ? tx('Saved', '已保存', 'បានរក្សាទុក') : tx('Save connection', '保存连接', 'រក្សាទុកការតភ្ជាប់')}</Button></div>{tested === 'ok' && <p role="status" className="text-xs text-status-success-fg">{tx('The connection works with a one-message test.', '连接测试通过。', 'ការតភ្ជាប់ដំណើរការត្រឹមត្រូវក្នុងតេស្តសារតែមួយ។')}</p>}{tested === 'fail' && <InlineAlert>{testError}</InlineAlert>}</form>
}
function Extensions() {
  const tx = useText()
  const { apiClient } = useClient()
  const { data, error, refresh } = useQuery<{ items: Extension[] }>('/api/v2/extensions')
  const [source, setSource] = useState(''), [ref, setRef] = useState(''), [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [notice, setNotice] = useState('')
  async function mutate(path: string, method: string, body?: JsonObject) {
    setBusy(true); setFailure(''); setNotice('')
    try { await apiClient.request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); setNotice(tx('Saved. Restart the service to apply.', '已保存，重启服务后生效。', 'បានរក្សាទុក។ ចាប់ផ្តើមសេវាកម្មឡើងវិញ ដើម្បីអនុវត្ត។')); refresh() }
    catch (err) { setFailure(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <Section title={tx("Extensions", "扩展", "ផ្នែកបន្ថែម")}><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void mutate('/api/v2/extensions/install', 'POST', { source, ...(ref ? { ref } : {}) }) }}><div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]"><div className="space-y-2"><Label htmlFor="extension-source">{tx("GitHub repository or local plugin path", "GitHub 仓库或本地插件路径", "ឃ្លាំង GitHub ឬផ្លូវផ្នែកបន្ថែមក្នុងម៉ាស៊ីន")}</Label><Input id="extension-source" value={source} onChange={(event) => setSource(event.target.value)} placeholder="https://github.com/owner/dubvibe_mini-plugin" required /></div><div className="space-y-2"><Label htmlFor="extension-ref">{tx("Version / commit", "版本 / commit", "កំណែ / commit")}</Label><Input id="extension-ref" value={ref} onChange={(event) => setRef(event.target.value)} /></div></div><p className="text-xs text-muted-foreground">{tx("Installation runs repository code and dependency scripts with this machine’s permissions.", "安装会运行仓库代码和依赖安装脚本，并使用本机权限。", "ការដំឡើងដំណើរការកូដឃ្លាំង និងស្គ្រីបអាស្រ័យ ដោយសិទ្ធិម៉ាស៊ីននេះ។")}</p><Button type="submit" disabled={busy || !source}>{busy ? <Loader2 className="animate-spin" /> : <Plug />}{tx("Install extension", "安装扩展", "ដំឡើងផ្នែកបន្ថែម")}</Button></form>{error && <InlineAlert>{error}</InlineAlert>}{failure && <InlineAlert>{failure}</InlineAlert>}{notice && <p role="status" className="text-sm text-status-success-fg">{notice}</p>}<div className="divide-y divide-border">{data?.items.map((item) => <div key={item.id} className="space-y-3 py-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium">{item.id} <span className="text-xs text-muted-foreground">{item.version}</span></p><p className="mt-1 break-all text-xs text-muted-foreground">{item.source}</p><p className="mt-2 text-xs">{item.active ? tx('Running', '运行中', 'កំពុងដំណើរការ') : item.enabled ? tx('Pending start', '待启动', 'រង់ចាំចាប់ផ្តើម') : tx('Disabled', '已停用', 'បានបិទ')}{item.restartRequired ? tx(' · restart required', ' · 重启后生效', ' · ត្រូវចាប់ផ្តើមឡើងវិញ') : ''}</p></div><div className="flex gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void mutate(`/api/v2/extensions/${encodeURIComponent(item.id)}`, 'PATCH', { enabled: !item.enabled })}>{item.enabled ? tx('Disable', '停用', 'បិទ') : tx('Enable', '启用', 'បើក')}</Button>{!item.enabled && !item.active && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(`/api/v2/extensions/${encodeURIComponent(item.id)}`, 'DELETE')}>{tx("Uninstall", "卸载", "លុបចេញ")}</Button>}</div></div></div>)}</div></Section>
}
function ExtensionSection({ id, component: Component, settings, refresh }: { id: string; component: React.ComponentType<SettingsSectionProps>; settings: SettingsData; refresh(): void }) {
  const { apiClient } = useClient()
  return <Component settings={settings.plugins?.[id] ?? {}} save={async (patch) => { await apiClient.request('/api/v2/settings', { method: 'PATCH', body: JSON.stringify({ plugin: { id, config: patch } }) }); refresh() }} />
}
function Settings() {
  const tx = useText()
  const { apiClient } = useClient()
  const [refreshing, setRefreshing] = useState(false), [runtimeError, setRuntimeError] = useState('')
  const { data: catalog, error: catalogError, refresh: refreshCatalog } = useQuery<Catalog>('/api/v2/catalog')
  const { data: settings, error, refresh } = useQuery<SettingsData>('/api/v2/settings')
  async function refreshRuntime() {
    if (refreshing) return
    setRefreshing(true); setRuntimeError('')
    try { await apiClient.request('/api/v2/runtime'); refreshCatalog() }
    catch (failure) { setRuntimeError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setRefreshing(false) }
  }
  const sections = useSlot('settings.sections')
  const { language } = useI18n()
  // Saved connections stay editable — unless the provider is keyless (Edge TTS
  // needs no Credentials or URL, so its card is hidden even if data was saved before).
  const keyless = new Set((catalog?.providers ?? []).filter((item) => item.requires_api_key === false).map((item) => item.adapter ?? item.id))
  const keyed = new Set((settings?.connections ?? []).map((item) => item.adapter).filter((adapter) => !keyless.has(adapter)))
  for (const item of catalog?.providers ?? []) if (item.requires_api_key !== false && item.models?.some((model) => typeof model === 'object' && model.devices?.includes('remote'))) keyed.add(item.adapter ?? item.id)
  const adapters = keyed
  return <main className="mx-auto max-w-5xl space-y-6 px-5 py-8 sm:px-8"><h1 className="text-2xl font-semibold">{tx("Settings", "设置", "ការកំណត់")}</h1>{error && <InlineAlert>{error}</InlineAlert>}<Section title={tx("Appearance", "界面", "រូបរាង")}><div className="flex items-center justify-between"><span className="text-sm">{tx("Language", "语言", "ភាសា")}</span><LanguageSwitcher /></div><div className="flex items-center justify-between"><span className="text-sm">{tx("Theme", "主题", "រចនាបថ")}</span><ThemeToggle /></div></Section>{settings && sections.map(({ id, component }) => <ExtensionSection key={id} id={id} component={component} settings={settings} refresh={refresh} />)}<ModelsSection /><Section title={tx("Runtime", "运行环境", "បរិស្ថានដំណើរការ")}><div className="flex justify-end"><Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void refreshRuntime()}><RefreshCw className={refreshing ? "animate-spin" : undefined} />{tx("Refresh", "刷新", "ធ្វើបច្ចុប្បន្នភាព")}</Button></div>{runtimeError && <InlineAlert>{runtimeError}</InlineAlert>}{catalogError && <InlineAlert>{catalogError}</InlineAlert>}<div className="divide-y divide-border">{catalog?.providers.map((provider) => <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><h3 className="text-sm font-medium">{text(provider.label, language) || provider.id}</h3><p className="mt-1 text-xs text-muted-foreground">{provider.operations.map((operation) => operation.id).join(' · ')}</p><p className="mt-1 font-mono text-xs text-subtle-foreground">{provider.models?.map((model) => typeof model === 'string' ? model : model.id).join(' · ')}</p></div><p className={`text-xs ${provider.available === false ? 'text-status-warning-fg' : 'text-status-success-fg'}`}>{provider.available === false ? provider.unavailableReason ?? provider.reason ?? tx('Unavailable', '未就绪', 'មិនអាចប្រើបាន') : tx('Ready', '已就绪', 'រួចរាល់')}</p></div>)}</div></Section>{settings && adapters.size > 0 && <Section title={tx("Connections", "服务连接", "ការតភ្ជាប់")}>{[...adapters].map((adapter) => <ConnectionForm key={adapter} adapter={adapter} connection={settings?.connections?.find((item) => item.adapter === adapter)} refresh={() => { refresh(); refreshCatalog() }} />)}</Section>}<Extensions /></main>
}
export const name = 'client-settings'
export const inject = ['slots', 'apiClient']
export function apply(ctx: Context) {
  ctx.effect(() => ctx.slots.register('shell.routes', { id: 'settings', path: '/settings', component: Settings, access: 'authenticated' }))
  ctx.effect(() => ctx.slots.register('shell.navigation', { id: 'settings', routeId: 'settings', label: { default: 'Settings', translations: { km: '\u1780\u17B6\u179A\u1780\u17C6\u178E\u178F\u17CB' } }, order: 30, icon: Settings2 }))
}
