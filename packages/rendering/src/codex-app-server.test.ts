import { describe, expect, it } from 'bun:test'
import { EMPTY_FINAL_ANSWER_TEXT } from './chat-sdk'
import {
  CodexAppServerRendererEventMapper,
  codexAppServerToChatSdkStream,
  codexAppServerToRendererEvents
} from './codex-app-server'

describe('CodexAppServerRendererEventMapper', () => {
  it('maps final answer deltas to generic renderer message deltas after activity exists', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    const commandEvents = mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test' }
    })
    expect(commandEvents).toContainEqual({
      type: 'renderer.task.update',
      task: {
        id: 'cmd-1',
        title: '1. Command execution',
        status: 'in_progress',
        details: [
          {
            type: 'code',
            language: 'sh',
            text: 'pnpm test'
          }
        ],
        output: undefined
      },
      flush: true
    })

    expect(
      mapper.process({
        type: 'item.started',
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' }
      })
    ).toEqual([])

    expect(
      mapper.process({
        type: 'item.agentMessage.delta',
        itemId: 'msg-1',
        delta: 'Done.'
      })
    ).toContainEqual({
      type: 'renderer.message.delta',
      delta: 'Done.',
      force: false,
      planPrefix: true
    })
  })

  it('separates successive agent messages with a paragraph break instead of gluing them', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'aws logs tail' }
    })

    const first = mapper.process({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agentMessage', text: 'Found the application group.' }
    })
    expect(first).toContainEqual({
      type: 'renderer.message.delta',
      delta: 'Found the application group.',
      force: false,
      planPrefix: true
    })

    const second = mapper.process({
      type: 'item.completed',
      item: { id: 'msg-2', type: 'agentMessage', text: 'No errors in the past hour.' }
    })
    expect(second).toContainEqual({
      type: 'renderer.message.delta',
      delta: '\n\nNo errors in the past hour.',
      force: false,
      planPrefix: true
    })
  })

  it('separates streamed final answer items without rewriting already-streamed text', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test' }
    })
    mapper.process({
      type: 'item.started',
      item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' }
    })
    mapper.process({ type: 'item.agentMessage.delta', itemId: 'msg-1', delta: 'First message.' })
    mapper.process({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer', text: 'First message.' }
    })
    mapper.process({
      type: 'item.started',
      item: { id: 'msg-2', type: 'agentMessage', phase: 'final_answer' }
    })

    const events = mapper.process({
      type: 'item.agentMessage.delta',
      itemId: 'msg-2',
      delta: 'Second message.'
    })
    expect(events).toContainEqual({
      type: 'renderer.message.delta',
      delta: '\n\nSecond message.',
      force: false,
      planPrefix: true
    })
  })

  it('does not double paragraph breaks when a message already ends with one', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test' }
    })
    mapper.process({
      type: 'item.completed',
      item: { id: 'msg-1', type: 'agentMessage', text: 'Heads up.\n\n' }
    })

    const events = mapper.process({
      type: 'item.completed',
      item: { id: 'msg-2', type: 'agentMessage', text: 'Details follow.' }
    })
    expect(events).toContainEqual({
      type: 'renderer.message.delta',
      delta: 'Details follow.',
      force: false,
      planPrefix: true
    })
  })

  it('suppresses commentary thinking blocks', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    expect(mapper.process({
      type: 'item.started',
      item: { id: 'thinking-1', type: 'agentMessage', phase: 'commentary' }
    })).toEqual([])
    expect(mapper.process({
      type: 'item.agentMessage.delta',
      itemId: 'thinking-1',
      delta: 'Checking the runtime.'
    })).toEqual([])

    const events = mapper.process({
      type: 'item.completed',
      item: {
        id: 'thinking-1',
        type: 'agentMessage',
        phase: 'commentary',
        text: 'Checking the runtime.'
      }
    })

    expect(events.some(event => event.type === 'renderer.message.delta')).toBe(false)
    expect(events.some(event => event.type === 'renderer.task.update')).toBe(false)

    const next = mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test' }
    })
    expect(next.find(event => event.type === 'renderer.task.update')).toMatchObject({
      task: { id: 'cmd-1', title: '1. Command execution', status: 'in_progress' }
    })
  })

  it('suppresses reasoning thinking blocks', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    const first = mapper.process({
      type: 'item.reasoning.textDelta',
      itemId: 'reasoning-1',
      delta: 'Inspecting the '
    })
    expect(first).toEqual([])

    const command = mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test' }
    })
    expect(command.find(event => event.type === 'renderer.task.update')).toMatchObject({
      task: { id: 'cmd-1', title: '1. Command execution', status: 'in_progress' }
    })

    const second = mapper.process({
      type: 'item.reasoning.textDelta',
      itemId: 'reasoning-1',
      delta: 'event stream'
    })
    expect(second.some(event => event.type === 'renderer.task.update')).toBe(false)

    const sealed = mapper.process({
      type: 'item.completed',
      item: { id: 'reasoning-1', type: 'reasoning', content: ['Inspecting the event stream'] }
    })
    expect(sealed.some(event => event.type === 'renderer.task.update')).toBe(false)
  })

  it('holds the last finished task in_progress so the Slack header never claims completion mid-turn', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'pnpm test' }
    })

    // The command finishes, leaving nothing else running. Slack would show
    // a completed-task header, so the completion is held back and the task
    // stays presented as in_progress.
    const completed = mapper.process({
      type: 'item.completed',
      item: {
        id: 'cmd-1',
        type: 'commandExecution',
        command: 'pnpm test',
        aggregatedOutput: 'tests passed',
        status: 'completed'
      }
    })
    const heldUpdate = completed.find(event => event.type === 'renderer.task.update')
    expect(heldUpdate).toMatchObject({
      task: { id: 'cmd-1', status: 'in_progress' }
    })

    // The next command releases the held completion in the same batch,
    // ordered before the new task's in_progress update.
    const next = mapper.process({
      type: 'item.started',
      item: { id: 'cmd-2', type: 'commandExecution', command: 'pnpm build' }
    })
    const updates = next.filter(event => event.type === 'renderer.task.update')
    const firstIndex = updates.findIndex(
      update => update.type === 'renderer.task.update' && update.task.id === 'cmd-1'
    )
    const secondIndex = updates.findIndex(
      update => update.type === 'renderer.task.update' && update.task.id === 'cmd-2'
    )
    expect(updates[firstIndex]).toMatchObject({ task: { id: 'cmd-1', status: 'complete' } })
    expect(updates[secondIndex]).toMatchObject({ task: { id: 'cmd-2', status: 'in_progress' } })
    expect(firstIndex).toBeLessThan(secondIndex)

    // The final flush reports true statuses for everything.
    const done = mapper.flush()
    const finalStatuses = done
      .filter(event => event.type === 'renderer.task.update')
      .map(event => (event.type === 'renderer.task.update' ? event.task : null))
    expect(finalStatuses).toContainEqual(
      expect.objectContaining({ id: 'cmd-2', status: 'complete' })
    )
  })

  it('suppresses Codex reasoning summary sections', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    expect(mapper.process({
      type: 'item.reasoning.summaryTextDelta',
      itemId: 'reasoning-1',
      summaryIndex: 0,
      delta: 'First section.'
    })).toEqual([])
    const events = mapper.process({
      type: 'item.reasoning.summaryTextDelta',
      itemId: 'reasoning-1',
      summaryIndex: 1,
      delta: 'Second section.'
    })
    expect(events).toEqual([])
  })

  it('parses Rust session output lines before mapping app-server notifications', () => {
    const mapper = new CodexAppServerRendererEventMapper()
    mapper.process({
      eventKind: 'session.output.line',
      data: JSON.stringify({
        type: 'item.started',
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' }
      })
    })
    const events = mapper.process({
      eventKind: 'session.output.line',
      data: JSON.stringify({
        type: 'turn.done',
        result: 'PONG'
      })
    })

    expect(events).toContainEqual({
      type: 'renderer.message.delta',
      delta: 'PONG',
      force: true,
      planPrefix: false
    })
    expect(events.at(-1)).toMatchObject({
      type: 'renderer.done',
      answerMarkdown: 'PONG'
    })
  })

  it('hydrates final answer text from Rust execution completion payloads', () => {
    const mapper = new CodexAppServerRendererEventMapper()
    mapper.process({
      eventKind: 'session.output.line',
      data: JSON.stringify({
        type: 'item.started',
        item: { id: 'cmd-1', type: 'commandExecution', command: 'true' }
      })
    })

    const events = mapper.process({
      eventKind: 'session.execution_completed',
      data: {
        execution_id: 'exe-1',
        result_text: 'TERMINAL_RESULT_OK'
      }
    })

    expect(events).toContainEqual({
      type: 'renderer.message.delta',
      delta: 'TERMINAL_RESULT_OK',
      force: true,
      planPrefix: true
    })
    expect(events.at(-1)).toMatchObject({
      type: 'renderer.done',
      answerMarkdown: 'TERMINAL_RESULT_OK'
    })
  })

  it('maps Rust activity summary events to renderer status updates', () => {
    const mapper = new CodexAppServerRendererEventMapper()
    const events = mapper.process({
      eventKind: 'session.activity_summary',
      data: {
        execution_id: 'exe-1',
        summary: 'The agent is inspecting App Server events.'
      }
    })

    expect(events).toEqual([
      {
        type: 'renderer.status',
        status: 'The agent is inspecting App Server events.'
      }
    ])
  })

  it('maps app-server agent message deltas keyed by turnId', () => {
    const mapper = new CodexAppServerRendererEventMapper()
    const events = mapper.process({
      eventKind: 'session.output.line',
      data: JSON.stringify({
        type: 'item.agentMessage.delta',
        turnId: 'turn-1',
        delta: 'PONG 1'
      })
    })

    expect(mapper.flush()).toContainEqual({
      type: 'renderer.message.delta',
      delta: 'PONG 1',
      force: true,
      planPrefix: false
    })
    expect(events).toEqual([])
  })

  it('accepts already-parsed Rust session output payloads from API clients', () => {
    const mapper = new CodexAppServerRendererEventMapper()
    mapper.process({
      eventKind: 'session.output.line',
      data: {
        type: 'item.started',
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' }
      }
    })

    const events = mapper.process({
      eventKind: 'session.output.line',
      data: {
        type: 'turn.done',
        result: 'PONG'
      }
    })

    expect(events).toContainEqual({
      type: 'renderer.message.delta',
      delta: 'PONG',
      force: true,
      planPrefix: false
    })
  })

  it('maps thread name updates without making them Slack-specific', () => {
    const mapper = new CodexAppServerRendererEventMapper()

    expect(
      mapper.process({
        type: 'thread/name/updated',
        name: 'Investigate staging deploy'
      })
    ).toEqual([{ type: 'renderer.title.update', title: 'Investigate staging deploy' }])
  })

  it('accepts App Server slash-method notifications from Slackbotv2 streams', async () => {
    const titles: string[] = []
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            method: 'thread/name/updated',
            params: { threadId: 'thread-1', threadName: 'Investigate staging deploy' }
          },
          {
            method: 'turn/plan/updated',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              explanation: 'Implementation plan',
              plan: [{ step: 'Inspect App Server events', status: 'completed' }]
            }
          },
          {
            method: 'item/reasoning/summaryTextDelta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'reasoning-1',
              summaryIndex: 0,
              delta: 'Inspecting the event stream'
            }
          },
          {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'answer-1',
              delta: 'Done.'
            }
          },
          {
            method: 'turn/completed',
            params: {
              threadId: 'thread-1',
              turn: { id: 'turn-1', items: [], status: 'completed' }
            }
          }
        ]),
        {
          onRendererEvent(event) {
            if (event.type === 'renderer.title.update') titles.push(event.title)
          }
        }
      )
    )

    expect(titles).toEqual(['Investigate staging deploy'])
    expect(chunks).toContainEqual({ type: 'plan_update', title: 'Implementation plan' })
    expect(chunks).toContainEqual({
      type: 'task_update',
      id: 'plan-1',
      title: 'Inspect App Server events',
      status: 'complete'
    })
    expect(chunks.some(chunk => chunk.type === 'task_update' && chunk.title === 'Thinking')).toBe(
      false
    )
    expect(chunks).toContainEqual({ type: 'markdown_text', text: 'Done.' })
  })

  it('suppresses repeated reasoning deltas from Chat SDK output', async () => {
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            method: 'item/reasoning/summaryTextDelta',
            params: {
              itemId: 'reasoning-1',
              delta: 'Inspecting '
            }
          },
          {
            method: 'item/reasoning/summaryTextDelta',
            params: {
              itemId: 'reasoning-1',
              delta: 'the event stream'
            }
          },
          {
            method: 'turn/completed',
            params: {
              turn: { id: 'turn-1', items: [], status: 'completed' }
            }
          }
        ])
      )
    )

    expect(chunks.some(chunk => chunk.type === 'task_update' && chunk.title === 'Thinking')).toBe(
      false
    )
  })

  it('streams command details once and command output incrementally', async () => {
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            method: 'item/started',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'echo one && echo two',
                status: 'inProgress'
              }
            }
          },
          {
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              delta: 'one\n'
            }
          },
          {
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              delta: 'two\n'
            }
          },
          {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'echo one && echo two',
                status: 'completed',
                aggregatedOutput: 'one\ntwo\n',
                exitCode: 0
              }
            }
          }
        ]),
        { taskOutput: 'full' }
      )
    )

    const taskChunks = chunks.filter(
      (chunk): chunk is Extract<(typeof chunks)[number], { type: 'task_update' }> =>
        chunk.type === 'task_update' && chunk.id === 'cmd-1'
    )
    expect(taskChunks.filter(chunk => chunk.details).map(chunk => chunk.details)).toEqual([
      '```sh\necho one && echo two\n```'
    ])
    expect(taskChunks.filter(chunk => chunk.output).map(chunk => chunk.output)).toEqual([
      'one\n',
      'two\n'
    ])
    expect(taskChunks.at(-1)).toMatchObject({
      id: 'cmd-1',
      status: 'complete'
    })
  })

  it('omits command output before task updates by default', async () => {
    const largeOutput = 'large-context-line\n'.repeat(1_000)
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            method: 'item/started',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'gh run view --log',
                status: 'inProgress'
              }
            }
          },
          {
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              delta: largeOutput.slice(0, 5_000)
            }
          },
          {
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              delta: largeOutput.slice(5_000)
            }
          },
          {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'gh run view --log',
                status: 'completed',
                aggregatedOutput: largeOutput,
                exitCode: 0
              }
            }
          }
        ])
      )
    )

    const taskChunks = chunks.filter(
      (chunk): chunk is Extract<(typeof chunks)[number], { type: 'task_update' }> =>
        chunk.type === 'task_update' && chunk.id === 'cmd-1'
    )
    expect(taskChunks.map(chunk => chunk.output).filter(Boolean)).toEqual([])
    expect(taskChunks.some(chunk => chunk.details?.includes('gh run view --log'))).toBe(true)
    expect(taskChunks.at(-1)).toMatchObject({
      id: 'cmd-1',
      status: 'complete'
    })
    expect(JSON.stringify(taskChunks)).not.toContain('large-context-line')
  })

  it('preserves full command output in task updates', async () => {
    const longSuffix = 'x'.repeat(13_000)
    const aggregatedOutput = `one\ntwo\nthree\nfour\nfive\n${longSuffix}`
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'cat long-output.log',
                status: 'completed',
                aggregatedOutput,
                exitCode: 0
              }
            }
          }
        ]),
        { taskOutput: 'full' }
      )
    )

    const taskChunk = chunks.find(
      (chunk): chunk is Extract<(typeof chunks)[number], { type: 'task_update' }> =>
        chunk.type === 'task_update' && chunk.id === 'cmd-1'
    )
    expect(taskChunk?.output).toContain(aggregatedOutput)
    expect(taskChunk?.output).not.toContain('// truncated')
    expect(taskChunk?.output).not.toContain('/* truncated */')
    expect(taskChunk?.output).not.toContain('[output truncated]')
    expect(taskChunk?.output).not.toContain('[truncated')
  })

  it('preserves full file change diffs in task updates', async () => {
    const longLine = `+${'diff-line'.repeat(400)}`
    const diff = ['diff --git a/file.txt b/file.txt', '@@ -1 +1 @@', '-old', longLine].join('\n')
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'file-1',
                type: 'fileChange',
                status: 'completed',
                changes: [{ path: 'file.txt', diff }]
              }
            }
          }
        ]),
        { taskOutput: 'full' }
      )
    )

    const taskChunk = chunks.find(
      (chunk): chunk is Extract<(typeof chunks)[number], { type: 'task_update' }> =>
        chunk.type === 'task_update' && chunk.id === 'file-1'
    )
    expect(taskChunk?.output).toContain(diff)
    expect(taskChunk?.output).not.toContain('// truncated')
    expect(taskChunk?.output).not.toContain('/* truncated */')
    expect(taskChunk?.output).not.toContain('[output truncated]')
    expect(taskChunk?.output).not.toContain('[truncated')
  })

  it('omits binary command output from task updates', async () => {
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'head -40 $(which centaur-tools)',
                status: 'completed',
                aggregatedOutput: `ELF\u0000\u0001\u0002\u0003${'\u0004'.repeat(16)}`,
                exitCode: 0
              }
            }
          }
        ]),
        { taskOutput: 'full' }
      )
    )

    const taskChunk = chunks.find(
      (chunk): chunk is Extract<(typeof chunks)[number], { type: 'task_update' }> =>
        chunk.type === 'task_update' && chunk.id === 'cmd-1'
    )
    expect(taskChunk?.output).toContain('[binary output omitted;')
    expect(taskChunk?.output).not.toContain('\u0000')
  })

  it('suppresses the live delta instead of interleaving when the recomposed answer diverges from streamed text', () => {
    // Two concurrent final-answer items compose as A + B. Growing A (a
    // non-trailing component) after B was already streamed shifts B's bytes, so
    // a byte-offset slice would re-read and re-emit B, duplicating it
    // ("Hello world." -> "Hello world.world."). The guard refuses the
    // non-continuation and freezes at the clean prefix instead, and records the
    // divergence once for the metric.
    const logs: string[] = []
    const mapper = new CodexAppServerRendererEventMapper({
      logInfo: event => logs.push(event)
    })

    const deltas: string[] = []
    const run = (event: unknown) => {
      for (const out of mapper.process(event)) {
        if (out.type === 'renderer.message.delta') deltas.push(out.delta)
      }
    }

    // A task makes the plan visible so answer deltas stream immediately.
    run({ type: 'item.started', item: { id: 'cmd-1', type: 'commandExecution', command: 'true' } })
    run({ type: 'item.started', item: { id: 'A', type: 'agentMessage', phase: 'final_answer' } })
    run({ type: 'item.started', item: { id: 'B', type: 'agentMessage', phase: 'final_answer' } })
    run({ type: 'item.agentMessage.delta', itemId: 'A', delta: 'Hello ' })
    run({ type: 'item.agentMessage.delta', itemId: 'B', delta: 'world.' })
    // A grows after B was already streamed: a byte-offset slice would duplicate
    // "world." here. The guard suppresses the non-continuation instead.
    run({ type: 'item.agentMessage.delta', itemId: 'A', delta: 'there ' })

    const streamed = deltas.join('')
    expect(streamed).toBe('Hello \n\nworld.')
    expect(streamed).not.toContain('world.world.')
    expect(logs).toContain('codex_renderer_stream_divergence_suppressed')
    // The signal is recorded once per render, not on every subsequent event.
    expect(logs.filter(event => event === 'codex_renderer_stream_divergence_suppressed')).toHaveLength(
      1
    )
  })

  it('marks open tasks as errors on Rust session failures and emits done', () => {
    const mapper = new CodexAppServerRendererEventMapper()
    mapper.process({
      type: 'item.started',
      item: { id: 'cmd-1', type: 'commandExecution', command: 'kubectl get pods' }
    })

    const events = mapper.process({
      eventKind: 'session.execution_failed',
      data: { error: 'sandbox exited' }
    })

    expect(events).toContainEqual({
      type: 'renderer.task.update',
      task: {
        id: 'cmd-1',
        title: '1. Command execution',
        status: 'error',
        details: undefined,
        output: undefined
      },
      flush: true
    })
    expect(events.at(-1)).toMatchObject({
      type: 'renderer.done',
      error: 'sandbox exited'
    })
  })

  it('emits interrupted final text for cancelled Rust sessions', async () => {
    const chunks = await collect(
      codexAppServerToChatSdkStream(
        toAsyncIterable([
          {
            type: 'item.started',
            item: { id: 'cmd-1', type: 'commandExecution', command: 'sleep 60' }
          },
          {
            eventKind: 'session.execution_cancelled',
            data: { error: 'Execution interrupted' }
          }
        ])
      )
    )

    expect(chunks.filter(chunk => chunk.type === 'markdown_text')).toEqual([
      {
        type: 'markdown_text',
        text: 'Execution interrupted'
      }
    ])
  })
})

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

