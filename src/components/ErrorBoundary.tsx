import { Component, type ErrorInfo, type ReactNode } from 'react';
import { navigate } from '../lib/router';

interface Props {
  children: ReactNode;
  /** A change (e.g. the route) clears the error, so moving on to another screen works again. */
  resetKey?: string;
}

interface State {
  error: Error | null;
  key?: string;
}

/**
 * Keeps one bad record (or any other rendering bug) from blanking the whole app: shows a way out instead —
 * back to the library, or to Settings for a backup or a fresh start.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Magpie hit a problem showing this screen', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const go = (path: string) => {
      this.setState({ error: null });
      navigate(path, { replace: true });
    };
    return (
      <div className="empty" role="alert">
        <div className="emoji">🪶</div>
        <h2>Something went wrong here</h2>
        <p>Your saves are still on this device. Try another screen — or open Settings to download a backup.</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => go('/')}>
            Go to my library
          </button>
          <button className="btn outline" onClick={() => go('/settings')}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }
}
