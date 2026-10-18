import { Service, type Context } from 'cordis'
import type { EntryOptions } from '@cordisjs/plugin-loader'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AppError } from '@dubvibe_mini/sdk'
import { readJson, type HttpRequest } from './http.js'
import { DownloadClient, fileSize } from './setup-download.js'
import { EnvironmentSetup, type EnvironmentConfig } from './setup-environment.js'
import modelManifest from './setup-models.json' with { type: 'json' }
import { catalogFor, removeFiles, type ModelProgress, type ModelStatus } from './setup-catalog.js'
import { readEnv } from './env'

export interface SetupConfig extends EnvironmentConfig { entries: EntryOptions[] }
export interface ModelDownload {
  id: string; name: string; variant: string; purpose: string; status: ModelStatus;
  received: number; total: number; speed: number; error?: string
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
function cancelled(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false
  while (error instanceof Error) {
    if (error === signal.reason) return true
    error = error.cause
  }
  return false
}
const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]', '::1', '::ffff:127.0.0.1'].includes(host)
const localPath = (path: string) => resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)
declare module 'cordis' { interface Context { setup: SetupService } }

export default class SetupService extends Service {
  static inject = ['http', 'process', 'loader']
  private client = new DownloadClient()
  private stopping = new AbortController()
  private token = randomBytes(32).toString('base64url')
  private environment: EnvironmentSetup
  private phase: 'environment' | 'models' | 'starting' | 'ready' | 'failed' = 'environment'
  private error?: string
  private bootAttempted = false
  private preparing?: Promise<void>
  private finishing?: Promise<void>
  private jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  // First-run gates only required models; optional entries (extra Whisper sizes) are downloaded on demand.
  private models: ModelDownload[] = modelManifest.filter(model => !model.optional).map(model => ({ id: model.id, name: model.name, variant: model.variant, purpose: model.purpose, status: 'pending', received: 0, total: model.files.reduce((sum, file) => sum + file.size, 0), speed: 0 }))
  private optionalModels = new Map<string, ModelDownload>()
  constructor(ctx: Context, private config: SetupConfig) {
    super(ctx, 'setup')
    this.environment = new EnvironmentSetup(ctx, config, this.client, this.stopping.signal)
    let started = false
    ctx.on('app/ready', () => { if (!started) { started = true; this.prepare() } })
    ctx.effect(() => async () => {
      this.stopping.abort(new Error('Application is stopping'))
      for (const { controller } of this.jobs.values()) controller.abort(new Error('Application is stopping'))
      await Promise.all([this.preparing, this.finishing, ...[...this.jobs.values()].map(job => job.promise)])
      await this.client.close()
    })
  }
  [Service.init]() {
    // This guard owns setup access even before Python-backed sessions exist.
    this.ctx.effect(() => this.ctx.http.use(async (request, next) => {
      if (!request.url.pathname.startsWith('/api/setup')) return next()
      this.guard(request)
      await next()
    }))
    this.ctx.effect(() => this.ctx.http.register('GET', '/api/setup', request => this.ctx.http.json(request, 200, this.snapshot())))
    this.ctx.effect(() => this.ctx.http.register('GET', '/api/setup/models', request => this.ctx.http.json(request, 200, { items: this.catalog() })))
    this.ctx.effect(() => this.ctx.http.register('DELETE', '/api/setup/models/:id', async request => {
      await this.remove(request.params!.id!)
      this.ctx.http.json(request, 200, { items: this.catalog() })
    }))
    this.ctx.effect(() => this.ctx.http.register('POST', '/api/setup/models/:id', async request => {
      const id = request.params!.id!
      if (!modelManifest.some(item => item.id === id)) throw new AppError('NOT_FOUND', 'Unknown model.', 404)
      if (this.phase === 'environment' || this.phase === 'starting') throw new AppError('ENVIRONMENT_NOT_READY', 'Wait for environment preparation to finish.', 409)
      const { action = 'start' } = await readJson(request)
      if (!['start', 'pause'].includes(action)) throw new AppError('INVALID_INPUT', 'Invalid model download action.', 422)
      if (action === 'pause') {
        const job = this.jobs.get(id)
        if (job) { job.controller.abort(new Error('Paused by user')); await job.promise }
        else if (!this.models.some(model => model.id === id)) this.optionalModels.delete(id)
      } else this.download(id)
      this.ctx.http.json(request, 200, { items: this.catalog() })
    }))
    this.ctx.effect(() => this.ctx.http.register('POST', '/api/setup', async request => {
      const { action, id } = await readJson(request)
      if (!['pause', 'resume', 'retry'].includes(action) || (id !== undefined && !this.models.some(model => model.id === id))) throw new AppError('INVALID_INPUT', 'Invalid setup action or model.', 422)
      if (this.phase === 'ready' || this.phase === 'starting') throw new AppError('SETUP_FINISHED', 'Environment preparation has finished.', 409)
      if (action === 'retry' && !id && this.phase === 'failed') {
        if (this.bootAttempted) throw new AppError('RESTART_REQUIRED', 'The workspace failed to start; review the error and restart the app.', 409)
        this.prepare()
      } else {
        if (this.phase !== 'models') throw new AppError('ENVIRONMENT_NOT_READY', 'Wait for environment preparation to finish.', 409)
        const targets = this.models.filter(model => (!id || model.id === id) && model.status !== 'ready')
        if (action === 'pause') {
          for (const model of targets) {
            const job = this.jobs.get(model.id)
            if (job) job.controller.abort(new Error('Paused by user'))
            else if (model.status !== 'failed') model.status = 'paused'
          }
          await Promise.all(targets.map(model => this.jobs.get(model.id)?.promise))
        } else for (const model of targets) if (['paused', 'failed', 'pending'].includes(model.status)) this.download(model.id)
      }
      this.ctx.http.json(request, 200, this.snapshot())
    }))
  }
  // Catalog and removal share the same folder rule as the first-run download (root()).
  catalog() {
    return catalogFor({
      folderFor: id => this.root(id),
      busy: id => this.jobs.has(id),
      progress: id => {
        const model = this.models.find(item => item.id === id) ?? this.optionalModels.get(id)
        return model && model.status !== 'pending' ? this.progressOf(model) : undefined
      },
    })
  }
  async remove(id: string) {
    await removeFiles(this.root(id), id, { busy: this.jobs.has(id) })
  }
  private guard(request: HttpRequest) {
    const host = new URL(`http://${request.raw.headers.host || 'invalid'}`).hostname
    const origin = request.raw.headers.origin
    if (!loopback(request.raw.socket.remoteAddress || '') || !loopback(host) || (origin && !loopback(new URL(origin).hostname))) throw new AppError('LOCAL_SETUP_ONLY', 'First-run environment preparation is only allowed from this machine.', 403)
    if (!['GET', 'HEAD'].includes(request.raw.method || '')) {
      const supplied = Buffer.from(String(request.raw.headers['x-dubvibe_mini-setup'] || ''))
      const expected = Buffer.from(this.token)
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError('CSRF_INVALID', 'Invalid setup token.', 403)
    }
  }
  snapshot() {
    return { phase: this.phase, platform: process.platform, arch: process.arch, environment: this.environment.steps,
      models: this.models, error: this.error, canRetry: !this.bootAttempted, token: this.token }
  }
  private root(id: string) {
    const model = modelManifest.find(model => model.id === id)!
    const configured = readEnv(model.env.replace(/^DUBVIBE_MINI_/, ''))
    return configured ? localPath(configured) : join(this.config.root, 'models', model.directory)
  }
  // Returns the tracked download state of one model, creating an on-demand record for optional entries.
  private modelFor(id: string): ModelDownload {
    const known = this.models.find(item => item.id === id) ?? this.optionalModels.get(id)
    if (known) return known
    const definition = modelManifest.find(item => item.id === id)!
    const model: ModelDownload = { id: definition.id, name: definition.name, variant: definition.variant, purpose: definition.purpose, status: 'pending', received: 0, total: definition.files.reduce((sum, file) => sum + file.size, 0), speed: 0 }
    this.optionalModels.set(definition.id, model)
    return model
  }
  private progressOf(model: ModelDownload): ModelProgress {
    return { status: model.status, received: model.received, total: model.total, speed: model.speed, error: model.error }
  }
  private fail(error: unknown) {
    if (cancelled(error, this.stopping.signal)) { this.ctx.logger.info('Environment preparation stopped with the application.'); return }
    this.phase = 'failed'; this.error = message(error); this.ctx.logger.error(error)
  }
  private prepare() {
    if (this.preparing) return
    this.phase = 'environment'; this.error = undefined
    this.preparing = (async () => {
      process.env.DUBVIBE_MINI_DESKTOP_DATA_DIR = this.config.root
      await this.environment.prepare()
      for (const model of this.models) {
        const definition = modelManifest.find(item => item.id === model.id)!
        const sizes = await Promise.all(definition.files.map(file => fileSize(join(this.root(model.id), file.path))))
        const ready = sizes.every((size, i) => size === definition.files[i]!.size)
        model.received = sizes.reduce((sum, size, i) => sum + (size === definition.files[i]!.size ? size : 0), 0)
        model.status = ready ? 'ready' : 'pending'
      }
      this.phase = 'models'
      for (const model of this.models) if (model.status !== 'ready') this.download(model.id)
      this.finishIfReady()
    })().catch(error => this.fail(error)).finally(() => { this.preparing = undefined })
  }
  private download(id: string) {
    if (this.jobs.has(id)) return
    const model = this.modelFor(id)
    const definition = modelManifest.find(item => item.id === id)!
    const controller = new AbortController()
    const signal = AbortSignal.any([this.stopping.signal, controller.signal])
    model.status = 'downloading'; model.error = undefined
    const promise = (async () => {
      let completed = 0, previousBytes = 0, previousTime = Date.now()
      for (const file of definition.files) {
        let firstProgress = true
        await this.client.download(file, join(this.root(id), file.path), signal, bytes => {
          model.received = completed + bytes
          if (firstProgress) { previousBytes = model.received; previousTime = Date.now(); firstProgress = false }
          const elapsed = (Date.now() - previousTime) / 1000
          if (elapsed >= 0.5) { model.speed = Math.max(0, (model.received - previousBytes) / elapsed); previousBytes = model.received; previousTime = Date.now() }
        })
        completed += file.size
        previousBytes = completed; previousTime = Date.now()
      }
      model.status = 'ready'
    })().catch(error => {
      if (cancelled(error, signal)) model.status = 'paused'
      else { model.status = 'failed'; model.error = message(error); this.ctx.logger.error(error) }
    }).finally(() => { model.speed = 0; this.jobs.delete(id); this.finishIfReady() })
    this.jobs.set(id, { controller, promise })
  }
  private finishIfReady() {
    if (this.phase !== 'models' || this.finishing || !this.models.every(model => model.status === 'ready') || this.stopping.signal.aborted) return
    this.phase = 'starting'
    this.finishing = (async () => {
      await this.environment.probe('verify')
      this.bootAttempted = true
      for (const entry of this.config.entries) await this.ctx.loader.create(entry)
      await this.ctx.loader.await()
      const unavailable = [...this.ctx.loader.entries()].filter(entry => !entry.disabled && (!entry.fiber || entry.fiber.state !== 2))
      if (unavailable.length) throw new Error(`Workspace plugins failed to start: ${unavailable.map(entry => entry.options.id).join(', ')}`)
      this.ctx.emit('app/ready')
      this.phase = 'ready'
    })().catch(error => this.fail(error)).finally(() => { this.finishing = undefined })
  }
}
