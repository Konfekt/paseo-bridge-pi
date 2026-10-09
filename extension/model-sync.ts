type ModelIdentity = { provider: string; id: string };

/** Pi setModel reselects the saved thinking default, even for the same model.
 * A cache-sync echo must not turn that into a live configuration change. */
export async function applyRemoteModel<T extends ModelIdentity>(
  current: ModelIdentity | undefined,
  requested: T,
  apply: (model: T) => Promise<boolean>,
): Promise<boolean> {
  if (current?.provider === requested.provider && current.id === requested.id) return true;
  return apply(requested);
}
