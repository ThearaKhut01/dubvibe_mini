import type { Context } from 'cordis'
import type { ComponentType } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/lib/i18n'
import { ThemeProvider } from '@/lib/theme'
import { PluginContextProvider, type RouteProps, type SlotMap } from './sdk'
import { apply } from './builtin/settings'

afterEach(() => { cleanup(); window.localStorage.clear() })
it('freezes connection inputs during saving and refreshes provider readiness after success', async () => {
  let finish!: (value: unknown) => void
  let saved = false
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return new Promise((resolve) => { finish = resolve })
    if (path === '/api/v2/settings') return { connections: [{ adapter: 'openai', base_url: 'https://example.test/v1', has_api_key: saved }] }
    if (path === '/api/v2/catalog') return { workflows: [], providers: [{ id: 'openai', adapter: 'openai', label: 'OpenAI', operations: [], available: saved, unavailableReason: 'Configure connection', models: [{ id: 'gpt', devices: ['remote'] }] }] }
    return { items: [] }
  })
  let Page!: ComponentType<RouteProps>
  const context = { apiClient: { request }, slots: {
    register: (slot: string, entry: SlotMap['shell.routes']) => { if (slot === 'shell.routes') Page = entry.component; return () => {} }, subscribe: () => () => {}, getSnapshot: () => 0, list: () => [],
  }, effect: (effect: () => unknown) => effect() } as unknown as Context
  apply(context)
  render(<PluginContextProvider context={context}><ThemeProvider><LanguageProvider><Page params={{}} /></LanguageProvider></ThemeProvider></PluginContextProvider>)
  const key = await screen.findByLabelText('API Key')
  const user = userEvent.setup()
  await user.type(key, 'new-key')
  await user.click(screen.getByRole('button', { name: 'Connect' }))
  expect(key).toBeDisabled()
  expect(screen.getByLabelText('Service URL')).toBeDisabled()
  saved = true
  await act(async () => finish({}))
  await screen.findByRole('button', { name: 'Saved' })
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/api/v2/catalog')).toHaveLength(2))
  expect(screen.getByText('Ready')).toBeInTheDocument()
  await user.type(key, 'changed-key')
  expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
})

it('hides the connection form for keyless remote providers like Edge TTS', async () => {
  const request = vi.fn(async (path: string) => {
    if (path === '/api/v2/settings') return { connections: [{ adapter: 'openai', base_url: 'https://example.test/v1', has_api_key: true }, { adapter: 'edge', base_url: 'https://api.msedgeservices.com/tts/cognitiveservices', has_api_key: true }] }
    if (path === '/api/v2/catalog') return { workflows: [], providers: [
      { id: 'edge', adapter: 'edge', label: 'Edge TTS', operations: [], available: true, requires_api_key: false, models: [{ id: 'km-KH-SreymomNeural', devices: ['remote'] }] },
      { id: 'openai', adapter: 'openai', label: 'OpenAI', operations: [], available: true, requires_api_key: true, models: [{ id: 'gpt', devices: ['remote'] }] },
    ] }
    return { items: [] }
  })
  let Page!: ComponentType<RouteProps>
  const context = { apiClient: { request }, slots: {
    register: (slot: string, entry: SlotMap['shell.routes']) => { if (slot === 'shell.routes') Page = entry.component; return () => {} }, subscribe: () => () => {}, getSnapshot: () => 0, list: () => [],
  }, effect: (effect: () => unknown) => effect() } as unknown as Context
  apply(context)
  render(<PluginContextProvider context={context}><ThemeProvider><LanguageProvider><Page params={{}} /></LanguageProvider></ThemeProvider></PluginContextProvider>)
  await screen.findByText('OpenAI-compatible')
  expect(screen.getByText('OpenAI-compatible')).toBeInTheDocument()
  // edge is keyless: no card even though a stale saved connection exists
  // (the Runtime list below still names the provider, so key on the card input id)
  expect(document.querySelector('#connection-edge')).toBeNull()
})

