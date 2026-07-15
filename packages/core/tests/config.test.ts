import { describe, it, expect } from 'vitest'
import { createAgentConfig, DEFAULT_AGENT_CONFIG } from '../src/types/config.js'

describe('AgentConfig', () => {
  it('should have correct default values', () => {
    expect(DEFAULT_AGENT_CONFIG.maxSteps).toBe(10)
    expect(DEFAULT_AGENT_CONFIG.stepTimeoutMs).toBe(30000)
    expect(DEFAULT_AGENT_CONFIG.maxRetries).toBe(3)
    expect(DEFAULT_AGENT_CONFIG.metadata).toEqual({})
  })

  it('should create config with name and defaults', () => {
    const config = createAgentConfig({ name: 'test' })
    expect(config.name).toBe('test')
    expect(config.maxSteps).toBe(10)
    expect(config.stepTimeoutMs).toBe(30000)
    expect(config.maxRetries).toBe(3)
    expect(config.metadata).toEqual({})
  })

  it('should override specific fields while keeping defaults', () => {
    const config = createAgentConfig({ name: 'agent1', maxSteps: 5 })
    expect(config.name).toBe('agent1')
    expect(config.maxSteps).toBe(5)
    expect(config.stepTimeoutMs).toBe(30000)
    expect(config.maxRetries).toBe(3)
  })

  it('should override multiple fields', () => {
    const config = createAgentConfig({
      name: 'custom',
      maxSteps: 20,
      stepTimeoutMs: 60000,
      metadata: { version: 1 },
    })
    expect(config.maxSteps).toBe(20)
    expect(config.stepTimeoutMs).toBe(60000)
    expect(config.metadata).toEqual({ version: 1 })
  })

  describe('maxRetries validation', () => {
    it('accepts zero', () => {
      expect(() => createAgentConfig({ name: 'test', maxRetries: 0 })).not.toThrow()
    })

    it('accepts positive integers', () => {
      expect(() => createAgentConfig({ name: 'test', maxRetries: 5 })).not.toThrow()
    })

    it('rejects negative values', () => {
      expect(() => createAgentConfig({ name: 'test', maxRetries: -1 })).toThrow(
        'Invalid maxRetries: -1. Must be a non-negative integer.',
      )
    })

    it('rejects non-integer values', () => {
      expect(() => createAgentConfig({ name: 'test', maxRetries: 1.5 })).toThrow(
        'Invalid maxRetries: 1.5. Must be a non-negative integer.',
      )
    })
  })
})
