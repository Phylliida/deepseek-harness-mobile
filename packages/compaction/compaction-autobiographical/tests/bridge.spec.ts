/**
 * The compression-call seam: the library's request vocabulary translated into
 * the harness's, and the harness's stream translated back into the response the
 * library prices a fold with.
 *
 * The engine specs fold through a fake summarizer that never reaches this file,
 * so these cases are the only ones that pin the translation — including the
 * error path, where a thrown call has to surface as a diagnosable quarantine
 * rather than a silent abort.
 */

import { CallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { ContentBlock as MembraneBlock, NormalizedRequest, NormalizedResponse } from '@animalabs/membrane'
import { describe, expect, it } from 'vitest'
import { createBridge } from '../src/bridge.ts'
import type { BridgeOptions } from '../src/bridge.ts'

/** A runtime whose stream is the given script; `calls` records what it was asked. */
function runtime(
  chunks: readonly StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>),
  calls: GenerateOptions[] = [],
): LlmRuntime {
  return {
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      if (typeof chunks === 'function') {
        yield* chunks(options)
        return
      }
      yield* chunks
    },
  } as unknown as LlmRuntime
}

function textChunks(text: string, usage?: TokenUsage): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage === undefined ? [] : [{ type: 'usage', usage } as StreamChunk]),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function request(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    messages: [{ participant: 'assistant', content: [{ type: 'text', text: 'source' }] }],
    config: { model: 'test-model', maxTokens: 1024 },
    ...overrides,
  }
}

/** The bridge as the compression path sees it: only `complete` is ever called. */
function complete(
  options: Partial<BridgeOptions>,
  req: NormalizedRequest,
): Promise<NormalizedResponse> {
  const bridge = createBridge({
    llm: runtime(textChunks('recollection')),
    provider: 'test',
    ...options,
  })
  return (bridge as unknown as {
    complete(request: NormalizedRequest): Promise<NormalizedResponse>
  }).complete(req)
}

