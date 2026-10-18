import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import { mkdtemp, mkdir, writeFile, readFile, open, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { delimiter, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import Http from '../src/http.js'
import Setup from '../src/setup.js'
import { DownloadClient } from '../src/setup-download.js'
import { EnvironmentSetup } from '../src/setup-environment.js'
import { runtimePaths } from '../../../apps/host/src/paths.js'

function probeResult(action: string) {
  if (action === 'dependencies') return { missing: [] }
  if (action === 'acceleration-plan') return { backend: 'cpu', installed: true, version: '2.8.0', codec: '0.7.0', packages: [], prerequisites: [], detail: 'CPU' }
  if (action === 'acceleration') return { backend: 'cpu', detail: 'CPU（运算检查通过）' }
  return { ready: true }
}

test('Windows first-run UV extraction preserves Unicode paths without an installed Python', { skip: process.platform !== 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-unicode-archive-'))
  const source = join(root, '压缩来源'), fixture = join(root, '工具.zip')
  const data = join(root, "用户 空格 # % ' [测试]")
  await mkdir(source)
  await writeFile(join(source, 'uv.exe'), 'archive fixture, never executed')
  const shell = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const run = promisify(execFile)
  await run(shell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:DUBVIBE_MINI_TEST_SOURCE, $env:DUBVIBE_MINI_TEST_ARCHIVE)"],
  { windowsHide: true, env: { ...process.env, DUBVIBE_MINI_TEST_SOURCE: source, DUBVIBE_MINI_TEST_ARCHIVE: fixture } })
  const previous = { PATH: process.env.PATH, YOUDUB_PYTHON: process.env.YOUDUB_PYTHON }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true })
  })
  process.env.PATH = join(process.env.SystemRoot || 'C:/Windows', 'System32')
  delete process.env.YOUDUB_PYTHON
  const stop = new Error('Stop before downloading Python')
  let extracted = false
  const ctx = { process: { run: async ({ command, args, env }: { command: string; args: string[]; env?: Record<string, string> }) => {
    if (command === shell) return run(command, args, { windowsHide: true, env: { ...process.env, ...env } })
    assert.equal(command, join(data, 'runtime', 'uv', 'uv.exe'))
    assert.equal(await readFile(command, 'utf8'), 'archive fixture, never executed')
    extracted = true
    throw stop
  } } } as unknown as Context
  const client = new DownloadClient()
  t.mock.method(client, 'json', async () => ({ assets: [{ name: 'uv-x86_64-pc-windows-msvc.zip', digest: 'sha256:fixture', browser_download_url: 'https://example.test/uv.zip', size: 1 }] }))
  t.mock.method(client, 'download', async (_asset: unknown, destination: string) => { await mkdir(join(data, 'runtime', 'uv'), { recursive: true }); await cp(fixture, destination) })
  const setup = new EnvironmentSetup(ctx, { root: data, repoRoot: resolve('.'), python: join(data, 'runtime', 'venv', 'Scripts', 'python.exe') }, client, new AbortController().signal)
  await assert.rejects(setup.prepare(), error => error === stop)
  assert.equal(extracted, true)
})

