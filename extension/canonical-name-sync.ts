export type CanonicalName = { displayName: string; revision: number };
export type CanonicalNameAuthority = {
  get(): CanonicalName;
  rename(name: string, revision: number, source: "paseo"): CanonicalName;
};

/** Existing-API eventual reconciliation: latest observed external rename wins.
 * Native writes are serialized; acknowledged/observed echoes never create revisions.
 * Paseo does not expose mutation origins or conditional title writes, so simultaneous
 * identical user/echo titles cannot be distinguished. This is not lossless CAS. */
export class CanonicalNameSync {
  private remoteName: string | null | undefined;
  private observedName: string | null | undefined;
  private remoteObservation = 0;
  private workspaceName: string | undefined;
  private echoes: { name: string; until: number }[] = [];
  private running: Promise<void> | undefined;
  private closed = false;
  private warned = new Set<string>();
  private failureMessage: string | undefined;
  private generation: string | undefined;
  private retiredGenerations = new Set<string>();
  private sequence = 0;
  private initialRevision: number;
  private readonly options: {
    authority: CanonicalNameAuthority;
    isCurrent(): boolean;
    write(name: string, updateAgent: boolean): Promise<void>;
    warn(message: string): void;
  };
  constructor(options: CanonicalNameSync["options"]) { this.options = options; this.initialRevision = options.authority.get().revision; }
  private current(): boolean { return !this.closed && this.options.isCurrent(); }
  observe(name: string | null, order?: { generation?: string; seq?: number }): void {
    if (!this.current()) return;
    if (order?.generation && this.retiredGenerations.has(order.generation)) return;
    if (order?.generation && order.generation !== this.generation && this.generation) this.retiredGenerations.add(this.generation);
    if (order?.generation && order.generation === this.generation && order.seq !== undefined && order.seq <= this.sequence) return;
    if (order?.generation !== undefined) this.generation = order.generation;
    if (order?.seq !== undefined) this.sequence = order.seq;
    this.remoteObservation++;
    const previousName = this.observedName;
    this.observedName = name;
    this.remoteName = name;
    this.echoes = this.echoes.filter(echo => echo.until >= Date.now());
    const echo = name === null || name === previousName ? -1 : this.echoes.findIndex(echo => echo.name === name);
    if (echo >= 0) this.echoes = this.echoes.filter(echo => echo.name !== name);
    else if (name !== null && name !== previousName && name !== this.options.authority.get().displayName
      && (previousName !== undefined || this.options.authority.get().revision === this.initialRevision)) {
      try {
        if (!name || name.length > 80 || name !== name.trim() || /[\p{Cc}\p{Cf}]/u.test(name) || name.split(/\s+/u).length > 4) {
          throw new Error("use one to four words, at most 80 characters, without control characters");
        }
        const current = this.options.authority.get();
        this.options.authority.rename(name, current.revision, "paseo");
      } catch (error) {
        if (!this.warned.has(name)) {
          this.warned.add(name);
          if (this.warned.size > 32) this.warned.delete(this.warned.values().next().value!);
          this.options.warn(`Name not changed: ${String(error)}. Restoring the canonical task name.`);
        }
      }
    }
    this.changed();
  }
  changed(): void {
    if (!this.current() || this.running || this.remoteName === undefined) return;
    this.running = this.drain().catch(error => {
      const message = `Task name synchronization unavailable: ${String(error)}`;
      if (this.current() && message !== this.failureMessage) { this.failureMessage = message; this.options.warn(message); }
    }).finally(() => { this.running = undefined; });
  }
  private async drain(): Promise<void> {
    while (this.current()) {
      const target = this.options.authority.get();
      const updateAgent = this.remoteName !== target.displayName;
      if (!updateAgent && this.workspaceName === target.displayName) return;
      const observation = this.remoteObservation;
      if (updateAgent) {
        this.echoes.push({ name: target.displayName, until: Date.now() + 30_000 });
        if (this.echoes.length > 32) this.echoes.shift();
      }
      await this.options.write(target.displayName, updateAgent);
      this.failureMessage = undefined;
      if (!this.current()) return;
      this.workspaceName = target.displayName;
      // Responses are acknowledgements, not renames. Do not overwrite a newer
      // subscribed observation with an older asynchronous write completion.
      if (updateAgent && observation === this.remoteObservation) this.remoteName = target.displayName;
    }
  }
  async settled(): Promise<void> { await this.running; }
  close(): void { this.closed = true; }
}
