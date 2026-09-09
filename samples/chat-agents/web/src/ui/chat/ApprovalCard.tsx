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
import type { WireApprovalScope, WireHazard, WireRule } from '@chat-agents/backend'
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
function reachHint(scope: WireApprovalScope, ruleLabel: string | undefined): string {
  // No rule to widen to: the prompt offered none, because nothing about this
  // call can be recognised again safely. Saying so beats a dead chip row.
  if (ruleLabel === undefined) return 'This call can only be permitted once.'
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
 * The rules a node offers.
 *
 * Transcripts persist, in SQLite and in the browser's cache, and rows written
 * before the rule list existed carry a single `ruleKey` and no `rules` at all.
 * Reading them as an empty list keeps an old conversation rendering instead of
 * throwing on the first approval row in it.
 */
function rulesOf(node: ApprovalNode): readonly WireRule[] {
  return node.rules ?? []
}

/** The hazards a node carries; absent on rows written before they existed. */
function hazardsOf(node: ApprovalNode): readonly WireHazard[] {
  return node.hazards ?? []
}

/** The rule chosen from what a prompt offered, narrowest first. */
function chosenRule(rules: readonly WireRule[], key: string | undefined): WireRule | undefined {
  return rules.find(rule => rule.key === key) ?? rules[0]
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
  onDecide: (
    callId: string,
    decision: 'allow' | 'deny',
    scope: WireApprovalScope,
    ruleKey?: string,
  ) => void
}) {
  const [scope, setScope] = useState<WireApprovalScope>('once')
  const [ruleKey, setRuleKey] = useState<string | undefined>(undefined)
  // A destructive line is confirmed twice on purpose. The first click arms the
  // button and re-labels it with what is about to happen; nothing is released
  // until the second. `rm -rf ~` sitting one reflex-click away from a machine
  // is the case this exists for.
  const [armed, setArmed] = useState(false)
  // The caller settles the node, which unmounts this card. Until that state
  // lands, a second click would answer an already-released call.
  const [answered, setAnswered] = useState(false)
  const chosen = SCOPES.find(entry => entry.id === scope) ?? SCOPES[0]
  const rules = rulesOf(node)
  const rule = chosenRule(rules, ruleKey)
  const hazards = hazardsOf(node)
  const critical = hazards.some(hazard => hazard.severity === 'critical')
  // Two clicks for ANY hazard, including a warning. `rm -rf $BUILD_DIR` with
  // the variable unset is the classic way a machine loses a home directory,
  // and it reads as a warning here precisely because nothing can say what it
  // will delete — which is a reason to slow down, not to speed up.
  const hazardous = hazards.length > 0
  // `once` grants nothing, so a width to grant it at would be a decision with
  // no consequence; and one rule is not a choice.
  const showRules = scope !== 'once' && rules.length > 1

  const decide = (decision: 'allow' | 'deny') => () => {
    if (decision === 'allow' && hazardous && !armed) {
      setArmed(true)
      return
    }
    setAnswered(true)
    if (decision !== 'allow') {
      onDecide(node.callId, decision, 'once')
      return
    }
    onDecide(node.callId, decision, scope, scope === 'once' ? undefined : rule?.key)
  }

  return (
    <div className={css.root} data-approval-call={node.callId}>
      <div className={css.card}>
        <div className={clsx(css.strip, critical && css.stripCritical)}>
          <span className={css.dot} />
          {critical ? 'This destroys files — read it before answering' : 'Waiting for your permission'}
        </div>
        {hazards.length > 0 && (
          <div className={css.hazards} role="alert">
            {hazards.map(hazard => (
              <div
                key={`${hazard.severity}:${hazard.title}`}
                className={clsx(css.hazard, hazard.severity === 'critical' && css.hazardCritical)}
              >
                <span className={css.hazardTitle}>
                  {hazard.severity === 'critical' ? 'Destructive — ' : 'Careful — '}
                  {hazard.title}
                </span>
                <span className={css.hazardDetail}>{hazard.detail}</span>
              </div>
            ))}
          </div>
        )}
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
              // A prompt with no rule has nothing to remember, so a longer
              // scope would silently mean `once`. Better to show it is closed.
              disabled={rules.length === 0 && entry.id !== 'once'}
              onClick={() => { setScope(entry.id) }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {showRules && (
          <div className={css.scopes}>
            <span className={css.scopeLabel}>Rule</span>
            {rules.map(entry => (
              <button
                type="button"
                key={entry.key}
                className={clsx(css.scope, entry.key === rule?.key && css.scopeActive)}
                aria-pressed={entry.key === rule?.key}
                onClick={() => { setRuleKey(entry.key) }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        )}
        <p className={css.scopeHint}>
          {reachHint(scope, rules.length === 0 ? undefined : rule?.label)}
        </p>
        {hazardous && (
          <p className={css.scopeHint}>
            {armed
              ? 'Click again to run it. Nothing has run yet.'
              : 'Allowing takes two clicks here, on purpose.'}
          </p>
        )}
        <div className={css.actionRow}>
          {/* On a destructive call the safe answer is the prominent one: the
              primary button is where a hurried click lands. */}
          <Button
            variant={hazardous ? 'primary' : 'outline'}
            className={clsx(!hazardous && css.reject)}
            disabled={answered}
            onClick={decide('deny')}
          >
            Don&apos;t allow
          </Button>
          <Button
            variant={hazardous ? 'outline' : 'primary'}
            className={clsx(hazardous && css.dangerous)}
            disabled={answered}
            onClick={decide('allow')}
          >
            {hazardous
              ? armed
                ? critical ? 'Yes, destroy them' : 'Yes, run it'
                : 'Allow anyway'
              : chosen.allow}
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
      {decision === 'allow' && (
        <span className={css.recordScope}>
          {node.ruleKey === undefined
            ? REACH[node.scope ?? 'once']
            : `${chosenRule(rulesOf(node), node.ruleKey)?.label ?? node.ruleKey}, ${REACH[node.scope ?? 'once']}`}
        </span>
      )}
    </div>
  )
}
