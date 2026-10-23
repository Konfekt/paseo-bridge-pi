export interface CompactionCallbacks<T> {
  compact(options: {
    customInstructions?: string;
    onComplete: (result: T) => void;
    onError: (error: Error) => void;
  }): void;
}

/** Resolve only when Pi's callback reports actual compaction completion. */
export function compactWithResult<T>(
  context: CompactionCallbacks<T>,
  customInstructions?: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const complete = (result: T) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      context.compact({ customInstructions, onComplete: complete, onError: fail });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
