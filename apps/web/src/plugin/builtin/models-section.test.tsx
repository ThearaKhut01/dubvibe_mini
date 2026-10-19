import type { Context } from 'cordis'
import type { RequestInit } from 'undici'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/lib/i18n'
import { PluginContextProvider } from '../sdk'
import { ModelsSection } from './models-section'

afterEach(() => { cleanup(); window.localStorage.clear() })

const catalog = {
  items: [
    { id: 'whisper', name: 'Whisper', variant: 'tiny', purpose: 'Speech recognition', category: 'asr', optional: false, installed: true, busy: false, status: 'ready', received: 75572083, total: 75572083, speed: 0, files: [{ path: 'tiny.pt', size: 75572083, present: true }] },
    { id: 'demucs', name: 'Demucs', variant: 'htdemucs', purpose: 'Vocal separation', category: 'separation', optional: false, installed: false, busy: false, status: 'pending', received: 0, total: 84141911, speed: 0, files: [{ path: 'd.th', size: 84141911, present: false }] },
  ],
}

function clientWith(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    apiClient: { request },
    slots: { register: () => () => {}, subscribe: () => () => {}, getSnapshot: () => 0, list: () => [] },
    effect: (effect: () => unknown) => effect(),
  } as unknown as Context
}

it('shows Remove only for installed models and removes through the guarded route with the setup token', async () => {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/setup/models') return { items: catalog.items }
    if (path === '/api/setup') return { token: 'setup-token' }
    if (path === '/api/setup/models/whisper') return { items: [catalog.items[1]] }
    throw Object.assign(new Error('Unknown model.'), { status: 404 })
  })

  render(<PluginContextProvider context={clientWith(request)}> <LanguageProvider><ModelsSection /></LanguageProvider></PluginContextProvider>)
  // Groups start collapsed; open the category dropdown to reach the model row.
  fireEvent.click(await screen.findByRole('button', { name: /Speech recognition/ }))
  await screen.findByText('Whisper')
  expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: /Remove/ }))
  await waitFor(() => expect(screen.queryByText('Whisper')).not.toBeInTheDocument())

  const removal = request.mock.calls.find(([path, init]) => path === '/api/setup/models/whisper' && init?.method === 'DELETE')!
  expect(removal).toBeTruthy()
  expect((removal[1]!.headers as Record<string, string>)['X-dubvibe_mini-Setup']).toBe('setup-token')
})

it('downloads a missing model through the guarded POST route and pauses a running transfer', async () => {
  let items = catalog.items
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/setup/models') return { items }
    if (path === '/api/setup') return { token: 'setup-token' }
    if (path === '/api/setup/models/demucs') {
      const { action } = JSON.parse(String(init!.body)) as { action: string }
      items = [{ ...catalog.items[1], busy: action === 'start', status: action === 'start' ? 'downloading' : 'paused', received: 40 * 1024 ** 2, speed: 0 }]
      return { items }
    }
    throw Object.assign(new Error('Unknown model.'), { status: 404 })
  })

  render(<PluginContextProvider context={clientWith(request)}><LanguageProvider><ModelsSection /></LanguageProvider></PluginContextProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /Vocal separation/ }))
  await screen.findByText('Demucs')

  fireEvent.click(screen.getByRole('button', { name: /Download/ }))
  await screen.findByRole('button', { name: /Pause/ })
  fireEvent.click(screen.getByRole('button', { name: /Pause/ }))
  await screen.findByRole('button', { name: /Resume/ })

  const posts = request.mock.calls.filter(([path, init]) => path === '/api/setup/models/demucs' && init?.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ action: 'start' })
  expect(JSON.parse(String(posts[1]![1]!.body))).toEqual({ action: 'pause' })
})
