/**
 * Test-local Cell route seam (loaded by `bundles/myrix-base/cell.patch.yml`).
 *
 * The vendor agent loop will not issue a model request without an explicit
 * provider/model: `packages/core/agent-loop/src/agent.ts:577-582` throws
 * `agent "<id>" has no provider/model ... or supply both via the agent/request
 * waterfall`. The browser surface fills that gap with a session-scoped
 * waterfall (`installModelSelection` in `dsh-agent`); a Cell currently has none,
 * and `myrix-runtime-driver` deliberately calls `ctx.agents.create()` without
 * `AgentOptions.provider/model`.
 *
 * This row is the stand-in for that missing surface, and it is deliberately
 * narrow: a request that already carries BOTH a provider and a model is
 * returned untouched, so this seam can never redirect a call the driver (or a
 * future model-selection feature) already routed. It only fills blanks.
 *
 * It is a **test/deployment seam, not production code**: once the driver owns
 * the default route, the row is disabled through
 * `MYRIX_CELL_ROUTE_SEAM !== 'waterfall'`.
 *
 * @module myrix-cell-route-seam
 */

export const name = 'myrix-cell-route-seam'

/** `agents` is the service that owns the waterfall dispatch. */
export const inject = ['agents']

/**
 * Install the fill-in-only route waterfall.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {{ provider?: string, model?: string }} config - the Cell default route.
 */
export function apply(ctx, config) {
  const provider = typeof config?.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config?.model === 'string' ? config.model.trim() : ''
  if (provider.length === 0 || model.length === 0) {
    // Fail-closed at load: a seam with no route would look installed but do
    // nothing, and the first turn would fail with a confusing loop error.
    throw new Error('myrix-cell-route-seam: provider and model are required')
  }
  ctx.effect(
    () => ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      if (resolved.provider && resolved.model) return resolved
      return {
        ...resolved,
        provider: resolved.provider || provider,
        model: resolved.model || model,
      }
    }),
    'myrix-cell-route-seam: agent/request',
  )
}
