import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createQueue } from '../../factory'
import type { JobContext, QueuedJob } from '../../types'
import { createRoutedHandler } from '../runner'

jest.mock('@open-mercato/shared/lib/logger', () => {
  const mocked = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  }
  mocked.child.mockImplementation(() => mocked)
  return { createLogger: jest.fn(() => mocked) }
})

type RoutedPayload = { type: string }

function buildJob(type: string): QueuedJob<RoutedPayload> {
  return { id: 'job-1', payload: { type }, createdAt: new Date().toISOString() }
}

const ctx: JobContext = { jobId: 'job-1', attemptNumber: 1, queueName: 'routed-queue' }

describe('createRoutedHandler', () => {
  it('fails the job when no handler is registered for its type', async () => {
    const handler = createRoutedHandler<RoutedPayload>({
      'known.type': async () => {},
    })

    await expect(handler(buildJob('unknown.type'), ctx)).rejects.toThrow(
      'No handler registered for job type: unknown.type',
    )
  })

  it('fails the job when its type only matches an Object.prototype key', async () => {
    const handler = createRoutedHandler<RoutedPayload>({
      'known.type': async () => {},
    })

    await expect(handler(buildJob('toString'), ctx)).rejects.toThrow(
      'No handler registered for job type: toString',
    )
  })

  it('still runs the registered handler for a known type', async () => {
    const known = jest.fn(async () => {})
    const handler = createRoutedHandler<RoutedPayload>({ 'known.type': known })
    const job = buildJob('known.type')

    await expect(handler(job, ctx)).resolves.toBeUndefined()
    expect(known).toHaveBeenCalledTimes(1)
    expect(known).toHaveBeenCalledWith(job, ctx)
  })

  it('keeps an unroutable job queued for retry on the local strategy instead of completing it', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routed-handler-'))
    const queue = createQueue<RoutedPayload>('routed-queue', 'local', { baseDir })
    try {
      const jobId = await queue.enqueue({ type: 'unknown.type' })

      const result = await queue.process(
        createRoutedHandler<RoutedPayload>({ 'known.type': async () => {} }),
        { limit: 10 },
      )

      expect(result).toMatchObject({ processed: 0, failed: 1 })
      const remaining: Array<{ id: string; attemptCount?: number; availableAt?: string }> = JSON.parse(
        fs.readFileSync(path.join(baseDir, 'routed-queue', 'queue.json'), 'utf8'),
      )
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ id: jobId, attemptCount: 1 })
      expect(remaining[0].availableAt).toEqual(expect.any(String))
    } finally {
      await queue.close()
      fs.rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
