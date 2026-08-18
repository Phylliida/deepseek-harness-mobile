#!/usr/bin/env node
// Assemble the Android runtime payload: the Termux node rootfs (from
// fetch-termux-node.mjs) plus the pnpm-deployed web-host closure, packed as
// runtime.tgz into android/app/src/main/assets/.
//
// The deploy recipe (legacy deploy + hoist restoration + link materialization)
// mirrors scripts/build-exe-for-python-sdk.ts; both materialize a symlink-free
// closure, because the device side cannot rely on pnpm's store layout.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE = fileURLToPath(new URL('..', import.meta.url))
const ROOT = resolve(MOBILE, '..')
const STAGING = join(MOBILE, 'runtime', 'deploy')
const ROOTFS = join(MOBILE, 'runtime', 'rootfs')
const OVERLAY_SOURCE = join(MOBILE, 'patches', 'mobile.cordis.patch.yml')
const OUT_TGZ = join(MOBILE, 'android', 'app', 'src', 'main', 'assets', 'runtime.tgz')

const DEPLOY_ROOT_PACKAGE = 'dsh-mobile-web-pkg'

function fail(msg) {
  console.error(`package-runtime: ${msg}`)
  process.exit(1)
}

function run(label, cmd, args, opts = {}) {
  console.log(`package-runtime: ${label}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
  if (r.status !== 0) fail(`${label} failed (exit ${r.status ?? r.error})`)
}

function findSymlink(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (lstatSync(path).isSymbolicLink()) return path
    if (entry.isDirectory()) {
      const nested = findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/** Copy a package directory without its nested node_modules (kept flat at top level). */
function copyPackage(source, destination) {
  const nested = join(source, 'node_modules')
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nested && !path.startsWith(nested + sep),
  })
}

/** Restore direct deps pnpm's legacy hoister places beside the deploy source, not in the target. */
function restoreLegacyHoists() {
  const manifest = JSON.parse(readFileSync(join(STAGING, 'package.json'), 'utf8'))
  const sourceNodeModules = join(MOBILE, 'deploy-root', 'node_modules')
  const restored = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(STAGING, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) fail(`deployed dependency ${dependency} absent from ${destination} and ${source}`)
    mkdirSync(dirname(destination), { recursive: true })
    copyPackage(source, destination)
    restored.push(dependency)
  }
  if (restored.length > 0) console.log(`package-runtime: restored legacy deploy hoists: ${restored.join(', ')}`)
}

/** Replace deploy-time package links with files and reject any remaining link. */
function materializeStagedLinks() {
  const nodeModules = join(STAGING, 'node_modules')
  let remaining = findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      rmSync(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
    } else {
      const source = realpathSync(remaining)
      rmSync(remaining, { recursive: true, force: true })
      copyPackage(source, remaining)
    }
    remaining = findSymlink(nodeModules)
  }
}

/**
 * node-pty loads a native pty.node binary at import time and has no Android
 * build, but the subprocess row imports it statically — so the whole host
 * boot must not depend on removing it. Replace its implementation with a
 * stub: the module loads, spawn() throws at use, and bash/pwsh tool calls
 * fail loudly per call instead of the host failing to boot.
 */
function stubNodePty() {
  const pkgDir = join(STAGING, 'node_modules', 'node-pty', 'lib')
  if (!existsSync(join(pkgDir, 'index.js'))) fail(`node-pty layout changed: ${join(pkgDir, 'index.js')} missing`)
  writeFileSync(
    join(pkgDir, 'index.js'),
    `'use strict'
// Replaced by mobile/scripts/package-runtime.mjs: pseudo-terminals cannot be
// allocated on Android. Load succeeds; every spawn attempt fails loudly.
function spawn() {
  throw new Error('node-pty: pseudo-terminals are unavailable in the Android build')
}
module.exports = { spawn }
`,
  )
}

function main() {
  if (!existsSync(ROOTFS)) fail(`${ROOTFS} missing — run fetch-termux-node.mjs first`)

  rmSync(STAGING, { recursive: true, force: true })
  run('deploy closure', 'corepack', [
    'pnpm', '--filter', DEPLOY_ROOT_PACKAGE, 'deploy',
    '--legacy', '--prod',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    STAGING,
  ])
  restoreLegacyHoists()
  materializeStagedLinks()
  stubNodePty()

  const binEntry = join(STAGING, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binEntry)) fail(`${binEntry} missing — run \`pnpm run build\` at the repo root first`)
  const frontend = join(STAGING, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(frontend)) fail(`${frontend} missing — web frontend dist not built`)

  cpSync(OVERLAY_SOURCE, join(STAGING, 'mobile.cordis.patch.yml'))

  rmSync(OUT_TGZ, { force: true })
  mkdirSync(dirname(OUT_TGZ), { recursive: true })
  run('pack runtime.tgz', 'tar', ['-czf', OUT_TGZ, '-C', join(MOBILE, 'runtime'), 'rootfs', 'deploy'])
  console.log('package-runtime: wrote ' + OUT_TGZ)
}

main()
