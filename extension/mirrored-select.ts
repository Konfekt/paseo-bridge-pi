export async function coordinateMirroredSelect(options: {
  remoteResult: Promise<string | undefined>;
  localSelect: (signal: AbortSignal) => Promise<string | undefined>;
  resolveLocal: (value: string | undefined) => Promise<unknown>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const localController = new AbortController();
  const abortLocal = () => localController.abort();
  if (options.signal) {
    if (options.signal.aborted) localController.abort();
    else options.signal.addEventListener("abort", abortLocal, { once: true });
  }

  try {
    const winner = await Promise.race([
      options.remoteResult.then((value) => ({ source: "remote" as const, value })),
      Promise.resolve()
        .then(() => options.localSelect(localController.signal))
        .then((value) => ({ source: "local" as const, value })),
    ]);
    if (winner.source === "remote") {
      localController.abort();
      return winner.value;
    }

    // Submission is not consumption: only the response received through the
    // controller settles the original Pi request, including local selections.
    return await Promise.race([
      options.resolveLocal(winner.value).then(() => options.remoteResult),
      options.remoteResult,
    ]);
  } finally {
    options.signal?.removeEventListener("abort", abortLocal);
  }
}
