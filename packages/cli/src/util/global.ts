/**
 * Global CLI options shared by every command. The installer surface never opens
 * a store directly (that lives behind the running service), so this is now just
 * the flag shape — no store helpers.
 */
export interface GlobalOpts {
  home?: string;
  json?: boolean;
}