test('desktop Python is created in the writable data directory without modifying the application bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-desktop-environment-'))
  const environment = join(root, 'runtime/venv')
  const bin = join(root, 'python-bin')
  const media = join(root, 'media-bin')
  await mkdir(bin); await mkdir(media)
  const windows = process.platform === 'win32'
  const executable = join(bin, windows ? 'python.exe' : 'python3.12')
  await writeFile(executable, 'test executable', { mode: 0o700 })
  await writeFile(join(media, 'ffmpeg'), 'test executable', { mode: 0o700 })
  if (windows) await writeFile(join(media, 'avcodec-test.dll'), 'test shared library')
  const previous = { ...process.env }
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]
    Object.assign(process.env, previous)
    await rm(root, { recursive: true })
  })
  process.env.PATH = bin
  delete process.env.YOUDUB_PYTHON
  process.env.YOUDUB_PYTHON_ENV_DIR = environment
  process.env.FFMPEG_PATH = join(media, 'ffmpeg')
  process.env.FFPROBE_PATH = join(media, 'ffmpeg')
  const { python } = runtimePaths(root)
  assert.equal(python, join(environment, windows ? 'Scripts/python.exe' : 'bin/python'))
  const commands: string[][] = []
  const ctx = { process: { run: async ({ args }: { args: string[] }) => {
    commands.push(args)
    if (args[1] === 'venv') {
      await mkdir(join(args[2]!, windows ? 'Scripts' : 'bin'), { recursive: true })
      await writeFile(python, 'test executable')
    }
    return { stderr: '', stdout: args[1] === 'backend.workers.setup_probe' ? JSON.stringify(probeResult(args[2]!)) : args.includes('-filters') ? ' ... subtitles ... ' : '3.12\n' }
  } } } as unknown as Context
  const setup = new EnvironmentSetup(ctx, { root, repoRoot: resolve('.'), python }, new DownloadClient(), new AbortController().signal)
  await setup.prepare()
  assert.ok(commands.some(args => args[1] === 'venv' && args[2] === environment))
  assert.equal(process.env.PATH?.split(delimiter)[0], media)
  assert.ok(setup.steps.every(step => step.status === 'ready'))
})

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('setup test timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}
for (const unrelatedFailure of [false, true]) test(`closing first-run setup ${unrelatedFailure ? 'preserves unrelated errors' : 'cancels preparation without reporting a failure'}`, async t => {
  const previous = process.env.YOUDUB_DESKTOP_DATA_DIR
  const originalError = new Error('dependency download failed')
  let started = false
  t.mock.method(EnvironmentSetup.prototype, 'prepare', async function(this: any) {
    started = true
    await new Promise<void>((_resolve, reject) => this.signal.addEventListener('abort', () => {
      reject(unrelatedFailure ? originalError : new Error('download interrupted', { cause: this.signal.reason }))
    }, { once: true }))
  })
  const ctx = new Context()
  const errors: unknown[] = []
  const logging = ctx.logger.exporter({ export(entry) { if (entry.type === 'error') errors.push(...entry.args) } })
  const app = await ctx.plugin(async function shutdownTest(owner) {
    owner.reflect.provide('process', { run: async () => { throw new Error('unexpected process') } })
    owner.reflect.provide('loader', {})
    await owner.plugin(Http, { host: '127.0.0.1', port: 0 })
    await owner.plugin(Setup, { root: tmpdir(), repoRoot: resolve('.'), python: '/unused/python', entries: [] })
  })
  t.after(async () => {
    await app.dispose(); await logging()
    if (previous === undefined) delete process.env.YOUDUB_DESKTOP_DATA_DIR
    else process.env.YOUDUB_DESKTOP_DATA_DIR = previous
  })
  ctx.emit('app/ready')
  await waitFor(() => started)
  await app.dispose()
  assert.deepEqual(errors, unrelatedFailure ? [originalError] : [])
})

test('first-run API runs four models concurrently, pauses independently, guards mutations and starts runtime only after completion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-first-run-'))
  const python = join(root, 'python')
  await writeFile(python, 'test executable')
  if (process.platform === 'win32') await writeFile(join(root, 'avcodec-test.dll'), 'test shared library')
  const previous = { FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH, YOUDUB_DESKTOP_DATA_DIR: process.env.YOUDUB_DESKTOP_DATA_DIR, NLTK_DATA: process.env.NLTK_DATA }
  process.env.FFMPEG_PATH = python; process.env.FFPROBE_PATH = python
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started: string[] = [], created: string[] = []
  t.mock.method(DownloadClient.prototype, 'download', async function(file: any, target: string, signal: AbortSignal, progress: (value: number) => void) {
    started.push(target); progress(1)
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      gate.then(() => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve() })
    })
    progress(file.size)
  })
  const ctx = new Context()
  const app = await ctx.plugin(async function setupTest(owner) {
    owner.reflect.provide('process', { run: async ({ args }: { args: string[] }) => ({ stderr: '', stdout: args[1] === 'backend.workers.setup_probe' ? JSON.stringify(probeResult(args[2]!)) : args.includes('-filters') ? ' ... subtitles ... ' : '3.12.12\n' }) })
    owner.reflect.provide('loader', { create: async (entry: any) => { created.push(entry.id) }, await: async () => {}, *entries() {} })
    await owner.plugin(Http, { host: '127.0.0.1', port: 0 })
    await owner.plugin(Setup, { root, repoRoot: resolve('.'), python, entries: [{ id: 'runtime', name: 'runtime' }] })
  })
  t.after(async () => {
    release(); await app.dispose()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true })
  })
  ctx.emit('app/ready')
  await waitFor(() => started.length === 4)
  const url = ctx.http.address + '/api/setup'
  const state = await (await fetch(url)).json() as any
  assert.equal(state.models.filter((model: any) => model.status === 'downloading').length, 4)
  assert.deepEqual(created, [])
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status, 403)
  const action = (action: string, id?: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-dubvibe_mini-Setup': state.token }, body: JSON.stringify({ action, id }) })
  assert.equal((await action('pause', 'unknown')).status, 422)
  const paused = await (await action('pause', 'whisper')).json() as any
  assert.equal(paused.models.find((model: any) => model.id === 'whisper').status, 'paused')
  assert.equal(paused.models.filter((model: any) => model.status === 'downloading').length, 3)
  assert.equal((await action('resume', 'whisper')).status, 200)
  await waitFor(() => started.length === 5)
  release()
  await waitFor(() => ctx.setup.snapshot().phase === 'ready')
  assert.deepEqual(created, ['runtime'])
  assert.equal(ctx.setup.snapshot().models.length, 4)
  assert.ok(ctx.setup.snapshot().models.every(model => model.status === 'ready'))
  assert.equal((await action('resume')).status, 409)
})

