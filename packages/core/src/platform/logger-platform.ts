import type { SdkLogger } from '../logging/types.ts'
import type { RuntimePlatform } from './adapter.ts'

const LOGGER_PLATFORMS = new WeakMap<object, RuntimePlatform>()

export function bindRuntimeLoggerPlatform(logger: SdkLogger, platform: RuntimePlatform): void {
  LOGGER_PLATFORMS.set(logger, platform)
}

export function runtimePlatformForLogger(logger: SdkLogger): RuntimePlatform | undefined {
  return LOGGER_PLATFORMS.get(logger)
}
