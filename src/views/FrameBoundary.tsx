import { Component, type ReactNode } from 'react'

/**
 * Keeps an error in one pane to that pane. Without it a single throw while
 * rendering (a bad view name in a saved layout, a content kind's bug) unmounts
 * the whole app; as a desktop shell, that blanks the screen and every window
 * on it disappears.
 */
export class FrameBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[cwm] pane "${this.props.label}" failed to render:`, error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <section className="frame frame-error">
        <div className="missing">
          <div>
            “{this.props.label}” failed to render: {this.state.error.message}
          </div>
          <button onClick={() => this.setState({ error: null })}>Retry</button>
        </div>
      </section>
    )
  }
}
