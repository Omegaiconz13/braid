#!/usr/bin/env node
/**
 * Builds the headless Plexo daemon and its CLI into out/daemon/app.
 *
 * The daemon is the app's engine without Electron: this script transpiles src/{daemon,main,
 * shared} to CommonJS next to each other (no bundling — native dependencies like koffi resolve
 * from the repo's node_modules as usual) and drops src/daemon/electron-shim.ts in as the
 * `electron` module, where Node will find it first when resolving from out/daemon/app.
 *
 * Run it with: npm run build:daemon
 * Then:        node out/daemon/app/daemon/index.js
 * or install the user service: packaging/omarchy/install.sh
 */
import { build } from 'esbuild'
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'out', 'daemon', 'app')

/** main/index.ts is the windowed app's entry (it imports an icon with `?asset`); the daemon
 * doesn't include it. */
const SKIP = new Set([join('main', 'index.ts')])

async function collect(dir, acc = []) {
  for (const entry of await readdir(join(root, 'src', dir), { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collect(path, acc)
    else if (entry.name.endsWith('.ts') && !SKIP.has(path)) acc.push(join(root, 'src', path))
  }
  return acc
}

const entryPoints = [
  ...(await collect('daemon')),
  ...(await collect('main')),
  ...(await collect('shared'))
]

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints,
  outdir: outDir,
  outbase: join(root, 'src'),
  bundle: false,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: 'inline',
  logLevel: 'warning'
})

// `require('electron')` from anywhere under out/daemon/app finds this before the real package:
// the same module the engine would get from Electron, on plain Node.
const shimDir = join(outDir, 'node_modules', 'electron')
await mkdir(shimDir, { recursive: true })
await writeFile(
  join(shimDir, 'package.json'),
  JSON.stringify({ name: 'electron', version: '0.0.0-daemon', main: 'index.js' }, null, 2)
)
await writeFile(
  join(shimDir, 'index.js'),
  "module.exports = require('../../daemon/electron-shim.js')\n"
)

// The plugin ships from packaging/omarchy; keep a copy next to the build so install.sh can be
// run from either place.
await cp(join(root, 'packaging', 'omarchy'), join(root, 'out', 'daemon', 'omarchy'), {
  recursive: true
}).catch(() => {})

console.log(`Daemon built at ${relative(root, join(outDir, 'daemon', 'index.js'))}`)
console.log('Run it:     node out/daemon/app/daemon/index.js')
console.log('Talk to it: node out/daemon/app/daemon/ctl.js status')
