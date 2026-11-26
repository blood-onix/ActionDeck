/** What an open dashboard tab does when its repository's GitHub session changes. */
export interface PanelIdentityListener<Session> {
  /** The account the tab was opened with is no longer signed in; the tab must stop acting. */
  revoke(): void;
  /** The same account has a new session (renewed token or broader scopes); the tab keeps working with it. */
  refresh(session: Session, retriggerDashboard?: boolean): void;
}

/**
 * Tracks open tabs per repository so a GitHub session change reaches exactly the tabs it affects.
 * Selecting another repository never touches a tab: each tab acts only for its own repository and account.
 */
export class PanelIdentityRegistry<Session> {
  private readonly listeners = new Map<string, Set<PanelIdentityListener<Session>>>();

  register(repositoryId: string, listener: PanelIdentityListener<Session>): () => void {
    const set = this.listeners.get(repositoryId) ?? new Set();
    set.add(listener);
    this.listeners.set(repositoryId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(repositoryId) === set) this.listeners.delete(repositoryId);
    };
  }

  /** Locks every tab of the repository; a revoked tab never comes back, the user reopens it. */
  revoke(repositoryId: string): void {
    const set = this.listeners.get(repositoryId);
    if (!set) return;
    this.listeners.delete(repositoryId);
    for (const listener of set) listener.revoke();
  }

  refresh(repositoryId: string, session: Session, retriggerDashboard?: boolean): void {
    for (const listener of [...(this.listeners.get(repositoryId) ?? [])]) listener.refresh(session, retriggerDashboard);
  }
}
