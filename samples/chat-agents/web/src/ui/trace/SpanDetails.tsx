'use client'

/**
 * The right pane: one span, in full.
 *
 * Three tabs, because three different questions get asked of a span. "Input +
 * Output" is the conversation the step had — the prompt that went in, the text,
 * reasoning and tool calls that came back. "API call" is the provider call
 * underneath it: the payload as sent and the stream as received, which is where
 * a model that ignored the file it had just read has to be explained. Metadata
 * is the raw record, every attribute the SDK reported, for when the readable
 * version has left out the one field being chased.
 */

import { useState } from 'react'
import type { WireSpan } from '@chat-agents/backend'
import { IconClockOutline16, IconCopyOutline16, writeClipboard } from '../primitives'
import { duration } from './spans'
import css from './SpanDetails.module.css'

type Tab = 'io' | 'api' | 'metadata'

/** Pretty JSON, or the string itself when the value is already text. */
function readable(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** The whole span as the raw record, in a stable field order. */
function metadata(span: WireSpan): string {
  return JSON.stringify({
    name: span.name,
    kind: span.kind,
    context: { traceId: span.traceId, spanId: span.spanId, runId: span.runId },
    parentSpanId: span.parentSpanId,
    startedAt: new Date(span.startedAt).toISOString(),
    durationMs: span.durationMs,
    status: span.status,
    ...span.member === undefined ? {} : { member: span.member },
    attributes: span.attributes ?? {},
    ...span.usage === undefined ? {} : { usage: span.usage },
    ...span.error === undefined ? {} : { error: span.error },
    ...span.input === undefined ? {} : { input: span.input },
    ...span.output === undefined ? {} : { output: span.output },
  }, null, 2)
}

/** A block of text with its own copy button. */
function Block({ title, body }: { title: string; body: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <section className={css.block}>
      <header className={css.blockHeader}>
        <h4 className={css.blockTitle}>{title}</h4>
        <button
          type="button"
          className={css.copy}
          title={copied ? 'Copied' : `Copy ${title.toLowerCase()}`}
          onClick={() => {
            void writeClipboard(body).then(() => {
              setCopied(true)
              window.setTimeout(() => { setCopied(false) }, 1200)
            })
          }}
        >
          <IconCopyOutline16 />
        </button>
      </header>
      <pre className={css.code}>{body}</pre>
    </section>
  )
}

/** The token counters a model call reports, as a short row. */
function Usage({ usage }: { usage: NonNullable<WireSpan['usage']> }) {
  const entries = Object.entries(usage).filter(([, count]) => typeof count === 'number')
  if (entries.length === 0) return null
  return (
    <dl className={css.usage}>
      {entries.map(([key, count]) => (
        <div key={key} className={css.usageCell}>
          <dt className={css.usageKey}>{key.replace(/Tokens$/, '')}</dt>
          <dd className={css.usageValue}>{String(count)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The provider call a model round made, as request and response.
 *
 * Two blocks rather than one: what went out and what came back are read
 * separately, and a reader chasing "why did it call that tool" wants the
 * payload's tail beside the stream's tool calls, not one JSON blob holding
 * both. The parameters lead, because a wrong effort or a missing tool explains
 * a round before its messages do.
 * @param props.call - The recorded call.
 * @returns The API tab's body.
 */
function ApiCall({ call }: { call: NonNullable<WireSpan['apiCall']> }) {
  const request = {
    provider: call.provider,
    model: call.model,
    ...call.params,
    ...call.system === undefined ? {} : { system: call.system },
    messages: call.messages,
  }
  return (
    <>
      <p className={css.note}>
        {`${call.provider} · ${call.model} · ${String(call.durationMs)}ms · `}
        {`${String(call.response.chunks)} chunks`}
        {call.truncated === true && ' · payload shortened to fit'}
      </p>
      {call.response.error !== undefined && (
        <p className={css.error}>{call.response.error}</p>
      )}
      <Block title="Request" body={JSON.stringify(request, null, 2)} />
      <Block title="Response" body={JSON.stringify(call.response, null, 2)} />
    </>
  )
}

/**
 * Show one span's input, output, and raw record.
 * @param props.span - The selected span, or undefined when nothing is selected.
 * @returns The details pane.
 */
export function SpanDetails({ span }: { span: WireSpan | undefined }) {
  const [tab, setTab] = useState<Tab>('io')

  if (span === undefined) {
    return (
      <div className={css.pane}>
        <p className={css.empty}>Select a step on the left to see what it sent and received.</p>
      </div>
    )
  }

  return (
    <div className={css.pane}>
      <header className={css.head}>
        <div className={css.headRow}>
          <h3 className={css.title}>{span.name}</h3>
          <span className={css.clock}>
            <IconClockOutline16 />
            {duration(span.durationMs)}
          </span>
        </div>
        <p className={css.stamp}>
          {new Date(span.startedAt).toLocaleString()}
          {span.member !== undefined && <span className={css.member}>{span.member}</span>}
        </p>
      </header>

      <nav className={css.tabs} aria-label="Span details">
        <button
          type="button"
          className={css.tab}
          data-active={tab === 'io' || undefined}
          onClick={() => { setTab('io') }}
        >
          Input + Output
        </button>
        {/* Only for a step that made one: a tool call has no API call under it,
            and an empty tab is a dead end to click into. */}
        {span.apiCall !== undefined && (
          <button
            type="button"
            className={css.tab}
            data-active={tab === 'api' || undefined}
            onClick={() => { setTab('api') }}
          >
            API call
          </button>
        )}
        <button
          type="button"
          className={css.tab}
          data-active={tab === 'metadata' || undefined}
          onClick={() => { setTab('metadata') }}
        >
          Metadata
        </button>
      </nav>

      <div className={css.body}>
        {tab === 'api' && span.apiCall !== undefined
          ? <ApiCall call={span.apiCall} />
          : tab === 'metadata'
            ? <Block title="Metadata" body={metadata(span)} />
            : (
              <>
                {span.error !== undefined && (
                  <p className={css.error}>
                    <b>{span.error.type}</b>
                    {span.error.code === undefined ? '' : ` (${span.error.code})`}
                    {`: ${span.error.message}`}
                  </p>
                )}
                {span.usage !== undefined && <Usage usage={span.usage} />}
                {span.input === undefined
                  ? <p className={css.empty}>This step recorded no input.</p>
                  : <Block title="Input" body={readable(span.input)} />}
                {span.output === undefined
                  ? (
                    <p className={css.empty}>
                      {span.durationMs === null
                        ? 'Still running — the output arrives when the step ends.'
                        : 'This step recorded no output.'}
                    </p>
                  )
                  : <Block title="Output" body={readable(span.output)} />}
              </>
            )}
      </div>
    </div>
  )
}
