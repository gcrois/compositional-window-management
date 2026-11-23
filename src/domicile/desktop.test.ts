import { expect, it } from 'vitest'
import { addChild, makeLeaf, reachable } from '../model/ops'
import { seedDoc } from '../model/seed'
import { useStore } from '../model/store'
import { connect } from './desktop'

const titles = () => {
  const d = useStore.getState().doc
  return [...reachable(d)].map((id) => d.nodes[id].title)
}

// A pane goes only once Domicile has delivered its list (a reloaded shell first
// sees an empty one); it goes without taking siblings, and a window with no
// pane gets one.
it('window sync keeps one pane per open window', () => {
  const doc = seedDoc()
  addChild(doc, doc.root, makeLeaf('gone', 'app', { appId: 'app-1', pid: 1 }))
  useStore.setState({ doc, focus: [] })
  const others = titles().filter((t) => t !== 'gone')
  let list: { appId: string; title: string; pid: number }[] = []
  let changed = () => {}
  const domicile = {
    windows: {
      get list() {
        return list
      },
      on: (event: string, fn: () => void) => {
        if (event === 'change') changed = fn
        return () => {}
      },
      focus: () => {},
      focusShell: () => {},
      setStates: async () => {},
    },
  } as unknown as Parameters<typeof connect>[0]

  const off = connect(domicile)
  expect(titles()).toContain('gone')

  list = [{ appId: 'app-1', title: 'new', pid: 2 }]
  changed()
  off()
  expect(titles().filter((t) => t !== 'new')).toEqual(others)
  expect(titles()).toContain('new')
})

// A JetBrains drop shadow sticks out on every side and is left out; a Gecko
// app's content child is exactly the window's size and must be drawn.
it('tells a decoration from a content child', async () => {
  const { isDecoration } = await import('./desktop')
  const win = { appId: 'w', width: 1000, height: 600 } as Parameters<typeof isDecoration>[0]
  const child = (x: number, y: number, width: number, height: number) =>
    ({ appId: 'c', parent: 'w', x, y, width, height, grab: false }) as Parameters<typeof isDecoration>[0]
  expect(isDecoration(child(-20, -20, 1040, 640), [win])).toBe(true)
  expect(isDecoration(child(0, 0, 1000, 600), [win])).toBe(false)
  expect(isDecoration(child(10, 30, 200, 300), [win])).toBe(false)
})

it('treats a same-size child at the origin as content, not a menu', async () => {
  const { isContentChild } = await import('./desktop')
  const win = { appId: 'w', width: 1000, height: 600 } as Parameters<typeof isContentChild>[0]
  const child = (x: number, y: number, width: number, height: number, grab = false) =>
    ({ appId: 'c', parent: 'w', x, y, width, height, grab }) as Parameters<typeof isContentChild>[0]
  expect(isContentChild(child(0, 0, 1000, 600), [win])).toBe(true)
  expect(isContentChild(child(0, 0, 1000, 600, true), [win])).toBe(false)
  expect(isContentChild(child(10, 30, 200, 300), [win])).toBe(false)
})
