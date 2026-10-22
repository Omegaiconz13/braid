import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Multipath, type MultipathLink } from '../src/daemon/systemWide.ts'

const link = (dev: string, via: string): MultipathLink => ({ dev, via })

test('sameLinks matches identical gateways per device, order aside', () => {
  const a = [link('wlp1s0', '10.0.0.1'), link('enp0s20f0u1', '10.1.0.1')]
  const b = [link('enp0s20f0u1', '10.1.0.1'), link('wlp1s0', '10.0.0.1')]
  assert.equal(Multipath.sameLinks(a, b), true)
})

test('sameLinks sees a changed gateway', () => {
  // The self-sustain bug this guards: after a DHCP renew the plan carries the
  // new gateway while the installed route still holds the old one.
  const installed = [link('wlp1s0', '10.213.154.90'), link('enp0s20f0u1', '10.240.212.174')]
  const planned = [link('wlp1s0', '10.239.58.250'), link('enp0s20f0u1', '10.240.212.174')]
  assert.equal(Multipath.sameLinks(planned, installed), false)
})

test('sameLinks sees a link coming or going', () => {
  const two = [link('wlp1s0', '10.0.0.1'), link('enp0s20f0u1', '10.1.0.1')]
  const one = [link('wlp1s0', '10.0.0.1')]
  assert.equal(Multipath.sameLinks(two, one), false)
  assert.equal(Multipath.sameLinks(one, two), false)
  assert.equal(Multipath.sameLinks([], []), true)
})

test('sameLinks ignores weight and src, as up always resets them', () => {
  const a = [{ dev: 'wlp1s0', via: '10.0.0.1', weight: 3, src: '10.0.0.5' }]
  const b = [{ dev: 'wlp1s0', via: '10.0.0.1', weight: 1 }]
  assert.equal(Multipath.sameLinks(a, b), true)
})
