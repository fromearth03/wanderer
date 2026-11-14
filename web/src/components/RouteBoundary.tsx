import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ex } from '../explain';

interface Props {
  children: ReactNode;
  /** Changes on navigation, which clears a previous error. */
  resetKey: string;
}
interface State {
  error: Error | null;
  key: string;
  tries: number;
}

/** Per-route error boundary: a bad value shows an error panel with retry, never a blank page. */
export default class RouteBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey, tries: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the details in the console for whoever debugs it.
    console.warn('Wanderer page error:', error.message, info.componentStack?.split('\n').slice(0, 4).join(' '));
  }

  render() {
    if (!this.state.error) return <div key={this.state.tries} className="route-body">{this.props.children}</div>;
    return (
      <div className="page">
        <div className="err-panel" role="alert">
          <h2>This page hit a problem</h2>
          <p>{this.state.error.message || 'Unknown error.'}</p>
          <p className="muted small">Your target and settings are kept. Retry, or go back to Explore and pick another target.</p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={() => this.setState((s) => ({ error: null, tries: s.tries + 1 }))} data-explain={ex('common.retry')}>
              Retry
            </button>
            <a className="btn" href="/" data-explain={ex('common.goExplore')}>
              Go to Explore
            </a>
          </div>
        </div>
      </div>
    );
  }
}
