/** Direct pi-ai probe: does StreamOptions.onPayload reach the HTTP body? */
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

const model = {
  id: 'echo',
  name: 'echo',
  api: 'openai-completions',
  provider: 'echo',
  baseUrl: 'http://127.0.0.1:8199/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32768,
}

const streams = openAICompletionsApi()
const events = streams.streamSimple(model, { messages: [{ role: 'user', content: 'hi' }] }, {
  apiKey: 'probe-key',
  onPayload: (payload) => {
    process.stdout.write(`[direct] onPayload called keys=${JSON.stringify(Object.keys(payload))}\n`)
    return { ...payload, persona: 'AM' }
  },
})

for await (const event of events) {
  if (event.type === 'done' || event.type === 'error') {
    process.stdout.write(`[direct] terminal ${event.type}\n`)
  }
}
