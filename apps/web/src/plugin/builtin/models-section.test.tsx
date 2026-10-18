import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/lib/i18n'
import { ModelsSection } from './models-section'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

const catalog = {
  items: [
    { id: 'whisper', name: 'Whisper', variant: 'tiny', purpose: 'Speech recognition', category: 'asr', optional: false, installed: true, busy: false, status: 'ready', received: 75572083, total: 75572083, speed: 0, files: [{ path: 'tiny.pt', size: 75572083, present: true }] },
    { id: 'demucs', name: 'Demucs', variant: 'htdemucs', purpose: 'Vocal separation', category: 'separation', optional: false, installed: false, busy: false, status: 'pending', received: 0, total: 84141911, speed: 0, files: [{ path: 'd.th', size: 84141911, present: false }] },
  ],
}

it('shows Remove only for installed models and removes through the guarded route with the setup token', async () => {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, headers: init?.headers as Record<string, string> | undefined })
    if (url === '/api/setup/models' && !init?.method) return new Response(JSON.stringify(catalog))
    if (url === '/api/setup' && !init?.method) return new Response(JSON.stringify({ token: 'setup-token' }))
    if (url === '/api/setup/models/whisper' && init?.method === 'DELETE') return new Response(JSON.stringify({ items: [catalog.items[1]] }))
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<LanguageProvider><ModelsSection /></LanguageProvider>)
  // Groups start collapsed; open the category dropdown to reach the model row.
  fireEvent.click(await screen.findByRole('button', { name: /Speech recognition/ }))
  await screen.findByText('Whisper')
  expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: /Remove/ }))
  await waitFor(() => expect(screen.queryByText('Whisper')).not.toBeInTheDocument())

  const removal = calls.find(call => call.method === 'DELETE')!
  expect(removal.url).toBe('/api/setup/models/whisper')
  expect(removal.headers).toMatchObject({ 'X-dubvibe_mini-Setup': 'setup-token' })
})

it('downloads a missing model through the guarded POST route and pauses a running transfer', async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = []
  let items = catalog.items
  const fetching = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/setup/models' && !init?.method) return new Response(JSON.stringify({ items }))
    if (url === '/api/setup' && !init?.method) return new Response(JSON.stringify({ token: 'setup-token' }))
    if (url === '/api/setup/models/demucs' && init?.method === 'POST') {
      const { action } = JSON.parse(String(init.body))
      items = [{ ...catalog.items[1], busy: action === 'start', status: action === 'start' ? 'downloading' : 'paused', received: 40 * 1024 ** 2, speed: 0 }]
      return new Response(JSON.stringify({ items }))
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetching)

  render(<LanguageProvider><ModelsSection /></LanguageProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /Vocal separation/ }))
  await screen.findByText('Demucs')

  fireEvent.click(screen.getByRole('button', { name: /Download/ }))
  await screen.findByRole('button', { name: /Pause/ })
  fireEvent.click(screen.getByRole('button', { name: /Pause/ }))
  await screen.findByRole('button', { name: /Resume/ })

  const posts = calls.filter(call => call.method === 'POST')
  expect(posts).toHaveLength(2)
  expect(posts[0]).toMatchObject({ url: '/api/setup/models/demucs', body: { action: 'start' } })
  expect(posts[1]).toMatchObject({ url: '/api/setup/models/demucs', body: { action: 'pause' } })
})
