/**
 * Derives a doc's owning project from its path, purely by the corpus layout
 * convention: `.../corpus/<project>/...`. This is the stage-4 placeholder —
 * stage 5 frontmatter `project:` overrides it when present. No guessing: any
 * path without a `corpus/` segment, or a file directly inside `corpus/` with
 * no subdirectory, yields null rather than a fabricated value.
 */
export function projectFromPath(path: string): string | null {
  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  const idx = segments.indexOf("corpus");
  if (idx === -1) return null;
  // segments[idx+1] must be a directory (i.e. more path follows it) — a file
  // sitting directly in corpus/ (idx+1 is the last segment) has no project.
  if (idx + 2 >= segments.length) return null;
  return segments[idx + 1] ?? null;
}
