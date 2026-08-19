#!/usr/bin/env node
// Download pinned Termux-built packages (+ shared-library closure) for
// aarch64 Android and stage them under mobile/runtime/rootfs.
//
// Termux is used because the harness needs Node >= 22.19 (node:sqlite,
// engines floor) and nodejs-mobile/Capacitor-NodeJS are stuck on Node 18.
// Termux binaries are plain Android/ELF executables; with targetSdk 28 the
// app may exec them from its private data directory (the Termux model).
//
// Beyond nodejs, the roots bundle the on-device tool binaries: bash (the
// dsh shell executor runs `bash -c`; Android itself ships only toybox sh),
// python (reached through bash; script entry points such as pip3 keep their
// Termux-prefix shebangs and do not run — use `python3 -m ...`), and ripgrep
// (@vscode/ripgrep has no android platform package, so package-runtime.mjs
// redirects its rgPath export at this staged rg).
//
// Reproducibility: resolved package URLs + sha256 are pinned in
// runtime/termux.lock.json. Later runs verify against the lock; pass
// --refresh to reresolve against the current Termux repo and rewrite it.

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME = join(MOBILE, 'runtime')
const LOCK_FILE = join(RUNTIME, 'termux.lock.json')
const DEBS_DIR = join(RUNTIME, 'debs')
const ROOTFS = join(RUNTIME, 'rootfs')

const REPO_BASE = 'https://packages-cf.termux.dev/apt/termux-main'
const ARCH = 'aarch64'
const ROOT_PACKAGES = ['nodejs', 'bash', 'python', 'ripgrep']
// System libraries the Android dynamic linker supplies; not shipped by Termux.
const SYSTEM_LIBS = new Set([
  'ld-android.so', 'libc.so', 'libm.so', 'libdl.so', 'liblog.so',
  'libandroid.so', 'libz.so', 'libmediandk.so', 'libOpenSLES.so',
])

const refresh = process.argv.includes('--refresh')

function fail(msg) {
  console.error(`fetch-termux-node: ${msg}`)
  process.exit(1)
}

function runChecked(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'buffer', maxBuffer: 1 << 28, ...opts })
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} failed: ${r.stderr?.toString() ?? r.error}`)
  return r.stdout
}

async function fetchBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) fail(`GET ${url} → HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Parse the apt `Packages` index into a name → stanza map. */
function parsePackages(text) {
  const byName = new Map()
  for (const stanza of text.split('\n\n')) {
    if (!stanza.trim()) continue
    const fields = {}
    let last = null
    for (const line of stanza.split('\n')) {
      if (line.startsWith(' ') && last) { fields[last] += '\n' + line }
      else {
        const i = line.indexOf(': ')
        if (i > 0) { last = line.slice(0, i); fields[last] = line.slice(i + 2) }
      }
    }
    if (fields.Package) byName.set(fields.Package, fields)
  }
  return byName
}

/** Dependency names of a stanza: first alternative of each Depends entry. */
function dependsOf(stanza) {
  if (!stanza.Depends) return []
  return stanza.Depends.split(',')
    .map(d => d.trim().split('|')[0].trim().replaceAll(/\s*\([^)]*\)/g, ''))
    .filter(Boolean)
}

