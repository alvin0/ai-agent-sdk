import { ChatApp } from '../ui/ChatApp'

// The shell renders on the Edge runtime too, so the whole app can deploy to one.
export const runtime = 'edge'

export default function Page() {
  return <ChatApp />
}
