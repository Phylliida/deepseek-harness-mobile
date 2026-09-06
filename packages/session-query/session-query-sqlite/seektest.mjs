import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '../../session/session-persistence-jsonl/lib/index.js'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root: '/home/bepis/.dsh/sessions' })
await ctx.plugin(SqliteSessionQueryEngine, { path: '/tmp/seektest-search.db' })

const t0 = Date.now()
console.log('listing snapshots...')
const snaps = await ctx.sessionPersistence.listSnapshots()
console.log(`snapshots: ${snaps.length} sessions in ${Date.now() - t0}ms`)

const t1 = Date.now()
console.log('first search (full reconciliation)...')
try {
  const page = await ctx.sessionQuery.searchSessions({ query: 'history search' })
  console.log(`search done in ${Date.now() - t1}ms, hits: ${page.hits.length}`)
  for (const hit of page.hits.slice(0, 3)) {
    console.log('-', hit.session.id, hit.session.cwd, JSON.stringify(hit.bestMatch?.snippet ?? '').slice(0, 120))
  }
} catch (error) {
  console.error(`search FAILED in ${Date.now() - t1}ms:`, error?.code ?? error)
}

const t2 = Date.now()
const page2 = await ctx.sessionQuery.searchSessions({ query: 'workspace' })
console.log(`second search in ${Date.now() - t2}ms, hits: ${page2.hits.length}`)
await ctx.dispose()
