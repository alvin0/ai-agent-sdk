import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Edge Chat Agents',
  description: 'A Next.js Edge chat surface over the ai-agent-sdk agent loop.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {
              const key = 'edge-chat-agents.theme'
              let preference = null
              try { preference = window.localStorage.getItem(key) } catch {}
              const dark = preference === 'dark'
                || (preference !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
              document.body.toggleAttribute('data-ds-dark-theme', dark)
              document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
            })()`,
          }}
        />
        <div id="app-root">{children}</div>
      </body>
    </html>
  )
}
