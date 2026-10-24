import { useEffect, useState } from "react";
import { readChanges, type CheckpointChanges } from "./research-api";

export function useChanges(id: string, refreshKey: string, sprintId = "") {
  const key = `${id}:${sprintId}`;
  const [result, setResult] = useState<{
    key: string;
    changes: CheckpointChanges | null;
    error: string;
  }>();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    readChanges(id, sprintId || undefined).then(
      (changes) => !cancelled && setResult({ key, changes, error: "" }),
      (error: unknown) =>
        !cancelled &&
        setResult({
          key,
          changes: null,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [id, sprintId, key, refreshKey, reads]);
  return {
    changes: result?.key === key ? result.changes : null,
    error: result?.key === key ? result.error : "",
    retry: () => setReads((n) => n + 1),
  };
}
