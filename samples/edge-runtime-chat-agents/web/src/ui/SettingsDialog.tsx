'use client'

/**
 * Everything the visitor configures once and then forgets: the API key, and
 * which models this browser knows about.
 *
 * The two live together because they answer the same question — what this
 * browser is allowed to run — and because both are stored in the same place
 * and lost in the same way.
 */

import { useEffect, useRef, useState } from 'react'
import {
  effortsForModel, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, MIN_OUTPUT_TOKENS, MODEL_ID,
  suggestedCapacity, suggestedEfforts,
} from '../server/wire'
import { keyHint, type ApiKeyController } from './useApiKey'
import type { ModelCatalogController } from './useModelCatalog'
import css from './SettingsDialog.module.css'

export interface SettingsDialogProps {
  open: boolean
  onClose: () => void
  apiKey: ApiKeyController
  catalog: ModelCatalogController
  /** True when the deployment's own environment already holds a key. */
  serverConfigured: boolean
}

/**
 * Render the settings dialog.
 * @param props - Open state, the key and catalog controllers, and the
 *   deployment's own credential status.
 * @returns The dialog, or nothing when closed.
 */
export function SettingsDialog({
  open, onClose, apiKey, catalog, serverConfigured,
}: SettingsDialogProps) {
  const [keyDraft, setKeyDraft] = useState('')
  const keyField = useRef<HTMLInputElement>(null)

  // The field starts empty every time rather than pre-filled with the stored
  // key: printing a credential into the DOM to let someone re-read it is the
  // thing this dialog is trying not to do.
  useEffect(() => {
    if (!open) return
    setKeyDraft('')
    keyField.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [open, onClose])

  if (!open) return null

  const stored = keyHint(apiKey.key)
  const saveKey = (): void => {
    if (keyDraft.trim() === '') return
    apiKey.save(keyDraft)
    setKeyDraft('')
  }

  return (
    <div
      className={css.backdrop}
      role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label="Settings">
        <div className={css.head}>
          <span className={css.title}>Settings</span>
          <button type="button" className={css.close} aria-label="Close" onClick={onClose}>×</button>
        </div>

        <div className={css.body}>
          <section className={css.section}>
            <h2 className={css.sectionTitle}>OpenAI API key</h2>
            <p className={css.note}>
              The key is stored in this browser and sent with each run. It is never
              written to the server, and it leaves the browser only on requests to
              this app&apos;s own API route.
            </p>
            {serverConfigured && (
              <p className={css.note}>
                This deployment already has a key of its own, so you can leave this
                empty. A key entered here is used instead of it.
              </p>
            )}

            <label className={css.label} htmlFor="api-key-field">
              {stored === undefined ? 'Key' : `Replace the stored key (${stored})`}
            </label>
            <div className={css.keyRow}>
              <input
                id="api-key-field"
                ref={keyField}
                className={css.keyInput}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-…"
                value={keyDraft}
                onChange={(event) => { setKeyDraft(event.target.value) }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  saveKey()
                }}
              />
              <button
                type="button"
                className={css.action}
                disabled={keyDraft.trim() === ''}
                onClick={saveKey}
              >
                Save
              </button>
              {stored !== undefined && (
                <button type="button" className={css.danger} onClick={apiKey.clear}>
                  Remove
                </button>
              )}
            </div>
          </section>

          <div className={css.divider} />

          <ModelsSection catalog={catalog} />
        </div>

        <div className={css.foot}>
          <span className={css.spacer} />
          <button type="button" className={css.primary} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

/**
 * The model list, and the row that adds to it.
 *
 * Context window and output cap are asked for because the SDK needs both to
 * keep a request inside a model's capacity, and pre-filled from the built-in
 * table so a known model costs one field rather than three.
 * @param props - The catalog controller.
 * @returns The section.
 */
function ModelsSection({ catalog }: { catalog: ModelCatalogController }) {
  const [id, setId] = useState('')
  const [context, setContext] = useState('')
  const [output, setOutput] = useState('')
  /** True once either number has been typed, so a later id stops overwriting them. */
  const [touched, setTouched] = useState(false)

  const onId = (value: string): void => {
    setId(value)
    if (touched) return
    const suggestion = suggestedCapacity(value.trim())
    setContext(suggestion.contextWindow === undefined ? '' : String(suggestion.contextWindow))
    setOutput(suggestion.maxOutputTokens === undefined ? '' : String(suggestion.maxOutputTokens))
  }

  const trimmed = id.trim()
  const problem = validate(trimmed, context, output, catalog)
  const submit = (): void => {
    if (problem !== undefined) return
    catalog.add({
      id: trimmed,
      ...(context.trim() === '' ? {} : { contextWindow: Number(context) }),
      ...(output.trim() === '' ? {} : { maxOutputTokens: Number(output) }),
      efforts: suggestedEfforts(trimmed),
    })
    setId('')
    setContext('')
    setOutput('')
    setTouched(false)
  }

  return (
    <section className={css.section}>
      <h2 className={css.sectionTitle}>Models</h2>
      <p className={css.note}>
        The picker on the composer offers these. Capacities are filled in for the
        models this sample has figures for; correct them if your account differs.
        Leave them empty to let the provider adapter&apos;s defaults decide.
      </p>

      <ul className={css.models}>
        {catalog.models.length === 0 && <li className={css.empty}>No models yet.</li>}
        {catalog.models.map(model => (
          <li className={css.model} key={model.id}>
            <span className={css.modelId}>{model.id}</span>
            <span className={css.modelCapacity}>
              {model.contextWindow === undefined
                ? 'default capacity'
                : `${tokens(model.contextWindow)} ctx`}
              {model.maxOutputTokens !== undefined && ` · ${tokens(model.maxOutputTokens)} out`}
              {effortsForModel(model.id, catalog.models).length > 0
                && ` · ${effortsForModel(model.id, catalog.models).join(' / ')}`}
            </span>
            <button
              type="button"
              className={css.remove}
              aria-label={`Remove ${model.id}`}
              onClick={() => { catalog.remove(model.id) }}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <div className={css.addRow}>
        <input
          className={css.addId}
          placeholder="model id"
          spellCheck={false}
          value={id}
          onChange={(event) => { onId(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            submit()
          }}
        />
        <input
          className={css.addNumber}
          placeholder="context"
          inputMode="numeric"
          value={context}
          onChange={(event) => { setContext(event.target.value); setTouched(true) }}
        />
        <input
          className={css.addNumber}
          placeholder="output"
          inputMode="numeric"
          value={output}
          onChange={(event) => { setOutput(event.target.value); setTouched(true) }}
        />
        <button
          type="button"
          className={css.action}
          disabled={problem !== undefined}
          onClick={submit}
        >
          Add
        </button>
      </div>
      {trimmed !== '' && problem !== undefined && <p className={css.problem}>{problem}</p>}
    </section>
  )
}

/**
 * The first thing wrong with the row being typed.
 *
 * The server checks all of this again; this exists so a mistake is caught while
 * it is still being made rather than on the next send.
 * @param id - The trimmed model id.
 * @param context - The context window field, as typed.
 * @param output - The output cap field, as typed.
 * @param catalog - The catalog, for the duplicate and capacity checks.
 * @returns The problem, or undefined when the row can be added.
 */
function validate(
  id: string,
  context: string,
  output: string,
  catalog: ModelCatalogController,
): string | undefined {
  if (id === '') return 'Enter a model id.'
  if (!MODEL_ID.test(id)) return 'A model id is letters, digits, dots, dashes or colons.'
  if (catalog.models.some(model => model.id === id)) return `${id} is already listed.`
  if (!catalog.canAdd(id)) return 'This browser is holding as many models as it may.'
  const window = number(context)
  const cap = number(output)
  if (window === null || cap === null) return 'Capacities are whole numbers of tokens.'
  if (window !== undefined && (window < MIN_CONTEXT_WINDOW || window > MAX_CONTEXT_WINDOW)) {
    return `A context window is between ${tokens(MIN_CONTEXT_WINDOW)} and ${tokens(MAX_CONTEXT_WINDOW)}.`
  }
  if (cap !== undefined && cap < MIN_OUTPUT_TOKENS) {
    return `An output cap is at least ${String(MIN_OUTPUT_TOKENS)} tokens.`
  }
  // The SDK refuses a cap that does not fit inside the window, and it refuses
  // it at run time, so the pair is checked here rather than discovered later.
  if (window !== undefined && cap !== undefined && cap >= window) {
    return 'The output cap has to fit inside the context window.'
  }
  return undefined
}

/** A typed capacity: the number, undefined when blank, null when unusable. */
function number(value: string): number | undefined | null {
  const raw = value.trim()
  if (raw === '') return undefined
  if (!/^\d+$/u.test(raw)) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** A token count in the shorthand the reader already thinks in. */
function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`
  return String(value)
}