it('offers a Custom API card without a saved connection and sends its model to the probe', async () => {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true }
    if (path === '/api/v2/settings') return { connections: [] }
    if (path === '/api/v2/catalog') return { workflows: [], providers: [
      { id: 'openai', adapter: 'openai', label: 'OpenAI', operations: [], available: true, requires_api_key: true, models: [{ id: 'gpt', devices: ['remote'] }] },
      { id: 'custom', adapter: 'custom', label: 'Custom API', operations: [], available: false, requires_api_key: true, models: [{ id: 'gpt-4.1-mini', devices: ['remote'] }] },
    ] }
    return { items: [] }
  })
  let Page!: ComponentType<RouteProps>
  const context = { apiClient: { request }, slots: {
    register: (slot: string, entry: SlotMap['shell.routes']) => { if (slot === 'shell.routes') Page = entry.component; return () => {} }, subscribe: () => () => {}, getSnapshot: () => 0, list: () => [],
  }, effect: (effect: () => unknown) => effect() } as unknown as Context
  apply(context)
  render(<PluginContextProvider context={context}><ThemeProvider><LanguageProvider><Page params={{}} /></LanguageProvider></ThemeProvider></PluginContextProvider>)
  // The name appears both as the card title and in the Runtime list; only the card has a form.
  await screen.findAllByText('Custom API')
  const card = screen.getAllByText('Custom API').map(node => node.closest('form')).find(Boolean) as HTMLElement
  const url = within(card).getByLabelText('Service URL')
  expect(url).toHaveValue('')
  const user = userEvent.setup()
  fireEvent.change(url, { target: { value: 'https://router.example/v1' } })
  fireEvent.change(within(card).getByLabelText('Model for the test'), { target: { value: 'router/model' } })
  await user.click(within(card).getByRole('button', { name: 'Test connection' }))
  await within(card).findByText('The connection works with a one-message test.')
  const probe = JSON.parse(request.mock.calls.find(([path, init]) => path === '/api/v2/settings/test-connection' && init?.method === 'POST')![1]!.body as string)
  expect(probe.base_url).toBe('https://router.example/v1')
  expect(probe.model).toBe('router/model')
  expect(probe.api_key).toBeUndefined()
})

it('probes runtime before refreshing its catalog, serializes clicks and surfaces probe failures without retrying', async () => {
  let finish!: (value: unknown) => void
  let fail!: (error: Error) => void
  let ready = false
  const request = vi.fn(async (path: string) => {
    if (path === '/api/v2/runtime') return new Promise((resolve, reject) => { finish = resolve; fail = reject })
    if (path === '/api/v2/catalog') return { workflows: [], providers: [{ id: 'whisper', label: 'Whisper', operations: [], available: ready, unavailableReason: 'Model missing', models: [] }] }
    if (path === '/api/v2/settings') return { connections: [] }
    return { items: [] }
  })
  let Page!: ComponentType<RouteProps>
  const context = { apiClient: { request }, slots: {
    register: (slot: string, entry: SlotMap['shell.routes']) => { if (slot === 'shell.routes') Page = entry.component; return () => {} }, subscribe: () => () => {}, getSnapshot: () => 0, list: () => [],
  }, effect: (effect: () => unknown) => effect() } as unknown as Context
  apply(context)
  render(<PluginContextProvider context={context}><ThemeProvider><LanguageProvider><Page params={{}} /></LanguageProvider></ThemeProvider></PluginContextProvider>)
  await screen.findByText('Model missing')
  const button = screen.getByRole('button', { name: 'Refresh' })
  const user = userEvent.setup()
  await user.dblClick(button)
  expect(request.mock.calls.filter(([path]) => path === '/api/v2/runtime')).toHaveLength(1)
  expect(button).toBeDisabled()
  expect(request.mock.calls.filter(([path]) => path === '/api/v2/catalog')).toHaveLength(1)
  await act(async () => fail(new Error('Runtime probe failed')))
  await screen.findByText('Runtime probe failed')
  expect(button).toBeEnabled()
  expect(request.mock.calls.filter(([path]) => path === '/api/v2/runtime')).toHaveLength(1)
  expect(request.mock.calls.filter(([path]) => path === '/api/v2/catalog')).toHaveLength(1)
  await user.click(button)
  ready = true
  await act(async () => finish({}))
  await screen.findByText('Ready')
  expect(screen.queryByText('Runtime probe failed')).not.toBeInTheDocument()
  expect(request.mock.calls.map(([path]) => path).slice(-2)).toEqual(['/api/v2/runtime', '/api/v2/catalog'])
})
