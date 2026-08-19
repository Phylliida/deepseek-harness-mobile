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

// Neutralize native modules with no Android build whose packages are
// statically imported by mounted rows: node-pty (pty.node, via
// dsh-subprocess-local), koffi (FFI, via dsh-sandbox-windows-acl's static
// import chain from dsh-sandbox-local — every use is win32-only), and sharp
// (libvips, via dsh-attachment-local). Each stub loads cleanly and throws
// loudly at first real use, so the host boots and the affected capability
// fails per call instead of killing the composition.
const PROXY_BODY = `{
  get(_target, prop) {
    if (prop === 'then') return undefined // keep module identity promise-safe
    throw new Error('NAME: native module is unavailable in the Android build (accessed ' + String(prop) + ')')
  },
  apply() {
    throw new Error('NAME: native module is unavailable in the Android build')
  },
}`

/** CommonJS stub (packages with type commonjs): callers use default interop only. */
const CJS_STUB = name => `'use strict'
// Replaced by mobile/scripts/package-runtime.mjs: no Android build. A
// function-shaped Proxy so call and property access fail at use, not import.
module.exports = new Proxy(function () {}, ${PROXY_BODY.replaceAll('NAME', name)})
`

/**
 * koffi stub (ESM; type: module). dsh-sandbox-windows-acl's ffi.ts declares
 * Win32 structs at module scope, so pointer/struct must RETURN inert tokens;
 * every real FFI call (alloc/encode/decode/load/…, all win32-gated) throws.
 */
const KOFFI_STUB = `// Replaced by mobile/scripts/package-runtime.mjs: no Android build.
// ffi.ts asserts the two Win32 struct sizes against its header probe at
// module load; the sizes are platform constants (winnt.h, x64), so the stub
// returns the probed values. Any struct not listed fails its assert loudly.
const SIZES = { STARTUPINFOW: 104, PROCESS_INFORMATION: 24 }
const throwUse = name => () => {
  throw new Error('koffi: native FFI is unavailable in the Android build (' + name + ')')
}
export default new Proxy(
  { pointer: () => ({}), typedef: () => ({}), alias: () => ({}), struct: name => ({ size: SIZES[name] ?? -1 }) },
  {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'then') return undefined
      return throwUse(String(prop))
    },
  },
)
`

/** ESM stub (packages with an ESM entry such as sharp's dist/sharp.mjs). */
const ESM_STUB = name => `// Replaced by mobile/scripts/package-runtime.mjs: no Android build. A
// function-shaped Proxy so call and property access fail at use, not import.
export default new Proxy(function () {}, ${PROXY_BODY.replaceAll('NAME', name)})
`

const NEUTRALIZED_NATIVE_MODULES = {
  'node-pty/lib/index.js': CJS_STUB('node-pty'),
  'koffi/src/koffi/index.js': KOFFI_STUB,
  'sharp/dist/index.cjs': CJS_STUB('sharp'),
  'sharp/dist/index.mjs': ESM_STUB('sharp'),
}

function neutralizeNativeModules() {
  for (const [rel, content] of Object.entries(NEUTRALIZED_NATIVE_MODULES)) {
    const target = join(STAGING, 'node_modules', rel)
    if (!existsSync(target)) fail(`expected native module file missing (layout changed?): ${target}`)
    // pnpm deploy hard-links store files into the staging closure; an in-place
    // write would truncate the shared inode and corrupt the workspace
    // node_modules (and the store) with the stub. Delete first so the stub
    // lands on a fresh inode.
    rmSync(target)
    writeFileSync(target, content)
  }
}

/**
 * Point @vscode/ripgrep at the Termux rg staged in the runtime rootfs. The
 * package resolves `@vscode/ripgrep-<platform>-<arch>` at module evaluation
 * and has no android build, so every glob/grep call would fail at launch;
 * dsh-tool-fs-search only consumes the `rgPath` export. The relative URL
 * keeps working wherever the runtime root is extracted. Same
 * delete-before-write rule as neutralizeNativeModules.
 */
const RG_REDIRECT = `// Rewritten by mobile/scripts/package-runtime.mjs: @vscode/ripgrep has no
// android platform package; the Termux-built rg in the runtime rootfs is the binary.
import { fileURLToPath } from 'node:url'
export const rgPath = fileURLToPath(new URL('../../../../../rootfs/data/data/com.termux/files/usr/bin/rg', import.meta.url))
`

function redirectRipgrep() {
  const target = join(STAGING, 'node_modules', '@vscode', 'ripgrep', 'lib', 'index.js')
  if (!existsSync(target)) fail(`@vscode/ripgrep entry missing (layout changed?): ${target}`)
  rmSync(target)
  writeFileSync(target, RG_REDIRECT)
  // The host platform's optional binary package deploys along; it is a
  // foreign-architecture dead weight in the APK.
  rmSync(join(STAGING, 'node_modules', '@vscode', 'ripgrep-linux-x64'), { recursive: true, force: true })
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
  neutralizeNativeModules()
  redirectRipgrep()

  const binEntry = join(STAGING, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binEntry)) fail(`${binEntry} missing — run \`pnpm run build\` at the repo root first`)
  const frontend = join(STAGING, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(frontend)) fail(`${frontend} missing — web frontend dist not built`)

  cpSync(OVERLAY_SOURCE, join(STAGING, 'mobile.cordis.patch.yml'))

  rmSync(OUT_TGZ, { force: true })
  mkdirSync(dirname(OUT_TGZ), { recursive: true })
  // --hard-dereference turns tar's hard-link ('1') members into regular files:
  // hard link creation is EPERM in Android app-private storage (SELinux), so
  // the on-device extractor can only materialize them as copies.
  run('pack runtime.tgz', 'tar', ['-czf', OUT_TGZ, '--hard-dereference', '-C', join(MOBILE, 'runtime'), 'rootfs', 'deploy'])
  console.log('package-runtime: wrote ' + OUT_TGZ)
}

main()
