import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import modelManifest from '../src/setup-models.json' with { type: 'json' }
import { catalogFor, removeFiles } from '../src/setup-catalog.js'

const manifestFor = (id: string) => modelManifest.find(model => model.id === id)!

test('catalog lists every manifest model and reports which files are present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-catalog-'))
  const whisper = manifestFor('whisper')
  const folder = join(root, 'whisper')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, whisper.files[0]!.path), 'fixture')
  const items = catalogFor({ folderFor: id => (id === 'whisper' ? folder : join(root, id)) })
  assert.deepEqual(items.map(item => item.id), modelManifest.map(model => model.id))
  assert.equal(items.find(item => item.id === 'whisper')!.installed, true)
  assert.equal(items.find(item => item.id === 'demucs')!.installed, false)
  assert.equal(items.find(item => item.id === 'whisper')!.optional, false)
  assert.equal(items.find(item => item.id === 'whisper-small')!.optional, true)
})

test('catalog carries the transfer progress of tracked models only', async () => {
  const tracked = { status: 'downloading' as const, received: 4096, total: 483617219, speed: 1024 }
  const items = catalogFor({ folderFor: id => join(tmpdir(), 'dubvibe_mini-progress', id), busy: () => true,
    progress: id => (id === 'whisper-small' ? tracked : undefined) })
  const small = items.find(item => item.id === 'whisper-small')!
  assert.equal(small.busy, true)
  assert.equal(small.status, 'downloading')
  assert.equal(small.received, 4096)
  assert.equal(small.total, 483617219)
  assert.equal(small.speed, 1024)
  assert.equal(items.find(item => item.id === 'whisper-base')!.status, undefined)
})

test('remove deletes only the model manifest files, never other files in the folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-remove-'))
  const whisper = manifestFor('whisper')
  await writeFile(join(root, whisper.files[0]!.path), 'model')
  await writeFile(join(root, 'keep-me.txt'), 'user data')
  await removeFiles(root, 'whisper')
  await assert.rejects(stat(join(root, whisper.files[0]!.path)))
  assert.equal(await readFile(join(root, 'keep-me.txt'), 'utf8'), 'user data')
})

test('remove rejects a model that is still downloading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-busy-'))
  await assert.rejects(removeFiles(root, 'whisper', { busy: true }), (error: any) => error.content?.error?.code === 'MODEL_BUSY' || error.code === 'MODEL_BUSY')
})

test('remove rejects an unknown model id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dubvibe_mini-unknown-'))
  await assert.rejects(removeFiles(root, 'not-a-model'), (error: any) => /Unknown model/.test(error.message))
})
