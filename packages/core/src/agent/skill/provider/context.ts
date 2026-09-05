import { CLOSED_RUNTIME_LOGGER, type SdkLogger } from '../../../logging/types.ts'

const loggers = new WeakMap<object, SdkLogger>()

export function bindSkillProviderLogger(catalog: object, logger: SdkLogger | undefined): void {
  if (logger === undefined) loggers.delete(catalog)
  else loggers.set(catalog, logger)
}

export function skillProviderLogger(catalog: object): SdkLogger {
  return loggers.get(catalog) ?? CLOSED_RUNTIME_LOGGER
}
