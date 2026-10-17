import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LanguageProvider } from '@/lib/i18n'
import { ModelsSection } from './models-section'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear() })

const catalog = {
  items: [
    { id: 'whisper', name: 'Whisper', variant: 'tiny', purpose: 'Speech recognition', installed: true, busy: false, files: [{ path: 'tiny.pt', size: 75572083, present: true }] },
    { id: 'demucs', name: 'Demucs', variant: 'htdemucs', purpose: 'Vocal separation', installed: false, busy: false, files: [{ path: 'd.th', size: 84141911, present: false }] },
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
  await screen.findByText('Whisper')
  expect(screen.getAllByRole('button', { name: /Remove/ })).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: /Remove/ }))
  await waitFor(() => expect(screen.queryByText('Whisper')).not.toBeInTheDocument())

  const removal = calls.find(call => call.method === 'DELETE')!
  expect(removal.url).toBe('/api/setup/models/whisper')
  expect(removal.headers).toMatchObject({ 'X-dubvibe_mini-Setup': 'setup-token' })
})
