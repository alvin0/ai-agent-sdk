import { ipcAcquire } from './inflight.ts'
import { execute, type Job } from './execute.ts'

const acquire = ipcAcquire()
process.once('message', (job: Job) => {
  execute(job, process.env.MA_BENCH_TEMP, { acquire }).then(value => {
    process.send?.(value, () => process.exit(0))
  }).catch(error => {
    process.send?.({ fatal: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
      () => process.exit(0))
  })
})
