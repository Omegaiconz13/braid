import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyAttempts,
  weightFor,
  weightsFor,
  type LinkHealth,
  type LinkAttempt
} from '../src/daemon/linkHealth.ts'

/** Build a window the way the monitor does: oldest attempt first. `true` is a
 * success at 80 ms, `false` a failed handshake; a number sets its own RTT. */
function windowOf(pattern: Array<boolean | number>): LinkAttempt[] {
  const at = 1_000
  return pattern.map((entry) => {
    if (entry === false) return { ok: false, rttMs: null, at }
    if (entry === true) return { ok: true, rttMs: 80, at }
    return { ok: true, rttMs: entry, at }
  })
}

test('no probes yet reads as unknown and keeps a neutral weight', () => {
  const health = classifyAttempts([])
  assert.equal(health.state, 'unknown')
  assert.equal(health.rttMs, null)
  assert.equal(health.attempts, 0)
  assert.equal(weightFor(health), 1)
})

test('six clean handshakes read as good with the median round trip', () => {
  const health = classifyAttempts(windowOf([60, 80, 100, 80, 90, 80]))
  assert.equal(health.state, 'good')
  assert.equal(health.rttMs, 80)
  assert.equal(health.lossPct, 0)
  assert.equal(health.score, 95)
  assert.equal(weightFor(health), 3)
})

test('a fifth of the probes failing is degraded, not dead', () => {
  const health = classifyAttempts(windowOf([80, 80, 80, 80, false, 80]))
  assert.equal(health.state, 'degraded')
  assert.equal(health.lossPct, 17)
  assert.equal(weightFor(health), 1)
})

test('three failures in a row are dead and leave the route', () => {
  const health = classifyAttempts(windowOf([80, 80, false, false, false]))
  assert.equal(health.state, 'dead')
  assert.equal(health.lossPct, 60)
  assert.equal(weightFor(health), 0)
})

test('an old success does not save a link that has stopped answering', () => {
  const health = classifyAttempts(windowOf([80, 80, 80, false, false, false]))
  assert.equal(health.state, 'dead')
})

test('a clean but very slow path is degraded', () => {
  const health = classifyAttempts(windowOf([650, 700, 600, 640]))
  assert.equal(health.state, 'degraded')
  assert.equal(health.lossPct, 0)
  assert.equal(weightFor(health), 1)
})

test('one failed round after a good window is not yet dead', () => {
  const health = classifyAttempts(windowOf([80, 80, 80, 80, 80, false]))
  assert.equal(health.state, 'degraded')
  assert.equal(weightFor(health), 1)
})

/** A snapshot entry with just the verdict; weightsFor only reads id/state. */
function link(id: string, state: LinkHealth['state']): LinkHealth {
  return { id, state, rttMs: null, lossPct: 0, score: 100, attempts: 6, checkedAt: 1 }
}

test('two good links keep equal shares, a degraded one gets a single share', () => {
  assert.deepEqual(
    [...weightsFor([link('a', 'good'), link('b', 'good')])!],
    [
      ['a', 3],
      ['b', 3]
    ]
  )
  assert.deepEqual(
    [...weightsFor([link('a', 'good'), link('b', 'degraded')])!],
    [
      ['a', 3],
      ['b', 1]
    ]
  )
})

test('a dead link is excluded, unless it is the only one left', () => {
  assert.deepEqual(
    [...weightsFor([link('a', 'good'), link('b', 'dead')])!],
    [
      ['a', 3],
      ['b', 0]
    ]
  )
  assert.equal(weightsFor([link('a', 'dead'), link('b', 'dead')]), null)
})

test('a single link or an all-unknown pair leaves the route alone', () => {
  assert.equal(weightsFor([link('a', 'good')]), null)
  assert.equal(weightsFor([link('a', 'unknown'), link('b', 'unknown')]), null)
})
