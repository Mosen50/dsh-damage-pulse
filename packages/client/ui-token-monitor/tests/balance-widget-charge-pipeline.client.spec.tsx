// @vitest-environment jsdom

/**
 * Charge pipeline integrity: the card's number must follow the Host's authoritative
 * balance even when the damage-float pipeline itself is broken.
 *
 * Regression for the reported "balance number never updates" symptom. The readout used
 * to be rendered as "balance snapshot + not-yet-floated debits", so a single throw while
 * the drain timer emitted one float permanently pinned the number: every 60s calibration
 * added back exactly what the account had lost. The same throw on the polling path was
 * swallowed, leaving the event cursor unadvanced, so the client re-fetched the whole
 * ledger every second and re-applied debits it had already counted.
 */
import { act, cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BalanceWidget } from '../src/client/BalanceWidget.tsx'

/** Charges exactly as the Host reports them: separate calls, then one multi-part call. */
const CHARGES: ReadonlyArray<{ atMs: number; cost: number; kind: 'hit' | 'output' }> = [
  { atMs: 20_000, cost: 0.02, kind: 'output' },
  { atMs: 40_000, cost: 0.01, kind: 'hit' },
  { atMs: 90_000, cost: 0.01, kind: 'hit' },
  { atMs: 90_000, cost: 0.02, kind: 'output' },
  { atMs: 90_000, cost: 0.01, kind: 'hit' },
  { atMs: 150_000, cost: 0.02, kind: 'output' },
]
const START_BALANCE = 10
const FINAL_BALANCE = 9.91

let origin = 0
let waapiAttempts = 0
/** Attempt number after which the animation read keeps failing (0 = from the very first). */
let faultAfter = 0
const sinceValues = new Set<string>()
const uncaught: string[] = []

function elapsed(): number {
  return Date.now() - origin
}

function chargesUpTo(t: number) {
  return CHARGES.filter(charge => charge.atMs <= t)
    .map((charge, index) => ({ id: `charge-${index + 1}`, seq: index + 1, cost: charge.cost, kind: charge.kind, timestamp: origin + charge.atMs }))
}

function hostBalance(t: number): number {
  return Number((START_BALANCE - chargesUpTo(t).reduce((sum, charge) => sum + charge.cost, 0)).toFixed(2))
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function readout(view: ReturnType<typeof render>): number | null {
  const text = view.baseElement.querySelector('[data-token-monitor-display]')?.textContent ?? ''
  const match = /(-?\d+\.\d{2})/.exec(text)
  return match === null ? null : Number(match[1])
}

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  origin = Date.now()
  waapiAttempts = 0
  faultAfter = 0
  sinceValues.clear()
  uncaught.length = 0
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  // Fault injection point: every animation read fails, which is what a browser without
  // Web Animations does, and stands in for any exception raised on the emission path.
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    writable: true,
    value: () => {
      waapiAttempts += 1
      if (waapiAttempts > faultAfter) throw new Error('Web Animations unavailable')
      return []
    },
  })
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: () => ({ cancel() {}, commitStyles() {} }),
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    const t = elapsed()
    if (url.startsWith('/api/token-monitor/balance')) {
      return json({
        currency: 'CNY',
        totalBalance: hostBalance(t),
        grantedBalance: 0,
        toppedUpBalance: hostBalance(t),
        isAvailable: true,
        updatedAt: Date.now(),
      })
    }
    if (url.startsWith('/api/token-monitor/charge-events')) {
      const since = new URL(url, 'http://x').searchParams.get('since') ?? '0'
      sinceValues.add(since)
      const all = chargesUpTo(t)
      return json({
        streamId: 'stream-1',
        seq: all.length,
        firstSeq: all.length === 0 ? 0 : 1,
        dropped: false,
        events: all.filter(event => event.seq > Number(since)),
      })
    }
    return new Response('', { status: 503 })
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Poll for 200 simulated seconds; the account ends at FINAL_BALANCE. */
async function pollForTwoHundredSeconds(): Promise<ReturnType<typeof render>> {
  const useSessions = (selector: (state: { current: string }) => unknown) => selector({ current: 'session-1' })
  const props = { useSessions, loadRouteEligibility: vi.fn().mockResolvedValue(true) } as unknown as ComponentProps<typeof BalanceWidget>
  const view = render(<BalanceWidget {...props} />)
  for (let step = 0; step < 20; step += 1) {
    // A throwing timer callback is an uncaught console error in a browser: the page
    // keeps running, so record it and continue instead of failing the advance.
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    } catch (error) {
      uncaught.push(String(error))
    }
  }
  return view
}

describe('BalanceWidget charge pipeline', () => {
  it('keeps the readout on the Host balance when every float emission fails', async () => {
    faultAfter = 0
    const view = await pollForTwoHundredSeconds()

    expect(waapiAttempts).toBeGreaterThan(0)
    expect(hostBalance(elapsed())).toBe(FINAL_BALANCE)
    // The readout used to drift or freeze instead of following the account.
    expect(readout(view)).toBe(FINAL_BALANCE)
    // The cursor walked the ledger once; it used to stay at 0 and replay every second.
    expect(Math.max(...[...sinceValues].map(Number))).toBe(CHARGES.length)
  })

  it('survives a mid-burst emission failure without pinning the readout', async () => {
    // The 90s burst emits its first float from the poll and the rest from the drain
    // timer; fail from that timer emission onward.
    faultAfter = 3
    const view = await pollForTwoHundredSeconds()

    // The failure really happened on the timer path and stayed visible (uncaught).
    expect(uncaught.length).toBeGreaterThan(0)
    // The account kept draining and the readout followed it all the way.
    expect(hostBalance(elapsed())).toBe(FINAL_BALANCE)
    expect(readout(view)).toBe(FINAL_BALANCE)
    expect(Math.max(...[...sinceValues].map(Number))).toBe(CHARGES.length)
  })
})
