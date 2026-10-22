import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from 'cordis'
import Catalog from '../src/catalog.js'
import * as Localize from '../src/workflow-localize.js'

test('localize requires available media tools before accepting any output mode', async t => {
  const ctx = new Context()
  let available = false
  const app = await ctx.plugin(async context => {
    context.reflect.provide('settings', { read: async () => ({ defaults: null, connections: [] }) })
    await context.plugin(Catalog)
    await context.plugin({ inject: ['catalog'], apply(scope) {
      for (const capability of ['download', 'media', 'asr', 'translation', 'tts', 'separation']) {
        const id = ['download', 'media'].includes(capability) ? `youdub.${capability}` : capability
        scope.effect(() => scope.catalog.registerProvider({
        id,
        describe: () => ({ id, label: id, capability, adapter: id, pluginId: id, pluginVersion: '1', integrity: 'test', operations: [], available: capability === 'media' ? available : true, unavailableReason: 'ffmpeg unavailable', models: [{ id: 'test', devices: ['cpu'], source_languages: ['en'], target_languages: ['zh'], voice_modes: ['source_clone'] }] }),
        probe: async () => ({}), execute: async () => { throw new Error('No execution expected') },
        }))
      }
    } })
    await context.plugin(Localize, { integrity: 'test' })
  })
  t.after(() => app.dispose())
  const defaults = ctx.catalog.describe().workflows[0].defaults
  assert.equal(defaults.asr.adapter, 'asr')
  assert.equal(defaults.translation.adapter, 'translation')
  const select = (adapter: string) => ({ adapter, model: 'test', device: 'cpu' })
  for (const output_mode of ['subtitles', 'dubbing', 'both']) {
    const config = { source_language: 'en', target_language: 'zh', output_mode, keep_background: false, asr: select('asr'), translation: select('translation'), tts: output_mode === 'subtitles' ? null : { ...select('tts'), voice: { mode: 'source_clone' } }, separation: output_mode === 'subtitles' ? null : select('separation') }
    const workflow = ctx.catalog.workflow('youdub.localize')
    available = false
    assert.deepEqual(await workflow.validate({ video: { id: "input-video", schemaId: "video/mp4/v1" } }, config, ctx.catalog), [{ code: 'INVALID_CONFIG', message: 'ffmpeg unavailable', field: 'video' }])
    available = true
    const linked = { ...config, source_url: 'https://youtu.be/jNQXAC9IVRw' }
    assert.deepEqual(await workflow.validate({}, linked, ctx.catalog), [])
    assert.ok((await workflow.validate({}, config, ctx.catalog)).some(error => error.field === 'video'))
    assert.ok((await workflow.validate({ video: { id: 'input-video', schemaId: 'video/mp4/v1' } }, linked, ctx.catalog)).some(error => error.field === 'video'))
    const plan = await workflow.plan({}, linked, ctx.catalog)
    assert.equal(plan.steps[0].operation, 'media.download/v1')
    assert.deepEqual(plan.steps[0].input, { url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' })
    for (const id of ['prepare', 'export']) assert.deepEqual(plan.steps.find(step => step.id === id)?.input.video, { from: 'step', stepId: 'download', output: 'video' })
    const uploaded = await workflow.plan({ video: { id: 'input-video', schemaId: 'video/mp4/v1' } }, config, ctx.catalog)
    assert.equal(uploaded.steps[0].id, 'prepare')
    assert.deepEqual(uploaded.steps[0].input.video, { from: 'task', name: 'video' })
    assert.deepEqual(await workflow.validate({ video: { id: "input-video", schemaId: "video/mp4/v1" } }, config, ctx.catalog), [])
  }
})

test('localize config accepts the optional translation fallback chain from saved defaults', async t => {
  const { default: Ajv } = await import('ajv/dist/2020.js')
  const validator = new (Ajv as any)({ allErrors: true, strict: false })
  const assertValid = (value: unknown) => validator.validate(Localize.localizeSchema, value)
  const select = (adapter: string) => ({ adapter, model: 'test', device: 'cpu' })
  const base = { source_language: 'auto', target_language: 'km', output_mode: 'dubbing', keep_background: true,
    asr: { ...select('whisper'), initial_prompt: null }, translation: select('nllb'), tts: null, separation: null, subtitle_alignment: null }
  // Defaults written by the API carry both fallback keys, usually as null.
  assert.equal(assertValid({ ...base, translation_providers: null, translation_models: null }), true)
  assert.equal(assertValid({ ...base, subtitle_alignment: null,
    tts: { ...select('edge'), voice: { mode: 'preset', id: 'km-KH-SreymomNeural' } },
    translation_providers: ['nllb', 'hy_mt'], translation_models: { nllb: 'NLLB-200-distilled-600M' } }), true)
  assert.equal(assertValid({ ...base, stranger: 1 }), false)
  assert.ok(validator.errors!.every((error: { message?: string }) => error.message!.includes('additional properties')))
  // Render parts: absent/null renders one pass, whole minutes 1..1440 are valid.
  assert.equal(assertValid({ ...base, chunk_minutes: null }), true)
  assert.equal(assertValid({ ...base, chunk_minutes: 2 }), true)
  assert.equal(assertValid({ ...base, chunk_minutes: 1440 }), true)
  for (const chunk_minutes of [0, -1, 1441, 2.5, '2']) assert.equal(assertValid({ ...base, chunk_minutes }), false)
})

test('localize cuts the requested clip before prepare and export', async t => {
  const ctx = new Context()
  const app = await ctx.plugin(async context => {
    context.reflect.provide('settings', { read: async () => ({ defaults: null, connections: [] }) })
    await context.plugin(Catalog)
    await context.plugin({ inject: ['catalog'], apply(scope) {
      for (const capability of ['download', 'media', 'asr', 'translation']) {
        const id = capability === 'media' ? 'youdub.media' : capability === 'download' ? 'youdub.download' : capability
        scope.effect(() => scope.catalog.registerProvider({
          id, describe: () => ({ id, label: id, capability, adapter: id, pluginId: id, pluginVersion: '1', integrity: 'test',
            operations: [], available: true, unavailableReason: null,
            models: capability === 'media' ? [] : [{ id: 'test', devices: ['cpu'], source_languages: ['en'], target_languages: ['zh'], voice_modes: ['source_clone'] }] }),
          probe: async () => ({}), execute: async () => { throw new Error('No execution expected') },
        }))
      }
    } })
    await context.plugin(Localize, { integrity: 'test' })
  })
  t.after(() => app.dispose())
  const workflow = ctx.catalog.workflow('youdub.localize')
  const select = (adapter: string) => ({ adapter, model: 'test', device: 'cpu' })
  const base = { source_language: 'en', target_language: 'zh', output_mode: 'subtitles', keep_background: false,
    asr: select('asr'), translation: select('translation'), tts: null, separation: null }
  const inputs = { video: { id: 'input-video', schemaId: 'video/mp4/v1' } }
  const plan = await workflow.plan(inputs, { ...base, trim: { start_ms: 120_000, end_ms: 420_000 } }, ctx.catalog)
  assert.deepEqual(plan.steps.slice(0, 3).map(step => step.id), ['cut', 'prepare', 'recognize'])
  assert.equal(plan.steps[0].operation, 'media.cut/v1')
  assert.deepEqual(plan.steps[0].input, { video: { from: 'task', name: 'video' }, start_ms: 120_000, end_ms: 420_000 })
  for (const id of ['prepare', 'export']) {
    assert.deepEqual(plan.steps.find(step => step.id === id)?.input.video, { from: 'step', stepId: 'cut', output: 'video' })
  }
  // The same workflow without a clip keeps the original single prepare step.
  const plain = await workflow.plan(inputs, base, ctx.catalog)
  assert.equal(plain.steps[0].id, 'prepare')
  assert.deepEqual(plain.steps[0].input.video, { from: 'task', name: 'video' })
  // A clip also lifts the download duration gate: only the clip is processed.
  const linked = { ...base, source_url: 'https://youtu.be/jNQXAC9IVRw', trim: { start_ms: 0, end_ms: 300_000 } }
  const downloaded = await workflow.plan({}, linked, ctx.catalog)
  assert.deepEqual(downloaded.steps.slice(0, 3).map(step => step.id), ['download', 'cut', 'prepare'])
  assert.equal(downloaded.bindings.download.options.maxDurationMs, 86_400_000)
  const diagnostics = await workflow.validate(inputs, { ...base, trim: { start_ms: 2000, end_ms: 2000 } }, ctx.catalog)
  assert.deepEqual(diagnostics.map(item => item.field), ['trim'])
  assert.deepEqual(await workflow.validate(inputs, base, ctx.catalog), [])
})
