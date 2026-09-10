'use client'

/**
 * The roster editor: who is on the team, and what each of them runs.
 *
 * A member with no model of its own inherits the conversation's, which is why
 * the model field offers "same as the run" first — a roster is usually about
 * roles, and only sometimes about giving one member a cheaper or stronger
 * model than the rest.
 *
 * Editing the roster replaces the team on the server and the conversation's
 * model-side history goes with it, so the dialog says so instead of letting
 * that be discovered.
 */

import { useEffect, useState } from 'react'
import { MAX_TEAM_MEMBERS, MEMBER_NAME, type WireMember } from '../server/wire'
import css from './TeamDialog.module.css'

/** What a new row starts as. */
const BLANK: WireMember = { name: '', role: 'peer' }

export interface TeamDialogProps {
  open: boolean
  onClose: () => void
  members: readonly WireMember[]
  onSave: (members: readonly WireMember[]) => void
  /** Ids the model select offers; a typed id is accepted too. */
  models: readonly string[]
  /** Efforts for the selected member model, or its inherited run model. */
  effortsForModel: (model: string) => readonly string[]
  /** The model a member inherits when it names none. */
  runModel: string
  /** True when the open conversation would lose its history on save. */
  restarts: boolean
}

/**
 * Render the roster editor.
 * @param props - Open state, the roster, and what the pickers may offer.
 * @returns The dialog, or nothing when closed.
 */
export function TeamDialog({
  open, onClose, members, onSave, models, effortsForModel, runModel, restarts,
}: TeamDialogProps) {
  const [draft, setDraft] = useState<readonly WireMember[]>(members)

  // The dialog opens on what is currently in play, not on whatever was left
  // behind by an edit that was cancelled.
  useEffect(() => { if (open) setDraft(members) }, [open, members])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  if (!open) return null

  const update = (index: number, patch: Partial<WireMember>): void => {
    setDraft(current => current.map((member, at) => {
      if (at !== index) {
        // Exactly one lead: promoting one demotes whoever held it.
        return patch.role === 'lead' ? { ...member, role: 'peer' as const } : member
      }
      const next = { ...member, ...patch }
      // An empty string is how a select says "inherit", and the wire wants the
      // field absent rather than blank.
      if (next.model === '') delete next.model
      if (next.effort === '') delete next.effort
      if (next.effort !== undefined
        && !effortsForModel(next.model ?? runModel).includes(next.effort)) {
        delete next.effort
      }
      return next
    }))
  }

  const problem = validate(draft, runModel, effortsForModel)
  const save = (): void => {
    if (problem !== undefined) return
    onSave(draft)
    onClose()
  }

  return (
    <div
      className={css.backdrop}
      role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label="Team roster">
        <div className={css.head}>
          <span className={css.title}>Team roster</span>
          <button type="button" className={css.close} aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className={css.body}>
          <p className={css.note}>
            The lead receives your message and delegates with <code>followup_task</code>.
            A member with no model of its own runs <code>{runModel}</code>.
          </p>

          {draft.map((member, index) => (
            <div className={css.member} key={index}>
              <div className={css.memberHead}>
                <input
                  className={css.name}
                  placeholder="name"
                  spellCheck={false}
                  value={member.name}
                  onChange={(event) => { update(index, { name: event.target.value }) }}
                />
                <label className={css.lead}>
                  <input
                    type="radio"
                    name="team-lead"
                    checked={member.role === 'lead'}
                    onChange={() => { update(index, { role: 'lead' }) }}
                  />
                  lead
                </label>
                <button
                  type="button"
                  className={css.remove}
                  aria-label={`Remove ${member.name}`}
                  disabled={draft.length <= 2}
                  onClick={() => { setDraft(current => current.filter((_, at) => at !== index)) }}
                >
                  ×
                </button>
              </div>

              <div className={css.fields}>
                <select
                  className={css.select}
                  value={member.model ?? ''}
                  onChange={(event) => { update(index, { model: event.target.value }) }}
                >
                  <option value="">same as the run</option>
                  {models.map(id => <option key={id} value={id}>{id}</option>)}
                  {member.model !== undefined && !models.includes(member.model) && (
                    <option value={member.model}>{member.model}</option>
                  )}
                </select>
                <select
                  className={css.select}
                  value={member.effort ?? ''}
                  onChange={(event) => { update(index, { effort: event.target.value }) }}
                >
                  <option value="">model default</option>
                  {effortsForModel(member.model ?? runModel).map(id => (
                    <option key={id} value={id}>{id}</option>
                  ))}
                </select>
              </div>

              <textarea
                className={css.instructions}
                rows={2}
                placeholder="What this member is for…"
                value={member.instructions ?? ''}
                onChange={(event) => { update(index, { instructions: event.target.value }) }}
              />
            </div>
          ))}

          <button
            type="button"
            className={css.add}
            disabled={draft.length >= MAX_TEAM_MEMBERS}
            onClick={() => { setDraft(current => [...current, BLANK]) }}
          >
            Add a member
          </button>

          {problem !== undefined && <p className={css.problem}>{problem}</p>}
          {problem === undefined && restarts && (
            <p className={css.note}>Saving starts this conversation over.</p>
          )}
        </div>

        <div className={css.foot}>
          <span className={css.spacer} />
          <button type="button" className={css.secondary} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={css.primary}
            disabled={problem !== undefined}
            onClick={save}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The first thing wrong with the draft, in the words the reader needs.
 *
 * The server checks all of this again; this exists so a mistake is caught while
 * it is still being made rather than on the next send.
 * @param members - The draft roster.
 * @returns The problem, or undefined when the roster is usable.
 */
function validate(
  members: readonly WireMember[],
  runModel: string,
  effortsForModel: (model: string) => readonly string[],
): string | undefined {
  if (members.length < 2) return 'A team needs at least two members.'
  if (members.length > MAX_TEAM_MEMBERS) return `A team holds at most ${String(MAX_TEAM_MEMBERS)} members.`
  const seen = new Set<string>()
  for (const member of members) {
    if (!MEMBER_NAME.test(member.name)) {
      return `"${member.name}" is not a usable name: 2 to 24 lowercase letters, digits or dashes.`
    }
    if (seen.has(member.name)) return `Two members are called "${member.name}".`
    seen.add(member.name)
    if (member.effort !== undefined
      && !effortsForModel(member.model ?? runModel).includes(member.effort)) {
      return `${member.name} uses an effort not supported by its model.`
    }
  }
  if (!members.some(member => member.role === 'lead')) return 'One member has to be the lead.'
  return undefined
}