async function resolvePackages() {
  const index = await fetchBuffer(`${REPO_BASE}/dists/stable/main/binary-${ARCH}/Packages`)
  const pkgs = parsePackages(index.toString('utf8'))
  const closure = new Map() // name → {name, version, filename, sha256}
  const queue = [...ROOT_PACKAGES]
  while (queue.length) {
    const name = queue.shift()
    if (closure.has(name)) continue
    const stanza = pkgs.get(name) ?? fail(`package not in Termux index: ${name}`)
    closure.set(name, {
      name,
      version: stanza.Version,
      filename: stanza.Filename,
      sha256: stanza.SHA256,
    })
    for (const dep of dependsOf(stanza)) queue.push(dep)
  }
  return [...closure.values()]
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** Extract a .deb (ar + tar.<zst|xz|gz>) into the rootfs using system tools. */
function extractDeb(debPath) {
  // ar members: debian-binary, control.tar.*, data.tar.*
  const list = runChecked('ar', ['t', debPath]).toString().split('\n').filter(Boolean)
  const dataMember = list.find(m => m.startsWith('data.tar.')) ?? fail(`no data.tar in ${debPath}`)
  const out = runChecked('ar', ['p', debPath, dataMember])
  const tarArgs = { zst: ['--zstd', '-x'], xz: ['-Jx'], gz: ['-zx'] }[dataMember.split('.').pop()]
    ?? fail(`unsupported compression: ${dataMember}`)
  const r = spawnSync('tar', tarArgs, { input: out, cwd: ROOTFS, stdio: ['pipe', 'ignore', 'pipe'] })
  if (r.status !== 0) fail(`tar extract of ${debPath} failed: ${r.stderr?.toString()}`)
}

/** Every DT_NEEDED of every ELF file under dir must resolve inside rootfs or be a system lib. */
function assertNeededClosure() {
  const usr = join(ROOTFS, 'data/data/com.termux/files/usr')
  const entries = runChecked('find', [usr, '(', '-type', 'f', '-o', '-type', 'l', ')']).toString().trim().split('\n')
  const present = new Set(entries.map(f => f.split('/').pop()))
  // Probe every shared library plus every staged bin executable; bin holds
  // scripts too (broken Termux-prefix shebangs), so filter by ELF magic
  // instead of trusting the readelf exit status.
  const candidates = runChecked('find', [usr, '-type', 'f', '(', '-name', '*.so*', '-o', '-path', '*/bin/*', ')']).toString().trim().split('\n')
  const elfs = candidates.filter((f) => {
    const fd = openSync(f, 'r')
    try {
      const magic = Buffer.alloc(4)
      readSync(fd, magic, 0, 4, 0)
      return magic.toString('latin1') === '\x7fELF'
    } finally {
      closeSync(fd)
    }
  })
  const libs = new Set()
  for (const f of elfs) {
    const dyn = runChecked('readelf', ['-d', f]).toString()
    for (const m of dyn.matchAll(/\(NEEDED\)\s+Shared library: \[(.+)\]/g)) libs.add(m[1])
  }
  const missing = [...libs].filter(l => !SYSTEM_LIBS.has(l) && !present.has(l))
  if (missing.length) fail(`unresolved DT_NEEDED libs: ${missing.join(', ')}`)
  console.log(`DT_NEEDED closure OK (${libs.size} libs, ${elfs.length} ELF files probed)`)
}

/** Keep only the tool executables and shared libs; docs/man/locale data files are dead weight in an APK. */
function pruneRootfs() {
  const usr = join(ROOTFS, 'data/data/com.termux/files/usr')
  const keep = new Set(['bin', 'lib'])
  for (const entry of readdirSync(usr, { withFileTypes: true })) {
    if (!keep.has(entry.name)) rmSync(join(usr, entry.name), { recursive: true, force: true })
  }
  // Binaries only: node plus the tool set. python's script entry points
  // (pip3, pydoc3, …) carry Termux-prefix shebangs that never resolve in the
  // app's private prefix, so keeping them would just ship dead weight.
  const keepBin = entry => entry === 'node' || entry === 'bash' || entry === 'sh' || entry === 'rg' || entry.startsWith('python3')
  for (const entry of readdirSync(join(usr, 'bin'))) {
    if (!keepBin(entry)) rmSync(join(usr, 'bin', entry), { recursive: true, force: true })
  }
}

async function main() {
  for (const tool of ['ar', 'tar', 'readelf', 'find']) {
    if (spawnSync('which', [tool]).status !== 0) fail(`required tool missing: ${tool}`)
  }
  mkdirSync(DEBS_DIR, { recursive: true })
  rmSync(ROOTFS, { recursive: true, force: true })
  mkdirSync(ROOTFS, { recursive: true })

  let packages
  if (!refresh && existsSync(LOCK_FILE)) {
    packages = JSON.parse(readFileSync(LOCK_FILE, 'utf8')).packages
    console.log(`using ${packages.length} locked packages`)
  } else {
    packages = await resolvePackages()
    const lock = { repoBase: REPO_BASE, arch: ARCH, rootPackages: ROOT_PACKAGES, resolvedAt: new Date().toISOString(), packages }
    writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2) + '\n')
    console.log(`resolved ${packages.length} packages → ${LOCK_FILE}`)
  }

  for (const p of packages) {
    const debPath = join(DEBS_DIR, p.filename.split('/').pop())
    if (!existsSync(debPath) || sha256(readFileSync(debPath)) !== p.sha256) {
      console.log(`fetch ${p.name} ${p.version}`)
      const buf = await fetchBuffer(`${REPO_BASE}/${p.filename}`)
      if (sha256(buf) !== p.sha256) fail(`sha256 mismatch for ${p.name}`)
      writeFileSync(debPath, buf)
    }
    extractDeb(debPath)
  }

  pruneRootfs()
  assertNeededClosure()
  const nodeBin = join(ROOTFS, 'data/data/com.termux/files/usr/bin/node')
  if (!existsSync(nodeBin)) fail(`node binary missing after extraction: ${nodeBin}`)
  console.log(`node staged at ${join('runtime/rootfs', 'data/data/com.termux/files/usr/bin/node')}`)
}

await main()