test('optional Whisper sizes download on demand after first-run finishes, with pause, resume and guards', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-optional-'))
  const python = join(root, 'python')
  await writeFile(python, 'test executable')
  if (process.platform === 'win32') await writeFile(join(root, 'avcodec-test.dll'), 'test shared library')
  const previous = { FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH, YOUDUB_DESKTOP_DATA_DIR: process.env.YOUDUB_DESKTOP_DATA_DIR, NLTK_DATA: process.env.NLTK_DATA }
  process.env.FFMPEG_PATH = python; process.env.FFPROBE_PATH = python
  let release!: () => void
  const firstRun = new Promise<void>(resolve => { release = resolve })
  let releaseOptional!: () => void
  const optional = new Promise<void>(resolve => { releaseOptional = resolve })
  const started: string[] = []
  t.mock.method(DownloadClient.prototype, 'download', async function(file: any, target: string, signal: AbortSignal, progress: (value: number) => void) {
    started.push(target); progress(1)
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      void (target.endsWith('small.pt') ? optional : firstRun).then(() => {
        signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve()
      })
    })
    await mkdir(dirname(target), { recursive: true })
    const handle = await open(target, 'w', 0o600)
    await handle.truncate(file.size)
    await handle.close()
    progress(file.size)
  })
  const ctx = new Context()
  const app = await ctx.plugin(async function optionalDownload(owner) {
    owner.reflect.provide('process', { run: async ({ args }: { args: string[] }) => ({ stderr: '', stdout: args[1] === 'backend.workers.setup_probe' ? JSON.stringify(probeResult(args[2]!)) : args.includes('-filters') ? ' ... subtitles ... ' : '3.12.12\n' }) })
    owner.reflect.provide('loader', { create: async () => { throw new Error('unexpected plugin') }, await: async () => {}, *entries() {} })
    await owner.plugin(Http, { host: '127.0.0.1', port: 0 })
    await owner.plugin(Setup, { root, repoRoot: resolve('.'), python, entries: [] })
  })
  t.after(async () => {
    release(); releaseOptional(); await app.dispose()
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(root, { recursive: true })
  })
  ctx.emit('app/ready')
  await waitFor(() => started.length === 4)
  release()
  await waitFor(() => ctx.setup.snapshot().phase === 'ready')

  // First-run state stays untouched: four required models, all ready, no optional ones.
  assert.equal(ctx.setup.snapshot().models.length, 4)
  const models = await (await fetch(`${ctx.http.address}/api/setup/models`)).json() as any
  assert.equal(models.items.length, 15)
  const small = models.items.find((item: any) => item.id === 'whisper-small')
  assert.equal(small.optional, true)
  assert.equal(small.installed, false)
  assert.equal(small.status, undefined)

  const state = await (await fetch(`${ctx.http.address}/api/setup`)).json() as any
  const download = (id: string, action: 'start' | 'pause' = 'start') => fetch(`${ctx.http.address}/api/setup/models/${id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-dubvibe_mini-Setup': state.token }, body: JSON.stringify({ action }) })
  assert.equal((await fetch(`${ctx.http.address}/api/setup/models/whisper-small`, { method: 'POST', body: '{}' })).status, 403)
  assert.equal((await download('not-a-model')).status, 404)
  assert.equal((await download('whisper-small', 'restart' as any)).status, 422)

  const smallDownloads = () => started.filter(target => target.endsWith('small.pt')).length
  const starting = await (await download('whisper-small')).json() as any
  const active = starting.items.find((item: any) => item.id === 'whisper-small')
  assert.equal(active.busy, true)
  assert.equal(active.status, 'downloading')
  await waitFor(() => smallDownloads() === 1)

  const paused = await (await download('whisper-small', 'pause')).json() as any
  const held = paused.items.find((item: any) => item.id === 'whisper-small')
  assert.equal(held.busy, false)
  assert.equal(held.status, 'paused')

  await download('whisper-small')
  await waitFor(() => smallDownloads() === 2)
  releaseOptional()
  const target = join(root, 'models', 'whisper', 'small.pt')
  await waitFor(() => existsSync(target))
  const fresh = await (await fetch(`${ctx.http.address}/api/setup/models`)).json() as any
  const finished = fresh.items.find((item: any) => item.id === 'whisper-small')
  assert.equal(finished.installed, true)
  assert.equal(finished.busy, false)
  assert.equal(finished.status, 'ready')
  assert.equal(ctx.setup.snapshot().models.length, 4)
  assert.equal(ctx.setup.snapshot().phase, 'ready')
})
