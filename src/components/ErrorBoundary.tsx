import { AlertTriangle } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Keeps a render error in one part of the UI from blanking the whole app. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error:', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Something went wrong displaying this page.</p>
            <p className="mt-1">Your submitted data is safe. Reload to continue.</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-3 rounded-md bg-red-600 px-3 py-1.5 font-medium text-white hover:bg-red-700"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
