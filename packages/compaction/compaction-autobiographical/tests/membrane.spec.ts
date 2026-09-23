import { describe, expect, it, vi } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as MembraneBlock, NormalizedRequest } from '@animalabs/membrane'
import { MembraneBridge } from '../src/membrane.ts'
import type { MembraneBridgeOptions } from '../src/membrane.ts'

const AGENT = 'assistant'
const STOP: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }

/** LLM runtime stub: records each call's options and replays a scripted stream. */
function scriptedLlm(chunks: readonly StreamChunk[]): { llm: LlmRuntime; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  const llm = {
    stream: async function* (options: GenerateOptions) {
      calls.push(options)
      yield* chunks
    },
    listProviders: () => [],
  } as unknown as LlmRuntime
  return { llm, calls }
}

function bridge(llm: LlmRuntime, overrides: Partial<MembraneBridgeOptions> = {}): MembraneBridge {
  return new MembraneBridge({
    llm,
    provider: 'test',
    model: 'test-model',
    maxTokens: 4096,
    agentParticipant: AGENT,
    ...overrides,
  })
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages: [{ participant: AGENT, content: [{ type: 'text', text: 'recall this' }] }],
    config: { model: 'test-model', maxTokens: 0 },
    ...overrides,
  }
}

describe('MembraneBridge.complete', () => {
  it('maps every membrane block into the harness vocabulary and names foreign participants', async () => {
    const { llm, calls } = scriptedLlm([STOP])
    const media: MembraneBlock = { type: 'image', source: { type: 'url', url: 'https://example.test/i.png' } }
    const result = await bridge(llm).complete(request({
      messages: [
        {
          participant: AGENT,
          content: [
            { type: 'text', text: 'recall this' },
            { type: 'thinking', thinking: 'pondering' },
            { type: 'tool_use', id: 'call-1', name: 'echo', input: { a: 1 } },
            { type: 'tool_result', toolUseId: 'call-1', content: 'plain result', isError: true },
            {
              type: 'tool_result',
              toolUseId: 'call-2',
              content: [
                { type: 'text', text: 'part one' },
                media,
                { type: 'text', text: 'part two' },
              ],
            },
            { type: 'redacted_thinking', data: 'opaque payload' },
            media,
          ],
        },
        { participant: 'user', content: [{ type: 'text', text: 'what happened?' }] },
        {
          participant: 'Context Manager',
          // A foreign participant whose first block is not text keeps every
          // block unprefixed: the speaker prefix rides only a leading text block.
          content: [
            { type: 'tool_use', id: 'call-3', name: 'echo', input: {} },
            { type: 'text', text: 'later text' },
          ],
        },
        { participant: 'Zulip Bot', content: [{ type: 'text', text: 'hello' }] },
      ],
    }))

    const [agent, user, named, prefixed] = calls[0]!.messages
    expect(agent!.role).toBe('assistant')
    expect(agent!.source).toEqual({ kind: 'model', provider: 'test', model: 'test-model' })
    expect(agent!.content).toEqual([
      { type: 'text', text: 'recall this' },
      { type: 'reasoning', text: 'pondering' },
      { type: 'tool-call', id: 'call-1', name: 'echo', arguments: '{"a":1}' },
      { type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'plain result' }], isError: true },
      { type: 'tool-result', toolCallId: 'call-2', content: [{ type: 'text', text: 'part one\npart two' }] },
      { type: 'text', text: '[image omitted from memory-formation transcript]' },
    ])
    expect(user!.role).toBe('user')
    expect(user!.source).toEqual({ kind: 'plugin', plugin: 'compaction-autobiographical' })
    expect(named!.content).toEqual([
      { type: 'tool-call', id: 'call-3', name: 'echo', arguments: '{}' },
      { type: 'text', text: 'later text' },
    ])
    expect(prefixed!.content).toEqual([{ type: 'text', text: 'Zulip Bot: hello' }])
    expect(result.rawAssistantText).toBe('')
  })

  it('reassembles streamed blocks, keeping unparseable tool arguments verbatim', async () => {
    const { llm } = scriptedLlm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'I recall ' },
      { type: 'text-delta', index: 0, text: 'the exchange.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'I recall the exchange.' } },
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: 'because' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'because' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: CallId('call-1'), name: 'echo', argumentsDelta: '{"a":1}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: CallId('call-1'), name: 'echo', arguments: '{"a":1}' } },
      // Argument strings that never yield a JSON object: a truncated stream, a
      // primitive, `null`, and an array each keep an empty input map.
      { type: 'block-end', index: 3, block: { type: 'tool-call', id: CallId('call-2'), name: 'echo', arguments: '{"a":' } },
      { type: 'block-end', index: 4, block: { type: 'tool-call', id: CallId('call-3'), name: 'echo', arguments: '42' } },
      { type: 'block-end', index: 5, block: { type: 'tool-call', id: CallId('call-4'), name: 'echo', arguments: 'null' } },
      { type: 'block-end', index: 6, block: { type: 'tool-call', id: CallId('call-5'), name: 'echo', arguments: '[1]' } },
      // A block the memory-formation transcript has no slot for is dropped.
      { type: 'block-end', index: 7, block: { type: 'tool-result', toolCallId: CallId('call-1'), content: [] } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } },
      STOP,
    ])

    // A source span far larger than thinking + text keeps the thinking block.
    const result = await bridge(llm).complete(request({
      messages: [{ participant: AGENT, content: [{ type: 'text', text: 'x'.repeat(200) }] }],
    }))
    expect(result.content).toEqual([
      { type: 'text', text: 'I recall the exchange.' },
      { type: 'thinking', thinking: 'because' },
      { type: 'tool_use', id: 'call-1', name: 'echo', input: { a: 1 } },
      { type: 'tool_use', id: 'call-2', name: 'echo', input: {}, unparseableInput: '{"a":' },
      { type: 'tool_use', id: 'call-3', name: 'echo', input: {} },
      { type: 'tool_use', id: 'call-4', name: 'echo', input: {} },
      { type: 'tool_use', id: 'call-5', name: 'echo', input: {} },
    ])
    expect(result.rawAssistantText).toBe('I recall the exchange.')
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
    expect(result.toolCalls).toEqual([])
    expect(result.toolResults).toEqual([])
    expect(result.details).toEqual({})
    expect(result.raw).toEqual({})
  })

  it('strips stored thinking whose cost exceeds the folded source span', async () => {
    const thinking = 'p'.repeat(120)
    const text = 'I recall the exchange.'
    const { llm } = scriptedLlm([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: thinking },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text },
      { type: 'block-end', index: 1, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 40 } },
      STOP,
    ])
    const result = await bridge(llm).complete(request({
      messages: [
        { participant: AGENT, content: [{ type: 'text', text: 'recall this' }] },
        // Non-text request blocks still count toward the source span.
        { participant: AGENT, content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] },
        { participant: AGENT, content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/i.png' } }] },
      ],
    }))
    // 120 + 22 thinking+text chars vs the tiny source span: the fold would
    // cost more than what it replaces, so the library gets text only and a
    // text-priced output count.
    expect(result.content).toEqual([{ type: 'text', text }])
    expect(result.rawAssistantText).toBe(text)
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: Math.ceil(text.length / 4) })
  })

  it('prefers exact usage arithmetic over the text estimate when stripping', async () => {
    const thinking = 'p'.repeat(120)
    const { llm } = scriptedLlm([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'I recall.' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 100, reasoningTokens: 90 } },
      STOP,
    ])
    const result = await bridge(llm).complete(request())
    expect(result.content).toEqual([{ type: 'text', text: 'I recall.' }])
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 10 })
  })

  it('falls back to zeroed usage when a stripped stream reported none', async () => {
    const thinking = 'p'.repeat(120)
    const { llm } = scriptedLlm([
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'I recall.' } },
      STOP,
    ])
    const result = await bridge(llm).complete(request())
    expect(result.content).toEqual([{ type: 'text', text: 'I recall.' }])
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: Math.ceil('I recall.'.length / 4) })
  })

  it.each([
    [{ kind: 'max-tokens' } as const, 'max_tokens'],
    [{ kind: 'tool-calls' } as const, 'tool_use'],
  ])('reports %j as stop reason %s', async (reason, stopReason) => {
    const { llm } = scriptedLlm([{ type: 'finish', reason }])
    await expect(bridge(llm).complete(request())).resolves.toMatchObject({ stopReason })
  })

  it.each([
    ['error', { kind: 'error', failure: { message: 'upstream down', code: 'E_DOWN' } } as const],
    ['aborted', { kind: 'aborted', failure: { message: 'cancelled', code: 'E_ABORT' } } as const],
  ])('warns and reports abort when a compression call ends %s', async (kind, reason) => {
    const warn = vi.fn()
    const { llm } = scriptedLlm([{ type: 'finish', reason }])
    await expect(bridge(llm, { warn }).complete(request())).resolves.toMatchObject({ stopReason: 'abort' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(`compression call ended ${kind}:`)
  })

  it('falls back to the configured generation cap when the request states none', async () => {
    const { llm, calls } = scriptedLlm([STOP])
    const result = await bridge(llm).complete(request())
    expect(calls[0]).toMatchObject({
      provider: 'test',
      model: 'test-model',
      maxTokens: 4096,
      purpose: 'compaction',
    })
    expect(calls[0]!.system).toBeUndefined()
    expect(calls[0]!.temperature).toBeUndefined()
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('forwards an explicit system prompt and temperature, and floors the cap to the configured pin', async () => {
    const { llm, calls } = scriptedLlm([STOP])
    await bridge(llm).complete(request({
      system: 'You are forming a memory.',
      config: { model: 'test-model', maxTokens: 128, temperature: 0 },
    }))
    expect(calls[0]).toMatchObject({
      system: 'You are forming a memory.',
      // The bridge cap pins the budget: a smaller request floors up to it.
      maxTokens: 4096,
      temperature: 0,
    })
  })

  it('leaves a larger request size untouched', async () => {
    const { llm, calls } = scriptedLlm([STOP])
    await bridge(llm).complete(request({
      config: { model: 'test-model', maxTokens: 100_000 },
    }))
    expect(calls[0]!.maxTokens).toBe(100_000)
  })

  it('omits the generation cap when neither the request nor the bridge sets one', async () => {
    const { llm, calls } = scriptedLlm([STOP])
    await new MembraneBridge({
      llm,
      provider: 'test',
      model: 'test-model',
      agentParticipant: AGENT,
    }).complete(request())
    expect(calls[0]!.maxTokens).toBeUndefined()
  })

  it('warns through the default console sink when no sink was injected', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { llm } = scriptedLlm([{
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'upstream down', code: 'E_DOWN' } },
      }])
      await bridge(llm).complete(request())
      expect(consoleWarn).toHaveBeenCalledWith(
        '[compaction-autobiographical] compression call ended error: E_DOWN upstream down',
      )
    } finally {
      consoleWarn.mockRestore()
    }
  })

  it.each([
    ['an Error', new Error('provider down'), 'provider down'],
    ['a non-Error', 'transport closed', 'transport closed'],
  ])('warns and rethrows when a compression call throws %s', async (_label, thrown, expected) => {
    const warn = vi.fn()
    const llm = {
      stream: async function* (): AsyncIterable<StreamChunk> {
        throw thrown
      },
    } as unknown as LlmRuntime

    // The strategy classifies a thrown call as `abort` without the error text;
    // the bridge echoes it and stays transparent about the failure.
    await expect(bridge(llm, { warn }).complete(request())).rejects.toBe(thrown)
    expect(warn).toHaveBeenCalledWith(`compression call threw: ${expected}`)
  })
})
