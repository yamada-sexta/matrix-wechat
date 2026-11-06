// Native completion acknowledges a request; it never replaces cache/MD5 verification.
export class DownloadRetry {
  private attempts = new Map<string, { after: number; pending: boolean }>();
  constructor(private readonly now = Date.now) {}
  request(key: string, task: () => Promise<unknown>) {
    const previous = this.attempts.get(key);
    if (previous && (previous.pending || previous.after > this.now())) return;
    if ([...this.attempts.values()].filter((a) => a.pending).length >= 2) return;
    if (this.attempts.size >= 256) {
      const oldest = [...this.attempts].find(([, a]) => !a.pending);
      if (!oldest) return;
      this.attempts.delete(oldest[0]);
    }
    const attempt = { after: this.now() + 60000, pending: true };
    this.attempts.set(key, attempt);
    void Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        attempt.pending = false;
      });
  }
}
