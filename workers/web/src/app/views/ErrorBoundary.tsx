import { Component, type ReactNode, useState } from "react";

/** Signs out, then reloads into the signed-out page. false, without reloading, when the sign-out failed. */
export async function signOutAndReload(signOut: () => Promise<void>, reload: () => void): Promise<boolean> {
  try {
    await signOut();
  } catch (e) {
    console.error("sign-out failed", e);
    return false;
  }
  reload();
  return true;
}

type Actions = { onSignOut: () => Promise<void>; onReload: () => void };

/** What the page shows after a render error: the way out is a reload or a sign-out. */
export function Failure({ onSignOut, onReload }: Actions) {
  const [signOutFailed, setSignOutFailed] = useState(false);
  return (
    <main className="status-page">
      <p>Something went wrong.</p>
      <button type="button" onClick={onReload}>
        Reload
      </button>{" "}
      <button
        type="button"
        onClick={() => {
          setSignOutFailed(false);
          void signOutAndReload(onSignOut, onReload).then((ok) => setSignOutFailed(!ok));
        }}
      >
        Sign out
      </button>
      {signOutFailed && <p className="small">Sign-out didn't finish. Try again.</p>}
    </main>
  );
}

/**
 * Catches an error thrown while rendering anything below it (a task the
 * page's shape checks let through, for one) and shows Failure instead of a
 * blank page.
 */
export class ErrorBoundary extends Component<Actions & { children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(_error: unknown): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("render failed", error);
  }

  render() {
    if (this.state.failed) return <Failure onSignOut={this.props.onSignOut} onReload={this.props.onReload} />;
    return this.props.children;
  }
}
