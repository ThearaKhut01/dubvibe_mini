import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@dubvibe_mini/sdk'
import modelManifest from './setup-models.json' with { type: 'json' }

export type ModelStatus = 'pending' | 'downloading' | 'paused' | 'ready' | 'failed'
export interface ModelProgress { status: ModelStatus; received: number; total: number; speed: number; error?: string }

export interface CatalogOptions {
  // Resolves a model id to its folder: the configured path when set, otherwise the default folder.
  folderFor: (id: string) => string
  busy?: (id: string) => boolean
  // Transfer state when the caller tracks a download (first-run rollers, on-demand catalog downloads).
  progress?: (id: string) => ModelProgress | undefined
}

export function catalogFor({ folderFor, busy, progress }: CatalogOptions) {
  return modelManifest.map(definition => {
    const folder = folderFor(definition.id)
    const files = definition.files.map(file => ({ path: file.path, size: file.size, present: existsSync(join(folder, file.path)) }))
    const tracked = progress?.(definition.id)
    return { id: definition.id, name: definition.name, variant: definition.variant, purpose: definition.purpose,
      optional: definition.optional ?? false, installed: files.every(file => file.present), busy: busy?.(definition.id) ?? false, files,
      status: tracked?.status, received: tracked?.received ?? 0, total: files.reduce((sum, file) => sum + file.size, 0), speed: tracked?.speed ?? 0, error: tracked?.error }
  })
}

// Removes only the manifest files of one model. Never walks the folder or deletes unrelated files.
export async function removeFiles(folder: string, id: string, options: { busy?: boolean } = {}) {
  if (options.busy) throw new AppError('MODEL_BUSY', 'Stop the download before removing this model.', 409)
  const definition = modelManifest.find(item => item.id === id)
  if (!definition) throw new AppError('NOT_FOUND', 'Unknown model.', 404)
  for (const file of definition.files) await rm(join(folder, file.path), { force: true })
}
