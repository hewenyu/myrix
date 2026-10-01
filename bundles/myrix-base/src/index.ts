/**
 * `@myrix/dsh-bundle-myrix-base` — the Myrix platform base bundle.
 *
 * The package's substance is `cordis.patch.yml`, declared by the
 * `dsh.bundle.patch` manifest field and resolved by the DSH profile composer;
 * this module carries no runtime interface, exactly like
 * `@deepseek-ai/dsh-sdk-minimal`.
 *
 * The bundle deliberately declares **no dependencies**: it contributes plugin
 * *rows*, and the DSH runtime resolution supplies those packages from the
 * installation's own dependency graph. Adding a dependency here would pin a
 * second copy of DSH packages and let the bundle drift from the locked
 * runtime.
 *
 * @module @myrix/dsh-bundle-myrix-base
 */

export {}
