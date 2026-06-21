const PRIVATE_BLOCK = /<private>[\s\S]*?<\/private>/gi;

/** Remove <private>...</private> blocks. Collapses any resulting blank runs. */
export function stripPrivateBlocks(text: string): string {
  return text.replace(PRIVATE_BLOCK, "").replace(/\n{3,}/g, "\n\n");
}