describe('createBridge', () => {
  describe('request translation', () => {
    it('carries every block the harness can express and elides the ones it cannot', async () => {
      const calls: GenerateOptions[] = []
      const blocks: MembraneBlock[] = [
        { type: 'text', text: 'keep me' },
        { type: 'thinking', thinking: 'a thought' },
        { type: 'redacted_thinking', data: 'opaque-ciphertext' },
        { type: 'tool_use', id: 'call-1', name: 'read', input: { path: '/x' } },
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'aGk=' } },
      ]
      await complete(
        { llm: runtime(textChunks('ok'), calls) },
        request({ messages: [{ participant: 'user', content: blocks }] }),
      )

      const sent = calls[0]?.messages[0]?.content ?? []
      expect(sent.map(block => block.type)).toEqual(['text', 'reasoning', 'tool-call', 'text'])
      expect(sent[1]).toMatchObject({ type: 'reasoning', text: 'a thought' })
      // Tool arguments ride as the serialized string the library parses back.
      expect(sent[2]).toMatchObject({ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"/x"}' })
      // Media the harness cannot carry keeps the fact of the attachment.
      expect(sent[3]).toMatchObject({ type: 'text', text: '[image omitted from memory-formation transcript]' })
    })

    it('splits mixed messages so tool results never ride with prose', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls) },
        request({
          messages: [{
            participant: 'user',
            content: [
              { type: 'text', text: 'here is what I found' },
              { type: 'tool_result', toolUseId: 'call-9', content: 'file contents', isError: true },
            ],
          }],
        }),
      )

      // The result is its own message; the prose follows separately, so a
      // serializer cannot orphan the result from the call it answers.
      const sent = calls[0]?.messages ?? []
      expect(sent.map(message => message.role)).toEqual(['user', 'user'])
      expect(sent[0]?.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call-9', isError: true })
      expect(sent[1]?.content[0]).toMatchObject({ type: 'text', text: 'here is what I found' })
    })

    it('renders a tool result whose content is itself blocks', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls) },
        request({
          messages: [{
            participant: 'user',
            content: [{
              type: 'tool_result',
              toolUseId: 'call-2',
              content: [{ type: 'text', text: 'line one' }],
            }],
          }],
        }),
      )

      expect(calls[0]?.messages[0]?.content[0]).toMatchObject({
        type: 'tool-result',
        content: [{ type: 'text', text: 'line one' }],
      })
    })

    it('drops a block inside a tool result that the harness cannot express', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls) },
        request({
          messages: [{
            participant: 'user',
            content: [{
              type: 'tool_result',
              toolUseId: 'call-2',
              content: [
                { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } },
                { type: 'text', text: 'kept' },
              ],
            }],
          }],
        }),
      )

      // A tool result is text to the harness; an image inside one is elided
      // rather than stringified into the transcript.
      expect(calls[0]?.messages[0]?.content[0]).toMatchObject({
        type: 'tool-result',
        content: [{ type: 'text', text: 'kept' }],
      })
    })

    it('attributes a third-party participant by name and the agent as assistant', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls), agentParticipant: 'agent' },
        request({
          messages: [
            { participant: 'agent', content: [{ type: 'text', text: 'mine' }] },
            { participant: 'Reviewer', content: [{ type: 'text', text: 'theirs' }] },
          ],
        }),
      )

      const sent = calls[0]?.messages ?? []
      expect(sent[0]?.role).toBe('assistant')
      expect(sent[1]?.content[0]).toMatchObject({ type: 'text', text: 'Reviewer: theirs' })
    })

    it('keeps only a tool result when a mixed message has no prose left', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls) },
        request({
          messages: [{
            participant: 'user',
            content: [{ type: 'tool_result', toolUseId: 'call-3', content: 'only a result' }],
          }],
        }),
      )

      const sent = calls[0]?.messages ?? []
      expect(sent).toHaveLength(1)
      expect(sent[0]?.role).toBe('user')
      expect(sent[0]?.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'call-3', isError: false })
    })

    it('declares the agent\'s tools on the request', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls) },
        request({
          tools: [
            { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
            { name: 'bare', description: 'no parameters', inputSchema: { type: 'object' } },
          ],
        }),
      )

      // A summarizer replay that omits these reads to a provider as a foreign
      // agent trace, which is the refusal the library's ladder exists to climb.
      expect(calls[0]?.tools).toEqual([
        { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
        { name: 'bare', description: 'no parameters', parameters: { type: 'object' } },
      ])
    })

    it('forwards system and temperature, and floors maxTokens at the generation budget', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls), maxTokens: 4096 },
        request({ system: 'be terse', config: { model: 'test-model', maxTokens: 512, temperature: 0.2 } }),
      )

      expect(calls[0]).toMatchObject({ system: 'be terse', temperature: 0.2, maxTokens: 4096, purpose: 'compaction' })
    })

    it('uses the library\'s own cap when no floor is configured or the request asks for nothing', async () => {
      const calls: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), calls), maxTokens: 4096 },
        request({ config: { model: 'test-model', maxTokens: 0 } }),
      )
      expect(calls[0]?.maxTokens).toBe(4096)

      const uncapped: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), uncapped) },
        request({ config: { model: 'test-model', maxTokens: 512 } }),
      )
      expect(uncapped[0]?.maxTokens).toBe(512)

      const none: GenerateOptions[] = []
      await complete(
        { llm: runtime(textChunks('ok'), none) },
        request({ config: { model: 'test-model', maxTokens: 0 } }),
      )
      expect(none[0]).not.toHaveProperty('maxTokens')
    })
  })

  describe('response translation', () => {
    it('returns the assembled text with its billed usage and stop reason', async () => {
      const response = await complete(
        { llm: runtime(textChunks('a recollection', { inputTokens: 900, outputTokens: 120 })) },
        request(),
      )

      expect(response.rawAssistantText).toBe('a recollection')
      expect(response.usage).toEqual({ inputTokens: 900, outputTokens: 120 })
      expect(response.stopReason).toBe('end_turn')
      expect(response.content).toEqual([{ type: 'text', text: 'a recollection' }])
    })

    it('prices an unaccounted call at zero rather than failing', async () => {
      const response = await complete({}, request())
      expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
    })

    it.each([
      ['max-tokens', 'max_tokens'],
      ['tool-calls', 'tool_use'],
      ['aborted', 'abort'],
      ['error', 'abort'],
    ] as const)('reports %s as %s', async (kind, expected) => {
      const failure: LlmFailure = { code: 'test', message: 'synthetic' }
      const response = await complete(
        {
          llm: runtime([
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: 'partial' },
            { type: 'finish', reason: kind === 'aborted' || kind === 'error' ? { kind, failure } : { kind } },
          ]),
        },
        request(),
      )

      expect(response.stopReason).toBe(expected)
    })

    it('warns when the call ends in failure', async () => {
      const warned: string[] = []
      await complete(
        {
          llm: runtime([
            { type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limit', message: 'slow down' } } },
          ]),
          warn: message => warned.push(message),
        },
        request(),
      )

      expect(warned).toEqual(['compression call ended error: rate_limit slow down'])
    })

    it('echoes a thrown call so the quarantine is diagnosable, and rethrows', async () => {
      const warned: string[] = []
      const exploding = runtime(() => ({
        async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
          throw new Error('socket closed')
        },
      }))

      await expect(complete({ llm: exploding, warn: message => warned.push(message) }, request()))
        .rejects.toThrow('socket closed')
      expect(warned).toEqual(['compression call threw: socket closed'])
    })

    it('echoes a non-Error throw as text', async () => {
      const warned: string[] = []
      const exploding = runtime(() => ({
        async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
          throw 'a bare string'
        },
      }))

      await expect(complete({ llm: exploding, warn: message => warned.push(message) }, request())).rejects.toBe('a bare string')
      expect(warned).toEqual(['compression call threw: a bare string'])
    })

    it('taps the streamed text and always ends the tap, even on failure', async () => {
      const taps: Array<[string, boolean, TokenUsage | undefined]> = []
      await complete(
        {
          llm: runtime([
            { type: 'block-start', index: 0, blockType: 'text' },
            { type: 'text-delta', index: 0, text: 'half ' },
            { type: 'text-delta', index: 0, text: 'a memory' },
            { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
            { type: 'finish', reason: { kind: 'stop' } },
          ]),
          onText: (delta, done, usage) => taps.push([delta, done, usage]),
        },
        request(),
      )

      expect(taps).toEqual([
        ['half ', false, undefined],
        ['a memory', false, undefined],
        ['', true, { inputTokens: 10, outputTokens: 4 }],
      ])

      const failed: Array<[string, boolean]> = []
      await expect(complete(
        {
          llm: runtime(() => ({
            async *[Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
              throw new Error('gone')
            },
          })),
          onText: (delta, done) => failed.push([delta, done]),
        },
        request(),
      )).rejects.toThrow('gone')
      // The terminal tap is what bounds an attempt; a lost one would leave the
      // counter mid-call forever.
      expect(failed).toEqual([['', true]])
    })

    it('carries tool calls back in the library\'s vocabulary', async () => {
      const response = await complete(
        {
          llm: runtime([
            { type: 'block-start', index: 0, blockType: 'tool-call' },
            { type: 'tool-call-delta', index: 0, id: CallId('call-7'), name: 'recall', argumentsDelta: '{"id":"L1-0"}' },
            { type: 'finish', reason: { kind: 'tool-calls' } },
          ]),
        },
        request(),
      )

      expect(response.content[0]).toMatchObject<MembraneBlock>({ type: 'tool_use', id: 'call-7', name: 'recall', input: { id: 'L1-0' } })
    })

    it('keeps unparseable tool arguments from reaching the library as real input', async () => {
      const response = await complete(
        {
          llm: runtime([
            { type: 'block-start', index: 0, blockType: 'tool-call' },
            { type: 'tool-call-delta', index: 0, id: CallId('call-8'), name: 'recall', argumentsDelta: '{"id":' },
            { type: 'finish', reason: { kind: 'tool-calls' } },
          ]),
        },
        request(),
      )

      expect(response.content[0]).toMatchObject({ type: 'tool_use', input: {} })
    })

    it('drops thinking only when it would make the fold cost more than the span it replaces', async () => {
      const withThinking = (thinking: string): StreamChunk[] => [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: thinking },
        { type: 'block-end', index: 0, block: { type: 'reasoning', text: thinking } },
        { type: 'block-start', index: 1, blockType: 'text' },
        { type: 'text-delta', index: 1, text: 'a recollection worth keeping' },
        { type: 'block-end', index: 1, block: { type: 'text', text: 'a recollection worth keeping' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      const source = request({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }],
      })

      // Thinking priced under the span it replaces stays on the recollection.
      const kept = await complete({ llm: runtime(withThinking('short')) }, source)
      expect(kept.content.map(block => block.type)).toEqual(['thinking', 'text'])

      // Thinking over it would make the fold unaffordable forever; drop it.
      const dropped = await complete({ llm: runtime(withThinking('t'.repeat(600))) }, source)
      expect(dropped.content.map(block => block.type)).toEqual(['text'])
    })

    it('keeps thinking when the response has no text to price against', async () => {
      const response = await complete(
        {
          llm: runtime([
            { type: 'block-start', index: 0, blockType: 'reasoning' },
            { type: 'reasoning-delta', index: 0, text: 'thinking only' },
            { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking only' } },
            { type: 'finish', reason: { kind: 'stop' } },
          ]),
        },
        request(),
      )

      expect(response.content).toEqual([{ type: 'thinking', thinking: 'thinking only' }])
    })
  })
})
