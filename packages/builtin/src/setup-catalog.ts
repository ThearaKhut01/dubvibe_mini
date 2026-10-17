import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError } from '@dubvibe_mini/sdk'
import modelManifest from './setup-models.json' with { type: 'json' }

export interface CatalogOptions {
  // Resolves a model id to its folder: the configured path when set, otherwise the default folder.
  folderFor: (id: string) => string
  busy?: (id: string) => boolean
}

export function catalogFor({ folderFor, busy }: CatalogOptions) {
  return modelManifest.map(definition => {
    const folder = folderFor(definition.id)
    const files = definition.files.map(file => ({ path: file.path, size: file.size, present: existsSync(join(folder, file.path)) }))
    return { id: definition.id, name: definition.name, variant: definition.variant, purpose: definition.purpose,
      installed: files.every(file => file.present), busy: busy?.(definition.id) ?? false, files }
  })
}

// Removes only the manifest files of one model. Never walks the folder or deletes unrelated files.
export async function removeFiles(folder: string, id: string, options: { busy?: boolean } = {}) {
  if (options.busy) throw new AppError('MODEL_BUSY', 'Stop the download before removing this model.', 409)
  const definition = modelManifest.find(item => item.id === id)
  if (!definition) throw new AppError('NOT_FOUND', 'Unknown model.', 404)
  for (const file of definition.files) await rm(join(folder, file.path), { force: true })
}
