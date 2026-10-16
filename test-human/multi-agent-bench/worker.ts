import { execute, type Job } from './execute.ts'

process.once('message', (job: Job) => {
  execute(job, process.env.MA_BENCH_TEMP).then(value => {
    process.send?.(value, () => process.exit(0))
  }).catch(error => {
    process.send?.({ fatal: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
      () => process.exit(0))
  })
})