async function* toAsyncIterable<T>(source: Iterable<T>): AsyncIterable<T> {
  for (const item of source) yield item
}

// Production shapes captured from the bot deployment on 2026-08-25 after
// gpu-router#463 (codex tags text emitted alongside tool calls `commentary`
// and the turn's answer `final_answer`; the de-streaming shim puts the phase on
// item/started). Events are in the app-server JSON-RPC form api-rs stores; the
// two fixtures are complete captured turns.
import bot1 from './fixtures/bot-codex-preamble-tool-answer-1.json'
import bot2 from './fixtures/bot-codex-preamble-tool-answer-2.json'

const TASK = { commentaryDisplay: 'task' as const, preStreamGraceMs: 0 }
const PREAMBLE = "I'm going to list the root directory entries with `ls /`, then count them."
const ANSWER = '`ls /` printed 32 entries.'

function agentMessage(id: string, phase: string | null, text: string) {
  return [
    { method: 'item/started', params: { item: { id, type: 'agentMessage', phase, text: '' } } },
    { method: 'item/agentMessage/delta', params: { itemId: id, delta: text } },
    { method: 'item/completed', params: { item: { id, type: 'agentMessage', phase, text } } }
  ]
}
function command(id: string) {
  return [
    { method: 'item/started', params: { item: { id, type: 'commandExecution', command: "/bin/bash -lc 'ls /'", status: 'inProgress' } } },
    {
      method: 'item/completed',
      params: { item: { id, type: 'commandExecution', command: "/bin/bash -lc 'ls /'", aggregatedOutput: 'bin\nboot\n', exitCode: 0, status: 'completed' } }
    }
  ]
}
const TURN_COMPLETED = { method: 'turn/completed', params: { turn: { id: 't1', status: 'completed', error: null } } }
const POST_463_TURN = [
  ...agentMessage('msg_1', 'commentary', PREAMBLE),
  ...command('call_1'),
  ...agentMessage('msg_2', 'final_answer', ANSWER),
  TURN_COMPLETED
]
const PRE_463_TURN = [
  ...agentMessage('msg_1', 'final_answer', PREAMBLE),
  ...command('call_1'),
  ...agentMessage('msg_2', 'final_answer', ANSWER),
  TURN_COMPLETED
]

