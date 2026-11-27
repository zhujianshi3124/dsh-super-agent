import { configDefaults, defineConfig } from 'vitest/config'
// Two suites exercise POSIX-only behavior end to end and cannot run on Windows: `deployment.spec.ts` builds `#!/bin/sh` CLI
// wrappers and a symlinked state directory in its shared beforeEach, and `service-script.spec.ts` drives scripts/dsh-superagent,
// which needs Python `fcntl` and `tmux`. The Windows deployment uses the desktop build and the superagent-*.ps1 scripts instead.
// They are excluded on Windows rather than failing; every other suite runs on all platforms, and POSIX-only cases within a
// mixed suite are marked with `skipIf(process.platform === 'win32')` at the test itself.
const posixOnlyFiles = process.platform === 'win32' ? ['tests/deployment.spec.ts', 'tests/service-script.spec.ts'] : []
// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'] },
  test: { include: ['tests/**/*.spec.{ts,tsx}'], exclude: [...configDefaults.exclude, ...posixOnlyFiles] } })