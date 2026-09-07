'use client'

/**
 * The blocking-question card: the UI half of the SDK's
 * `request_user_input` boundary. Every question offers the model's suggested
 * options plus a free-form answer, and the whole card is submitted at once so
 * the parked tool call resumes with one response.
 */

import { useState } from 'react'
import clsx from 'clsx'
import type { WireQuestion } from '@chat-agents/backend'
import { Button } from '../primitives'
import type { ChatNode } from './types'
import css from './QuestionCard.module.css'

interface Draft {
  /** The selected option label, or the empty string while the free-form field owns the answer. */
  readonly option: string
  readonly custom: string
}

function answerOf(draft: Draft | undefined): string {
  if (draft === undefined) return ''
  return draft.custom.trim() !== '' ? draft.custom.trim() : draft.option
}

function QuestionBlock({
  question,
  index,
  total,
  draft,
  onChange,
}: {
  question: WireQuestion
  index: number
  total: number
  draft: Draft
  onChange: (next: Draft) => void
}) {
  return (
    <div className={css.block}>
      <div>
        <span className={css.eyebrow}>
          {question.header}
          {total > 1 && <span className={css.progress}>{` ${String(index + 1)}/${String(total)}`}</span>}
        </span>
        <p className={css.title}>{question.question}</p>
      </div>
      <div className={css.options}>
        {question.options.map((option, optionIndex) => (
          <button
            type="button"
            key={option.label}
            className={clsx(css.option, draft.option === option.label && draft.custom === '' && css.optionSelected)}
            onClick={() => { onChange({ option: option.label, custom: '' }) }}
          >
            <span className={css.number}>{optionIndex + 1}</span>
            <span className={css.optionCopy}>
              <span className={css.optionLine}>
                <span className={css.optionLabel}>{option.label}</span>
              </span>
              <span className={css.description}>{option.description}</span>
            </span>
          </button>
        ))}
      </div>
      <div className={clsx(css.customRow, draft.custom !== '' && css.customRowActive)}>
        <input
          className={css.fieldInput}
          placeholder="Or answer in your own words…"
          value={draft.custom}
          onChange={event => { onChange({ option: draft.option, custom: event.target.value }) }}
        />
      </div>
    </div>
  )
}

/**
 * Render one question node.
 * @param props - The node and the submit callback.
 * @returns The interactive card, or its settled transcript once answered.
 */
export function QuestionCard({
  node,
  onSubmit,
}: {
  node: Extract<ChatNode, { kind: 'question' }>
  onSubmit: (requestId: string, answers: Record<string, string>) => void
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [sent, setSent] = useState(false)
  const settled = node.answered || sent
  const complete = node.questions.every(question => answerOf(drafts[question.id]) !== '')

  if (settled) {
    return (
      <dl className={css.settled}>
        {node.questions.map(question => (
          <div className={css.settledItem} key={question.id}>
            <dt className={css.settledQuestion}>{question.question}</dt>
            <dd className={css.settledAnswer}>{answerOf(drafts[question.id]) || '(answered)'}</dd>
          </div>
        ))}
      </dl>
    )
  }

  return (
    <div className={css.frame}>
      <span className={css.eyebrow}>Needs your decision</span>
      {node.questions.map((question, index) => (
        <QuestionBlock
          key={question.id}
          question={question}
          index={index}
          total={node.questions.length}
          draft={drafts[question.id] ?? { option: '', custom: '' }}
          onChange={(next) => { setDrafts(current => ({ ...current, [question.id]: next })) }}
        />
      ))}
      <div className={css.footer}>
        <Button
            variant="primary"
            disabled={!complete}
            onClick={() => {
              setSent(true)
              onSubmit(
                node.requestId,
                Object.fromEntries(node.questions.map(question => [question.id, answerOf(drafts[question.id])])),
              )
            }}
          >
          Send answer
        </Button>
      </div>
    </div>
  )
}
