/**
 * Derives a doc's owning project from its path by the layout convention
 * `.../<segment>/<project>/...` (segment is configurable — `ingest.projectSegment`,
 * default "corpus"). Frontmatter `project:` and `IngestOptions.project` override
 * it when present. No guessing: any path without the segment, or a file sitting
 * directly inside it with no subdirectory, yields null rather than a fabricated
 * value.
 */
export function projectFromPath(path: string, segment = "corpus"): string | null {
  if (!segment) return null;
  const segments = path.split(/[\\/]+/).filter((s) => s.length > 0);
  const idx = segments.indexOf(segment);
  if (idx === -1) return null;
  // segments[idx+1] must be a directory (i.e. more path follows it) — a file
  // sitting directly in the segment dir (idx+1 is the last segment) has no project.
  if (idx + 2 >= segments.length) return null;
  return segments[idx + 1] ?? null;
}
