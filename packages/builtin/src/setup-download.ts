import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EnvHttpProxyAgent, fetch } from 'undici'

export interface DownloadFile { url: string; size: number; sha256: string; path: string }
export async function fileSize(path: string): Promise<number> {
  try { const info = await stat(path); return info.isFile() ? info.size : 0 }
  catch (error: any) { if (error.code === 'ENOENT') return 0; throw error }
}
export async function checksum(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export function downloadError(error: unknown, url: string): Error {
  const causes: string[] = []
  let current: unknown = error
  while (current instanceof Error) { causes.push(current.message); current = current.cause }
  return new Error(`Download failed: ${url}\n${causes.join('\n')}`, { cause: error })
}

/** One owner, no automatic retries. A paused transfer keeps its .part file. */
export class DownloadClient {
  private agent = new EnvHttpProxyAgent({ connect: { timeout: 30_000 } })
  close() { return this.agent.close() }
  async json(url: string, signal: AbortSignal) {
    const response = await fetch(url, { dispatcher: this.agent, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }).catch(error => { throw downloadError(error, url) })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
    return response.json() as Promise<any>
  }
  async download(file: DownloadFile, target: string, signal: AbortSignal, progress: (bytes: number) => void) {
    signal.throwIfAborted()
    await mkdir(dirname(target), { recursive: true })
    const present = await fileSize(target)
    if (present) {
      if (present !== file.size || !(await checksum(target)).startsWith(file.sha256)) throw new Error(`File verification failed: ${target}. Move the file away and retry.`)
      progress(present); return
    }
    const partial = target + '.part'
    let received = await fileSize(partial)
    if (received > file.size) throw new Error(`Partial file exceeds the expected size: ${partial}. Move it away and retry.`)
    progress(received)
    if (received < file.size) {
      const response = await fetch(file.url, { dispatcher: this.agent, signal, headers: { 'Accept-Encoding': 'identity', ...(received ? { Range: `bytes=${received}-` } : {}) } }).catch(error => { throw downloadError(error, file.url) })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${file.url}`)
      if (received && (response.status !== 206 || !response.headers.get('content-range')?.startsWith(`bytes ${received}-`))) {
        await response.body.cancel()
        throw new Error(`The download source rejected resume offset ${received}: ${file.url}. Move ${partial} away and download again.`)
      }
      const output = await open(partial, received ? 'a' : 'w', 0o600)
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted()
          if (received + chunk.length > file.size) throw new Error(`Downloaded content exceeds the manifest size: ${file.url}`)
          let offset = 0
          while (offset < chunk.length) { const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset); offset += bytesWritten }
          received += chunk.length; progress(received)
        }
      } catch (error) { throw downloadError(error, file.url) }
      finally { await output.close() }
    }
    signal.throwIfAborted()
    if (received !== file.size) throw new Error(`Download incomplete: ${target} (${received}/${file.size})`)
    if (!(await checksum(partial)).startsWith(file.sha256)) throw new Error(`Download verification failed: ${partial}. Move the file away and retry.`)
    signal.throwIfAborted()
    await rename(partial, target)
  }
}
