export interface ReviewedAction {
  readonly repositoryId: string;
  readonly target: string;
  readonly ref: string;
  readonly inputs: Readonly<Record<string, string>>;
}

export interface UiExecutionAuthorization {
  authorize(action: ReviewedAction): void;
  consume(action: ReviewedAction): boolean;
  invalidate(): void;
}

export class UiAuthorization {
  private reviewed: string | undefined;

  authorize(action: ReviewedAction): void {
    this.reviewed = this.fingerprint(action);
  }

  consume(action: ReviewedAction): boolean {
    const fingerprint = this.fingerprint(action);
    const allowed = this.reviewed === fingerprint;
    this.reviewed = undefined;
    return allowed;
  }

  invalidate(): void {
    this.reviewed = undefined;
  }

  private fingerprint(action: ReviewedAction): string {
    return JSON.stringify({
      repositoryId: action.repositoryId,
      target: action.target,
      ref: action.ref,
      inputs: Object.entries(action.inputs).sort(([a], [b]) => a.localeCompare(b)),
    });
  }
}
