export interface DiffLine {
  kind: "hunk" | "add" | "del" | "context" | "meta";
  old: number | null;
  next: number | null;
  text: string;
}

/** Keep both line counters across hunks; metadata never consumes a line. */
export function unifiedLines(diff: string): DiffLine[] {
  let old: number | null = null;
  let next: number | null = null;
  let inHunk = false;
  return diff
    .split("\n")
    .filter((text, index, rows) => index < rows.length - 1 || text !== "")
    .flatMap((text): DiffLine[] => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        old = Number(hunk[1]);
        next = Number(hunk[2]);
        inHunk = true;
        return [{ kind: "hunk", old: null, next: null, text }];
      }
      if (
        !inHunk &&
        /^(diff |index |--- |\+\+\+ |.*file mode |similarity index |rename (from|to) )/.test(
          text,
        )
      )
        return [];
      const kind: DiffLine["kind"] = text.startsWith("+")
        ? "add"
        : text.startsWith("-")
          ? "del"
          : text.startsWith(" ")
            ? "context"
            : "meta";
      const row = {
        kind,
        old: kind === "del" || kind === "context" ? old : null,
        next: kind === "add" || kind === "context" ? next : null,
        text,
      };
      if ((kind === "del" || kind === "context") && old !== null) old++;
      if ((kind === "add" || kind === "context") && next !== null) next++;
      return [row];
    });
}

/** This is only the initial presentation; every file remains expandable. */
export const initiallyExpanded = (file: {
  diff: string;
  truncated?: boolean;
  binary?: boolean;
}) => !file.truncated && !file.binary && file.diff.split("\n").length <= 200;
