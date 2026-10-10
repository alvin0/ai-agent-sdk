import { projectAttachments } from '../attachments'
import { resolveModel, supportedEffort } from '../registry'
import type { ModelSelection, ResolvedModel } from '../registry'
import type { createCallRecording } from './call-recording'
import type { WireAttachment } from '../wire'

/**
 * Refuse a prompt whose images the chosen model cannot see.
 *
 * The runtime already has an answer for this: it replaces images with an
 * "image omitted" note so the request still succeeds. That is right for a long
 * conversation being summarized by a cheaper text model, and wrong here — "read
 * the total on this receipt" does not become a different, answerable question
 * by removing the receipt. A request that runs is not the same as a request
 * that was understood, so the mismatch is reported to the user, who can pick a
 * model that takes images or drop the attachment.
 * @param model - The resolved route this turn would run on.
 * @param records - Attachments admitted for this prompt.
 * @throws Error naming the model when it declares no image input.
 */
export async function refuseImagesOnTextOnlyModel(
  model: ResolvedModel,
  records: readonly WireAttachment[],
): Promise<void> {
  if (!records.some(record => record.kind === 'image')) return
  let modalities: readonly string[] | undefined
  try {
    modalities = (await model.registry.resolveModelInfo(model.config.provider, model.config.model))
      .inputModalities
  } catch {
    // A route whose metadata cannot be resolved is not evidence of anything.
    // Sending is the better failure: the provider says no in its own words.
    return
  }
  if (modalities === undefined || modalities.includes('image')) return
  throw new Error(
    `${model.config.model} does not accept images.`
    + ' Pick a model with vision, or remove the attached images before sending.',
  )
}

export async function admitPrompt(
  selection: ModelSelection | undefined, recording: ReturnType<typeof createCallRecording>,
  { rememberedEffort, attachmentIds }: {
    readonly rememberedEffort: string | null | undefined
    readonly attachmentIds: readonly string[]
  },
) {
  const model = await resolveModel(selection, recording.recorder, {
    correlator: recording.correlator, sink: recording.raw,
  })
  const effort = await supportedEffort(model.registry, model.config, rememberedEffort ?? undefined)
  const attached = projectAttachments(attachmentIds)
  await refuseImagesOnTextOnlyModel(model, attached.records)
  return { model, effort, attached }
}
