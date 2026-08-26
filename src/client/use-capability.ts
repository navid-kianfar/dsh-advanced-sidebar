/**
 * The capability-view hook shared by the two menu seats and the settings card.
 *
 * There is no host-to-client push channel available to an out-of-tree plugin, so the view is
 * fetched rather than subscribed. It is fetched on demand — when a menu opens, when a card is
 * expanded — rather than on a timer: the facts it carries (is git installed, does `code` resolve)
 * change on the scale of an operator installing something, and a poll would spend a PATH scan per
 * interval to notice.
 * @module @achasoft/dsh-advanced-sidebar/client/use-capability
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdvancedSidebarView } from '../host/types.ts'

/** The view plus the trigger that re-reads it. */
export interface CapabilityHandle {
  /** The last successful reading; undefined until one arrives. */
  view: AdvancedSidebarView | undefined
  /** The transport failure of the last attempt, when it failed. */
  error: string | undefined
  /** Ask for a fresh reading. Stable across renders, so it is safe in an effect's dependency list. */
  refresh: () => void
}

/**
 * Read the Host capability view on demand.
 * @param describe - the endpoint call.
 * @param enabled - false suspends fetching entirely (a collapsed card, a seat switched off).
 * @returns the view, the last error, and a stable refresh.
 */
export function useCapabilityView(
  describe: (signal?: AbortSignal) => Promise<AdvancedSidebarView>,
  enabled = true,
): CapabilityHandle {
  const [view, setView] = useState<AdvancedSidebarView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [generation, setGeneration] = useState(0)
  // A ref, not state: bumping the generation is what re-runs the effect, and a pending flag in
  // state would re-render every seat twice per open for a fact nothing renders.
  const inFlight = useRef(false)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    inFlight.current = true
    describe(controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return
        setView(next)
        setError(undefined)
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return
        // The previous view is deliberately kept: a menu that empties itself on one failed probe
        // would be worse than one showing slightly stale availability.
        setError(reason instanceof Error ? reason.message : String(reason))
      },
    ).finally(() => { inFlight.current = false })
    return () => { controller.abort() }
  }, [describe, enabled, generation])

  const refresh = useCallback(() => {
    if (inFlight.current) return
    setGeneration(value => value + 1)
  }, [])

  return { view, error, refresh }
}
