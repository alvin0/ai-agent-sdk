import { defineConfig, type UserConfig } from 'tsdown'

export interface LibraryBuildOptions {
  readonly entry: NonNullable<UserConfig['entry']>
  readonly outDir?: string
  readonly runtime: 'universal' | 'node'
  readonly dts?: boolean
  readonly outputOptions?: UserConfig['outputOptions']
  readonly minify?: UserConfig['minify']
  readonly unbundle?: boolean
  readonly root?: string
}

/** Shared deterministic ESM build settings for every publishable package. */
export function libraryBuild(options: LibraryBuildOptions): ReturnType<typeof defineConfig> {
  return defineConfig({
    entry: options.entry,
    outDir: options.outDir ?? 'dist',
    format: ['esm'],
    platform: options.runtime === 'node' ? 'node' : 'neutral',
    target: options.runtime === 'node' ? 'node22.12' : 'es2023',
    dts: options.dts ?? true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    minify: options.minify ?? false,
    unbundle: options.unbundle ?? false,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.outputOptions === undefined ? {} : { outputOptions: options.outputOptions }),
    deps: { neverBundle: [/^node:/] },
  })
}
