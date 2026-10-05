import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    name: 'cov',
    coverage: { enabled: true, provider: 'v8', include: ['packages/compaction/compaction-autobiographical/src/**/*.ts'], reporter: ['text'], reportsDirectory: './coverage-cov', thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 } },
    pool: 'forks',
    include: ['packages/compaction/compaction-autobiographical/tests/**/*.spec.ts'],
  },
})
