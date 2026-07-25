import { describe, it, expect } from "vitest";
import { splitFrontmatter } from "./frontmatter.js";

describe("splitFrontmatter", () => {
  it("splits normal frontmatter", () => {
    const text = "---\ntype: note\nstatus: active\n---\n# Heading\n\nbody text\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBe("type: note\nstatus: active");
    expect(body).toBe("# Heading\n\nbody text\n");
  });

  it("handles CRLF frontmatter", () => {
    const text = "---\r\ntype: note\r\nstatus: active\r\n---\r\n# Heading\r\n\r\nbody\r\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBe("type: note\nstatus: active");
    expect(body).toBe("# Heading\n\nbody\n");
  });

  it("returns body unchanged when there is no frontmatter", () => {
    const text = "# Just a heading\n\nsome prose\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBeNull();
    expect(body).toBe(text);
  });

  it("leaves a document alone whose first line is a --- horizontal rule with no key: line", () => {
    const text = "---\nJust some emphasized text, not frontmatter.\n---\nmore prose\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBeNull();
    expect(body).toBe(text);
  });

  it("leaves a mid-document --- block untouched", () => {
    const text = "# Heading\n\nsome prose\n\n---\nfoo: bar\n---\n\nmore prose\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBeNull();
    expect(body).toBe(text);
  });

  it("accepts ... as the closing fence", () => {
    const text = "---\ntype: note\n...\nbody prose\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBe("type: note");
    expect(body).toBe("body prose\n");
  });

  it("leaves an unterminated opening fence untouched", () => {
    const text = "---\ntype: note\nstatus: active\n\nno closing fence here\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBeNull();
    expect(body).toBe(text);
  });

  it("handles frontmatter immediately followed by an H1", () => {
    const text = "---\ntype: note\n---\n# Real Heading\nbody prose\n";
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter).toBe("type: note");
    expect(body).toBe("# Real Heading\nbody prose\n");
  });
});
