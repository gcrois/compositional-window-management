/**
 * Whether this desktop runs in a window inside another desktop (GNOME),
 * rather than as the login session. A login session starts
 * `domicile-session.target`; a nested desktop registers nothing.
 */
import type { Domicile } from '@domicile-desktop/sdk/shell'

let nested: boolean | undefined

/** `undefined` until known; treat that as nested wherever guessing wrong would touch the host. */
export const isNested = () => nested

export async function detectNested(domicile: Domicile) {
  const ran = await domicile.processes.run(['systemctl', '--user', 'is-active', '--quiet', 'domicile-session.target'])
  nested = ran.match({ Ok: (r) => r.code !== 0, Err: () => true })
}
