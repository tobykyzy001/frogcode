import { describe, it, expect } from 'vitest'
import { ExecutionContext } from '../src/execution-context.js'
import { createAgentConfig } from '../src/types/config.js'
import type { AgentState } from '../src/types/agent.js'

const STATE: AgentState = 'idle'

function makeConfig(name = 'test-agent') {
  return createAgentConfig({ name })
}

describe('ExecutionContext', () => {
  it('creates context with required fields (agentId, config, state)', () => {
    const config = makeConfig()
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config,
      state: STATE,
    })

    expect(ctx.agentId).toBe('agent-1')
    expect(ctx.config).toBe(config)
    expect(ctx.state).toBe(STATE)
  })

  it('creates context with initial metadata', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
      metadata: { foo: 'bar', count: 42 },
    })

    expect(ctx.metadata).toEqual({ foo: 'bar', count: 42 })
    expect(ctx.get('foo')).toBe('bar')
    expect(ctx.get('count')).toBe(42)
  })

  it('defaults metadata to empty object when not provided', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
    })

    expect(ctx.metadata).toEqual({})
  })

  it('set() stores values retrievable via get()', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
    })

    ctx.set('greeting', 'hello')
    ctx.set('count', 7)
    ctx.set('flag', true)

    expect(ctx.get('greeting')).toBe('hello')
    expect(ctx.get('count')).toBe(7)
    expect(ctx.get<boolean>('flag')).toBe(true)
  })

  it('set() overwrites existing values', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
      metadata: { key: 'old' },
    })

    ctx.set('key', 'new')
    expect(ctx.get('key')).toBe('new')
  })

  it('has() returns true for existing keys and false for missing', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
      metadata: { exists: 1 },
    })

    expect(ctx.has('exists')).toBe(true)
    expect(ctx.has('missing')).toBe(false)
  })

  it('has() returns true even when value is undefined', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
      metadata: { nullable: undefined },
    })

    expect(ctx.has('nullable')).toBe(true)
    expect(ctx.get('nullable')).toBeUndefined()
  })

  it('get() returns undefined for missing keys', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
    })

    expect(ctx.get('nope')).toBeUndefined()
  })

  it('createChild inherits parent config and state', () => {
    const config = makeConfig('parent')
    const parent = new ExecutionContext({
      agentId: 'parent',
      config,
      state: 'running',
    })

    const child = parent.createChild('child')

    expect(child.agentId).toBe('child')
    expect(child.config).toBe(parent.config)
    expect(child.state).toBe(parent.state)
    expect(child.parent).toBe(parent)
  })

  it('createChild inherits parent metadata as a copy (not shared)', () => {
    const parent = new ExecutionContext({
      agentId: 'parent',
      config: makeConfig(),
      state: STATE,
      metadata: { shared: 'value', count: 1 },
    })

    const child = parent.createChild('child')

    expect(child.metadata).toEqual({ shared: 'value', count: 1 })
    expect(child.metadata).not.toBe(parent.metadata)
  })

  it('child metadata mutation does not affect parent', () => {
    const parent = new ExecutionContext({
      agentId: 'parent',
      config: makeConfig(),
      state: STATE,
      metadata: { key: 'original' },
    })

    const child = parent.createChild('child')
    child.set('key', 'mutated')
    child.set('newKey', 'added')

    expect(parent.get('key')).toBe('original')
    expect(parent.has('newKey')).toBe(false)
    expect(child.get('key')).toBe('mutated')
    expect(child.get('newKey')).toBe('added')
  })

  it('createChild with partial config override replaces specified fields', () => {
    const parent = new ExecutionContext({
      agentId: 'parent',
      config: createAgentConfig({
        name: 'parent',
        maxSteps: 10,
        stepTimeoutMs: 30000,
      }),
      state: STATE,
    })

    const child = parent.createChild('child', {
      maxSteps: 5,
      stepTimeoutMs: 60000,
    })

    expect(child.agentId).toBe('child')
    expect(child.config.maxSteps).toBe(5)
    expect(child.config.stepTimeoutMs).toBe(60000)
    expect(child.config.name).toBe('parent')
    expect(child.config.maxRetries).toBe(parent.config.maxRetries)
  })

  it('createChild with no config arg inherits parent config object', () => {
    const config = makeConfig('parent')
    const parent = new ExecutionContext({
      agentId: 'parent',
      config,
      state: STATE,
    })

    const child = parent.createChild('child')

    expect(child.config).toBe(config)
  })

  it('toJSON serializes all relevant fields', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig('my-agent'),
      state: 'running',
      metadata: { foo: 'bar' },
    })

    const json = ctx.toJSON()
    const parsed = JSON.parse(json) as Record<string, unknown>

    expect(parsed.agentId).toBe('agent-1')
    expect(parsed.config).toEqual(ctx.config)
    expect(parsed.state).toBe('running')
    expect(parsed.metadata).toEqual({ foo: 'bar' })
    expect(typeof parsed.createdAt).toBe('number')
    expect(parsed.parentAgentId).toBeUndefined()
  })

  it('toJSON includes parentAgentId when parent exists', () => {
    const parent = new ExecutionContext({
      agentId: 'parent-id',
      config: makeConfig(),
      state: STATE,
    })

    const child = parent.createChild('child-id')
    const parsed = JSON.parse(child.toJSON()) as Record<string, unknown>

    expect(parsed.agentId).toBe('child-id')
    expect(parsed.parentAgentId).toBe('parent-id')
  })

  it('createdAt is set at construction time', () => {
    const before = Date.now()
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
    })
    const after = Date.now()

    expect(ctx.createdAt).toBeGreaterThanOrEqual(before)
    expect(ctx.createdAt).toBeLessThanOrEqual(after)
  })

  it('parent is undefined when not provided', () => {
    const ctx = new ExecutionContext({
      agentId: 'agent-1',
      config: makeConfig(),
      state: STATE,
    })

    expect(ctx.parent).toBeUndefined()
  })
})
