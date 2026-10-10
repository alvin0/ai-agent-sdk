import { RunTrace } from '../traces'
import { RawCallCorrelator, recordProviderCalls } from '../provider-calls'
import type { CallFingerprint, CallSink, RawApiCall } from '../provider-calls'
import type { WireApiCall, WireEvent } from '../wire'
import type { Doorbell } from './streams'

export function createCallRecording() {
  /**
   * Where a finished provider call goes.
   *
   * The recorder has to be installed on the registry before the first call,
   * which is before the trace it feeds exists — so calls land in a buffer and
   * the sink is replaced once there is a trace and a stream to send on.
   */
  const recordedCalls: { call: WireApiCall; id: CallFingerprint }[] = []
  let onProviderCall: CallSink = (call, callId) => { recordedCalls.push({ call, id: callId }) }
  const correlator = new RawCallCorrelator()
  const recordedRaw: { raw: RawApiCall; id: CallFingerprint }[] = []
  let onRawCall = (raw: RawApiCall, callId: CallFingerprint): void => {
    recordedRaw.push({ raw, id: callId })
  }
  const recorder = recordProviderCalls((call, callId) => { onProviderCall(call, callId) }, correlator)

  return {
    recorder, correlator,
    raw: (raw: RawApiCall, id: CallFingerprint): void => { onRawCall(raw, id) },
    attach(trace: RunTrace, queued: WireEvent[], wake: Doorbell): void {
      // The trace and the stream both exist now, so recorded calls can go where
      // they belong. Whatever the first rounds recorded while the buffer was in
      // place is drained through the same path.
      onProviderCall = (call, callId) => {
        for (const wire of trace.attachCall(call, callId)) queued.push(wire)
        wake.ring()
      }
      for (const buffered of recordedCalls.splice(0)) onProviderCall(buffered.call, buffered.id)
      onRawCall = (raw, callId) => {
        for (const wire of trace.attachRaw(raw, callId)) queued.push(wire)
        wake.ring()
      }
      for (const buffered of recordedRaw.splice(0)) onRawCall(buffered.raw, buffered.id)

    },
  }
}
