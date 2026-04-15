/**
 * @module documentation/links
 * @description Tests for documentation link consistency.
 *
 * Ensures all documentation links are valid and consistent:
 * - All referenced files exist
 * - No broken links
 * - Consistent distribution story
 *
 * @version v1
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const README_PATH = path.join(PROJECT_ROOT, "README.md");
const DOCS_INDEX = path.join(PROJECT_ROOT, "docs/index.md");
const INSTALLATION_PATH = path.join(PROJECT_ROOT, "docs/installation.md");
const COMMANDS_PATH = path.join(PROJECT_ROOT, "docs/commands.md");
const QUICKSTART_PATH = path.join(PROJECT_ROOT, "docs/quick-start.md");
const PROFILES_PATH = path.join(PROJECT_ROOT, "docs/profiles.md");
const ARCHIVE_PATH = path.join(PROJECT_ROOT, "docs/archive.md");

interface Link {
  target: string;
  source: string;
  line: number;
}

function extractLinks(content: string, filePath: string): Link[] {
  const links: Link[] = [];
  const lines = content.split("\n");

  const mdLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

  lines.forEach((line, index) => {
    let match;
    while ((match = mdLinkRegex.exec(line)) !== null) {
      const url = match[2];
      if (url.startsWith("http://") || url.startsWith("https://")) {
        continue;
      }
      links.push({
        target: url,
        source: filePath,
        line: index + 1,
      });
    }
  });

  return links;
}

function resolveTargetLink(basePath: string, link: string): string {
  if (link.startsWith("./")) {
    return path.join(path.dirname(basePath), link.slice(2));
  }
  if (link.startsWith("../")) {
    return path.join(path.dirname(basePath), link);
  }
  if (link.startsWith("#")) {
    return basePath;
  }
  return path.join(path.dirname(basePath), link);
}

describe("Documentation Links", () => {
  describe("README.md", () => {
    it("should exist", async () => {
      await expect(fs.access(README_PATH)).resolves.not.toThrow();
    });

    it("should have consistent distribution story (GitHub Releases)", async () => {
      const content = await fs.readFile(README_PATH, "utf-8");
      expect(content).toContain("GitHub Releases");
      expect(content).not.toContain("npm install -g @flowguard/core");
    });

    it("should have link to docs/installation.md", async () => {
      const content = await fs.readFile(README_PATH, "utf-8");
      expect(content).toContain("./docs/installation.md");
      expect(content).toContain("./docs/commands.md");
    });

    it("should have link to PRODUCT_IDENTITY.md", async () => {
      const content = await fs.readFile(README_PATH, "utf-8");
      expect(content).toContain("./PRODUCT_IDENTITY.md");
    });
  });

  describe("docs/index.md", () => {
    it("should exist", async () => {
      await expect(fs.access(DOCS_INDEX)).resolves.not.toThrow();
    });

    it("should have link to installation.md", async () => {
      const content = await fs.readFile(DOCS_INDEX, "utf-8");
      expect(content).toContain("./installation.md");
    });

    it("should have link to quick-start.md", async () => {
      const content = await fs.readFile(DOCS_INDEX, "utf-8");
      expect(content).toContain("./quick-start.md");
    });
  });

  describe("docs/installation.md", () => {
    it("should exist", async () => {
      await expect(fs.access(INSTALLATION_PATH)).resolves.not.toThrow();
    });

    it("should reference GitHub Releases", async () => {
      const content = await fs.readFile(INSTALLATION_PATH, "utf-8");
      expect(content).toContain("GitHub Releases");
    });

    it("should not suggest public npm install", async () => {
      const content = await fs.readFile(INSTALLATION_PATH, "utf-8");
      expect(content).not.toContain("npm install -g @flowguard/core");
    });

    it("should document commands correctly", async () => {
      const content = await fs.readFile(INSTALLATION_PATH, "utf-8");
      expect(content).toContain("/hydrate");
      expect(content).toContain("/ticket");
      expect(content).toContain("/plan");
    });
  });

  describe("docs/commands.md", () => {
    it("should exist", async () => {
      await expect(fs.access(COMMANDS_PATH)).resolves.not.toThrow();
    });

    it("should document Workflow Commands", async () => {
      const content = await fs.readFile(COMMANDS_PATH, "utf-8");
      expect(content).toContain("/hydrate");
      expect(content).toContain("/ticket");
      expect(content).toContain("/plan");
      expect(content).toContain("/implement");
      expect(content).toContain("/review-decision");
    });

    it("should document Operational Tools separately", async () => {
      const content = await fs.readFile(COMMANDS_PATH, "utf-8");
      expect(content).toContain("Operational Tools");
      expect(content).toContain("/archive");
    });

    it("should clarify /archive is not a workflow command", async () => {
      const content = await fs.readFile(COMMANDS_PATH, "utf-8");
      expect(content.toLowerCase()).toContain("operational");
      expect(content.toLowerCase()).toContain("artifact");
    });
  });

  describe("docs/quick-start.md", () => {
    it("should exist", async () => {
      await expect(fs.access(QUICKSTART_PATH)).resolves.not.toThrow();
    });

    it("should have quick getting started content", async () => {
      const content = await fs.readFile(QUICKSTART_PATH, "utf-8");
      expect(content).toContain("/hydrate");
      expect(content).toContain("/ticket");
    });

    it("should link to GitHub Releases for installation", async () => {
      const content = await fs.readFile(QUICKSTART_PATH, "utf-8");
      expect(content).toContain("GitHub Releases");
    });
  });

  describe("Distribution Consistency", () => {
    it("README should not reference public npm registry", async () => {
      const content = await fs.readFile(README_PATH, "utf-8");
      expect(content).not.toContain("@flowguard/core");
      expect(content).not.toContain("npmjs.com");
    });

    it("docs/installation.md should reference GitHub Releases", async () => {
      const content = await fs.readFile(INSTALLATION_PATH, "utf-8");
      expect(content).toContain("GitHub Releases");
    });

    it("docs/profiles.md should not suggest public npm install", async () => {
      const content = await fs.readFile(PROFILES_PATH, "utf-8");
      expect(content).not.toContain("npm install -g @flowguard/core");
      expect(content).not.toContain("npx @flowguard/core");
    });

    it("docs/archive.md should not suggest public npm install", async () => {
      const content = await fs.readFile(ARCHIVE_PATH, "utf-8");
      expect(content).not.toContain("npm install -g @flowguard/core");
      expect(content).not.toContain("npx @flowguard/core");
    });

    it("docs/profiles.md import examples should reference installation docs", async () => {
      const content = await fs.readFile(PROFILES_PATH, "utf-8");
      const hasImport = content.includes("from '@flowguard/core'");
      if (hasImport) {
        expect(content).toContain("see docs/installation.md");
      }
    });

    it("docs/archive.md import examples should reference installation docs", async () => {
      const content = await fs.readFile(ARCHIVE_PATH, "utf-8");
      const hasImport = content.includes("from '@flowguard/core'");
      if (hasImport) {
        expect(content).toContain("see docs/installation.md");
      }
    });

    it("All documentation should use consistent command syntax", async () => {
      const files = [
        path.join(PROJECT_ROOT, "README.md"),
        path.join(PROJECT_ROOT, "docs/index.md"),
        path.join(PROJECT_ROOT, "docs/commands.md"),
        path.join(PROJECT_ROOT, "docs/installation.md"),
      ];

      for (const file of files) {
        const content = await fs.readFile(file, "utf-8");
        expect(content).toMatch(/\/hydrate/);
      }
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty documentation gracefully", async () => {
      const content = await fs.readFile(README_PATH, "utf-8");
      expect(content.length).toBeGreaterThan(100);
    });

    it("should not have broken relative links", async () => {
      const files = [
        path.join(PROJECT_ROOT, "README.md"),
        path.join(PROJECT_ROOT, "docs/index.md"),
        path.join(PROJECT_ROOT, "docs/commands.md"),
      ];

      const allLinks: Link[] = [];
      for (const file of files) {
        const content = await fs.readFile(file, "utf-8");
        allLinks.push(...extractLinks(content, file));
      }

      const brokenLinks: string[] = [];
      for (const link of allLinks) {
        if (link.target.startsWith("http")) continue;
        if (link.target.startsWith("#")) continue;

        const resolved = resolveTargetLink(link.source, link.target);
        const exists = await fs.access(resolved).then(() => true).catch(() => false);
        if (!exists) {
          brokenLinks.push(`${link.source}:${link.line} -> ${link.target}`);
        }
      }

      expect(brokenLinks, `Broken links found:\n${brokenLinks.join("\n")}`).toHaveLength(0);
    });
  });
});
