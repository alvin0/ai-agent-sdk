'use client'

/**
 * The permission surface: the UI half of the SDK's approval boundary.
 *
 * Two shapes, because a pending decision and a past decision are different
 * things to read. While a call is parked, {@link ApprovalCard} takes over the
 * composer — the harness's shape, and the reason it works: the prompt cannot be
 * scrolled away, and there is nothing else to type into until it is answered.
 * Once answered, {@link ApprovalRecord} leaves a one-line record in the
 * transcript saying what was permitted and for how long.
 *
 * The preview inside the card is the same `ToolCard` the tool row will show
 * afterwards — the diff that would be written, the command that would run — so
 * the decision is made against the change itself, not against a tool name.
 */

import { useState } from 'react'
import clsx from 'clsx'
import type { WireApprovalScope } from '@chat-agents/backend'
import { Button } from '../primitives'
import { ToolCardBody } from './ToolCardBody'
import { TITLES } from './ToolNode'
import type { ChatNode } from './types'
import css from './ApprovalCard.module.css'

type ApprovalNode = Extract<ChatNode, { kind: 'approval' }>

/** The three scopes, in increasing reach. */
const SCOPES: readonly { id: WireApprovalScope; label: string; allow: string }[] = [
  { id: 'once', label: 'Just once', allow: 'Allow once' },
  { id: 'session', label: 'This chat', allow: 'Allow for this chat' },
  { id: 'workspace', label: 'This project', allow: 'Allow for this project' },
]

const DECIDED: Readonly<Record<'allow' | 'deny' | 'abort', string>> = {
  allow: 'Allowed',
  deny: 'Refused',
  abort: 'Withdrawn',
}

const REACH: Readonly<Record<WireApprovalScope, string>> = {
  once: 'this call only',
  session: 'for this chat',
  workspace: 'for this project',
}

/** What a scope stops asking about, phrased against the pending call. */
function reachHint(scope: WireApprovalScope, ruleLabel: string): string {
  switch (scope) {
    case 'once':
      return 'Ask me again next time.'
    case 'session':
      return `Stop asking about ${ruleLabel} until this conversation ends.`
    default:
      return `Remember ${ruleLabel} for this project, across restarts.`
  }
}

/**
 * Render the prompt for one parked call.
 * @param props - The pending node and the decision callback.
 * @returns The composer takeover.
 */
export function ApprovalCard({
  node,
  onDecide,
}: {
  node: ApprovalNode
  onDecide: (callId: string, decision: 'allow' | 'deny', scope: WireApprovalScope) => void
}) {
  const [scope, setScope] = useState<WireApprovalScope>('once')
  // The caller settles the node, which unmounts this card. Until that state
  // lands, a second click would answer an already-released call.
  const [answered, setAnswered] = useState(false)
  const chosen = SCOPES.find(entry => entry.id === scope) ?? SCOPES[0]

  const decide = (decision: 'allow' | 'deny') => () => {
    setAnswered(true)
    onDecide(node.callId, decision, decision === 'allow' ? scope : 'once')
  }

  return (
    <div className={css.root} data-approval-call={node.callId}>
      <div className={css.card}>
        <div className={css.strip}>
          <span className={css.dot} />
          Waiting for your permission
        </div>
        <div className={css.body} tabIndex={0} role="group" aria-label="Pending permission">
          <div className={css.headline}>{`${TITLES[node.toolName] ?? node.toolName}: ${node.summary}`}</div>
          {node.card !== undefined && (
            <div className={css.preview}>
              <ToolCardBody card={node.card} />
            </div>
          )}
        </div>
        <div className={css.scopes}>
          <span className={css.scopeLabel}>Apply to</span>
          {SCOPES.map(entry => (
            <button
              type="button"
              key={entry.id}
              className={clsx(css.scope, entry.id === scope && css.scopeActive)}
              aria-pressed={entry.id === scope}
              onClick={() => { setScope(entry.id) }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <p className={css.scopeHint}>{reachHint(scope, node.ruleLabel)}</p>
        <div className={css.actionRow}>
          <Button variant="outline" className={css.reject} disabled={answered} onClick={decide('deny')}>
            Don&apos;t allow
          </Button>
          <Button variant="primary" disabled={answered} onClick={decide('allow')}>
            {chosen.allow}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the transcript record of an answered prompt.
 * @param props - The settled node.
 * @returns One line saying what was decided, and how far it reached.
 */
export function ApprovalRecord({ node }: { node: ApprovalNode }) {
  const decision = node.decision
  if (decision === undefined) return null
  return (
    <div className={clsx(css.record, decision === 'allow' ? css.recordAllow : css.recordDeny)}>
      <span className={css.recordMark}>{DECIDED[decision]}</span>
      <span className={css.recordTitle}>{TITLES[node.toolName] ?? node.toolName}</span>
      <span className={css.recordSummary}>{node.summary}</span>
      {decision === 'allow' && <span className={css.recordScope}>{REACH[node.scope ?? 'once']}</span>}
    </div>
  )
}
