import { readEnv } from '../../../packages/builtin/src/env'
import { resolve, join, sep } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export function directoryURL(directory: string) {
  // Preserve the trailing separator so relative URLs resolve inside the directory.
  return pathToFileURL(join(resolve(directory), sep)).href
}

export function runtimePaths(dataDirectory = readEnv('DESKTOP_DATA_DIR')) {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'YouDub')
    : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'dubvibe_mini')
      : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'youdub')
  const environment = readEnv('PYTHON_ENV_DIR') || '.venv'
  return { root: resolve(dataDirectory || base), repoRoot: resolve('.'), python: resolve(readEnv('PYTHON') || join(environment, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')) }
}