type Chunk = Record<string, unknown> & { type: string; text?: string; id?: string }
async function chunksOf(events: unknown[], options: Record<string, unknown>): Promise<Chunk[]> {
  return (await collect(codexAppServerToChatSdkStream(toAsyncIterable(events), options))) as Chunk[]
}
function markdownOf(chunks: Chunk[]): string {
  return chunks.filter(c => c.type === 'markdown_text').map(c => c.text ?? '').join('')
}
function thinkingOf(chunks: Chunk[]): Chunk[] {
  return chunks.filter(c => c.type === 'task_update' && String(c.id).startsWith('commentary-'))
}
// What a card ends up showing: Slack appends each update's details.
function detailsOf(updates: Chunk[]): string {
  return updates.map(c => (typeof c.details === 'string' ? c.details : '')).join('')
}
function taskOrder(chunks: Chunk[]): string[] {
  const seen: string[] = []
  for (const c of chunks) if (c.type === 'task_update' && !seen.includes(String(c.id))) seen.push(String(c.id))
  return seen
}

describe('commentaryDisplay: task', () => {
  it('shows a phased preamble as a live Thinking card and only the final answer as text', async () => {
    const chunks = await chunksOf(POST_463_TURN, TASK)
    // Details accumulate on a card across updates, so the text is sent once
    // and the completion carries only the status.
    expect(thinkingOf(chunks)).toEqual([
      { type: 'task_update', id: 'commentary-msg_1', title: 'Thinking', status: 'in_progress', details: PREAMBLE },
      { type: 'task_update', id: 'commentary-msg_1', title: 'Thinking', status: 'complete' }
    ])
    expect(markdownOf(chunks)).toBe(ANSWER)
  })

  it('replays the captured production turns: preamble in Thinking, answer in markdown, nothing in both', async () => {
    for (const fixture of [bot1, bot2]) {
      const chunks = await chunksOf(fixture as unknown[], TASK)
      const completed = (fixture as Array<{ method: string; params: { item?: { type?: string; phase?: string; text?: string } } }>)
        .filter(e => e.method === 'item/completed' && e.params.item?.type === 'agentMessage')
        .map(e => e.params.item!)
      const preamble = completed.find(i => i.phase === 'commentary')!.text!
      const answer = completed.find(i => i.phase === 'final_answer')!.text!
      const thinking = thinkingOf(chunks)
      expect(thinking.at(-1)).toMatchObject({ title: 'Thinking', status: 'complete' })
      expect(detailsOf(thinking)).toBe(preamble)
      expect(markdownOf(chunks)).toBe(answer)
      expect(markdownOf(chunks)).not.toContain(preamble)
    }
  })

  it('keeps each preamble as its own card, in order between the tool cards it preceded', async () => {
    const chunks = await chunksOf(
      [
        ...agentMessage('msg_1', 'commentary', 'Checking the logs.'),
        ...command('call_1'),
        ...agentMessage('msg_2', 'commentary', 'Logs show a 502; checking the router.'),
        ...command('call_2'),
        ...agentMessage('msg_3', 'final_answer', 'Root cause: router restarted.'),
        TURN_COMPLETED
      ],
      TASK
    )
    expect(taskOrder(chunks)).toEqual(['commentary-msg_1', 'call_1', 'commentary-msg_2', 'call_2'])
    expect(detailsOf(thinkingOf(chunks).filter(c => c.id === 'commentary-msg_1'))).toBe('Checking the logs.')
    expect(detailsOf(thinkingOf(chunks).filter(c => c.id === 'commentary-msg_2'))).toBe('Logs show a 502; checking the router.')
    expect(thinkingOf(chunks).filter(c => c.status === 'complete').map(c => c.id)).toEqual(['commentary-msg_1', 'commentary-msg_2'])
    expect(markdownOf(chunks)).toBe('Root cause: router restarted.')
  })

  it('is a no-op for turns the harness phases entirely final_answer', async () => {
    const withTask = await chunksOf(PRE_463_TURN, TASK)
    const upstream = await chunksOf(PRE_463_TURN, { preStreamGraceMs: 0 })
    expect(thinkingOf(withTask)).toEqual([])
    expect(withTask).toEqual(upstream)
    expect(markdownOf(withTask)).toBe(`${PREAMBLE}\n\n${ANSWER}`)
  })

  it('renders an unphased, tool-less reply (Pi/Hermes shape) exactly as before', async () => {
    const events = [...agentMessage('pi-msg-1-1', null, 'Four.'), TURN_COMPLETED]
    const withTask = await chunksOf(events, TASK)
    expect(thinkingOf(withTask)).toEqual([])
    expect(markdownOf(withTask)).toBe('Four.')
    expect(withTask).toEqual(await chunksOf(events, { preStreamGraceMs: 0 }))
  })

  it('leaves the default (hidden) behaviour unchanged', async () => {
    const chunks = await chunksOf(POST_463_TURN, { preStreamGraceMs: 0 })
    expect(thinkingOf(chunks)).toEqual([])
    expect(markdownOf(chunks)).toBe(ANSWER)
  })

  it('promotes the last commentary item to the answer when the turn never phases a final answer', async () => {
    const chunks = await chunksOf(
      [
        ...agentMessage('msg_1', 'commentary', PREAMBLE),
        ...command('call_1'),
        ...agentMessage('msg_2', 'commentary', 'Done — fixed foo.ts.'),
        ...command('call_2'),
        TURN_COMPLETED
      ],
      TASK
    )
    expect(markdownOf(chunks)).toBe('Done — fixed foo.ts.')
    expect(markdownOf(chunks)).not.toContain(EMPTY_FINAL_ANSWER_TEXT)
    // The promoted item's card had already completed with its text; that
    // duplicate inside a collapsed card is the accepted trade-off.
    expect(detailsOf(thinkingOf(chunks).filter(c => c.id === 'commentary-msg_1'))).toBe(PREAMBLE)
    expect(detailsOf(thinkingOf(chunks).filter(c => c.id === 'commentary-msg_2'))).toBe('Done — fixed foo.ts.')
    expect(thinkingOf(chunks).filter(c => c.status === 'complete').map(c => c.id)).toEqual([
      'commentary-msg_1',
      'commentary-msg_2'
    ])
  })

  it('keeps text in the answer when its commentary phase arrives only on item.completed', async () => {
    const logged: string[] = []
    const chunks = await chunksOf(
      [
        { method: 'item/started', params: { item: { id: 'msg_1', type: 'agentMessage', phase: null, text: '' } } },
        { method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: PREAMBLE } },
        { method: 'item/completed', params: { item: { id: 'msg_1', type: 'agentMessage', phase: 'commentary', text: PREAMBLE } } },
        ...command('call_1'),
        ...agentMessage('msg_2', 'final_answer', ANSWER),
        TURN_COMPLETED
      ],
      { ...TASK, logInfo: (event: string) => logged.push(event) }
    )
    expect(markdownOf(chunks)).toBe(`${PREAMBLE}\n\n${ANSWER}`)
    expect(thinkingOf(chunks)).toEqual([])
    expect(logged).toContain('codex_renderer_late_commentary_phase')
  })

  it('sends a card its text exactly once even when it streams in several deltas', async () => {
    const chunks = await chunksOf(
      [
        { method: 'item/started', params: { item: { id: 'msg_1', type: 'agentMessage', phase: 'commentary', text: '' } } },
        { method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'Let me ' } },
        { method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'check the ' } },
        { method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'logs.' } },
        { method: 'item/completed', params: { item: { id: 'msg_1', type: 'agentMessage', phase: 'commentary', text: 'Let me check the logs.' } } },
        ...command('call_1'),
        ...agentMessage('msg_2', 'final_answer', ANSWER),
        TURN_COMPLETED
      ],
      TASK
    )
    const card = thinkingOf(chunks)
    expect(card.map(c => c.details)).toEqual(['Let me ', 'check the ', 'logs.', undefined])
    expect(card.map(c => c.status)).toEqual(['in_progress', 'in_progress', 'in_progress', 'complete'])
    expect(detailsOf(card)).toBe('Let me check the logs.')
  })

  it('sends nothing more when item.completed does not extend the streamed text', async () => {
    // Deltas built "…logs. " (trailing space); the canonical text drops it. It
    // cannot be retracted from the card, so the completion sends no details.
    const chunks = await chunksOf(
      [
        { method: 'item/started', params: { item: { id: 'msg_1', type: 'agentMessage', phase: 'commentary', text: '' } } },
        { method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'Let me check ' } },
        { method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'the logs. ' } },
        { method: 'item/completed', params: { item: { id: 'msg_1', type: 'agentMessage', phase: 'commentary', text: 'Let me check the logs.' } } },
        ...command('call_1'),
        ...agentMessage('msg_2', 'final_answer', ANSWER),
        TURN_COMPLETED
      ],
      TASK
    )
    const card = thinkingOf(chunks)
    expect(card.map(c => c.details)).toEqual(['Let me check ', 'the logs. ', undefined])
    expect(card.at(-1)!.status).toBe('complete')
    expect(detailsOf(card)).toBe('Let me check the logs. ')
  })

  it('holds a finished card in progress until the next card starts, then completes it', () => {
    // Slack titles the card block after the last completed task when nothing
    // is in progress, so completing a preamble card the moment its item ends
    // would show "Thinking completed" mid-turn. The completion is emitted by
    // the step that starts the next card (here the tool), not at turn end.
    const mapper = new CodexAppServerRendererEventMapper(TASK)
    const cardsFrom = (events: unknown[]) =>
      events.flatMap(e => mapper.process(e)).flatMap(e =>
        e.type === 'renderer.task.update' && e.task.id.startsWith('commentary-') ? [`${e.task.id}=${e.task.status}`] : []
      )
    const [started, delta, completed] = agentMessage('msg_1', 'commentary', PREAMBLE)
    expect(cardsFrom([started])).toEqual([])
    expect(cardsFrom([delta])).toEqual(['commentary-msg_1=in_progress'])
    expect(cardsFrom([completed])).toEqual([])
    const [toolStarted, toolCompleted] = command('call_1')
    expect(cardsFrom([toolStarted])).toEqual(['commentary-msg_1=complete'])
    expect(cardsFrom([toolCompleted])).toEqual([])
    // A second preamble releases the first the same way, and the last one is
    // released by the turn end.
    const [s2, d2, c2] = agentMessage('msg_2', 'commentary', 'Digging further.')
    expect(cardsFrom([s2, d2, c2])).toEqual(['commentary-msg_2=in_progress'])
    expect(cardsFrom(agentMessage('msg_3', 'final_answer', ANSWER))).toEqual([])
    expect(cardsFrom([TURN_COMPLETED])).toEqual(['commentary-msg_2=complete'])
  })

  it('errors only the card still open when the execution fails', () => {
    const mapper = new CodexAppServerRendererEventMapper(TASK)
    for (const e of [...agentMessage('msg_1', 'commentary', 'Checking.'), ...command('call_1'), ...agentMessage('msg_2', 'commentary', 'Digging.'), ...command('call_2')]) mapper.process(e)
    // Two preambles finished and were released by the tool cards after them:
    // a failure now touches neither.
    const afterCompleted = mapper.process({ eventKind: 'session.execution_failed', data: { error: 'boom' } })
    expect(afterCompleted.filter(e => e.type === 'renderer.task.update' && e.task.id.startsWith('commentary-'))).toEqual([])

    // A finished preamble still held (no card after it yet) completes on
    // failure rather than erroring.
    const held = new CodexAppServerRendererEventMapper(TASK)
    for (const e of agentMessage('msg_1', 'commentary', 'Checking.')) held.process(e)
    const heldOut = held.process({ eventKind: 'session.execution_failed', data: { error: 'boom' } })
    expect(heldOut.flatMap(e => (e.type === 'renderer.task.update' && e.task.id.startsWith('commentary-') ? [`${e.task.id}=${e.task.status}`] : []))).toEqual(['commentary-msg_1=complete'])

    const inFlight = new CodexAppServerRendererEventMapper(TASK)
    for (const e of [...agentMessage('msg_1', 'commentary', 'Checking.'), ...command('call_1')]) inFlight.process(e)
    inFlight.process({ method: 'item/started', params: { item: { id: 'msg_2', type: 'agentMessage', phase: 'commentary', text: '' } } })
    inFlight.process({ method: 'item/agentMessage/delta', params: { itemId: 'msg_2', delta: 'Digg' } })
    const out = inFlight.process({ eventKind: 'session.execution_failed', data: { error: 'boom' } })
    const cards = out.flatMap(e => (e.type === 'renderer.task.update' && e.task.id.startsWith('commentary-') ? [`${e.task.id}=${e.task.status}`] : []))
    expect(cards).toEqual(['commentary-msg_2=error'])
  })

  it('closes an open Thinking card as error when the execution fails', () => {
    const mapper = new CodexAppServerRendererEventMapper(TASK)
    mapper.process({ method: 'item/started', params: { item: { id: 'msg_1', type: 'agentMessage', phase: 'commentary', text: '' } } })
    mapper.process({ method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'Checking' } })
    const out = mapper.process({ eventKind: 'session.execution_failed', data: { error: 'boom' } })
    const cards = out.filter(e => e.type === 'renderer.task.update' && e.task.id === 'commentary-msg_1')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.type === 'renderer.task.update' && cards[0]!.task.status).toBe('error')
  })
})

describe('codexAppServerToRendererEvents', () => {
  it('flushes buffered answer text and emits renderer.done when the source ends without a terminal event', () => {
    const events = codexAppServerToRendererEvents([
      {
        type: 'item.started',
        item: { id: 'msg-1', type: 'agentMessage', phase: 'final_answer' }
      },
      {
        type: 'item.agentMessage.delta',
        itemId: 'msg-1',
        delta: 'Final answer text.'
      }
    ])

    const done = events.find(event => event.type === 'renderer.done')
    expect(done).toMatchObject({
      type: 'renderer.done',
      answerMarkdown: 'Final answer text.'
    })
  })
})
