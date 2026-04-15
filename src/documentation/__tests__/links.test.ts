/**
 * @module documentation/links
 * @description Tests for documentation link consistency and delivery scope.
 *
 * Ensures all documentation links are valid and consistent:
 * - All referenced files exist
 * - No broken links
 * - Consistent distribution story
 * - Delivery scope is clearly documented
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
const PRODUCT_IDENTITY_PATH = path.join(PROJECT_ROOT, "PRODUCT_IDENTITY.md");
const DISTRIBUTION_MODEL_PATH = path.join(PROJECT_ROOT, "docs/distribution-model.md");
const DELIVERY_SCOPE_PATH = path.join(PROJECT_ROOT, "docs/delivery-scope.md");
const SUPPORT_MODEL_PATH = path.join(PROJECT_ROOT, "docs/support-model.md");

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

describe("PRODUCT_IDENTITY.md", () => {
  describe("HAPPY", () => {
    it("file should exist", async () => {
      await expect(fs.access(PRODUCT_IDENTITY_PATH)).resolves.not.toThrow();
    });

    it("should contain Distribution Model section", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content).toContain("### Distribution Model");
    });

    it("should reference Option A1", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content).toContain("Option A1");
    });

    it("should mention pre-built proprietary artifact", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content.toLowerCase()).toContain("pre-built");
      expect(content.toLowerCase()).toContain("proprietary");
    });

    it("should mention file:-based dependencies", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content).toContain("file:");
    });

    it("should not contain outdated 'source code' language", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content).not.toContain("source code");
    });

    it("should reference flowguard-core-{version}.tgz", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content).toContain("flowguard-core-");
      expect(content).toContain(".tgz");
    });
  });

  describe("BAD", () => {
    it("should not have empty Distribution Model section", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      const distSection = content.split("### Distribution Model")[1]?.split("###")[0] || "";
      expect(distSection.length).toBeGreaterThan(100);
    });
  });

  describe("DELIVERY_SCOPE", () => {
    it("should document technically enforced properties", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content.toLowerCase()).toContain("fail-closed");
      const hasHashChain = content.toLowerCase().includes("hash-chain") || content.toLowerCase().includes("hash chain");
      expect(hasHashChain).toBe(true);
    });

    it("should document limitations and caveats", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content).toContain("Limitations and Caveats");
    });

    it("should not claim compliance IS certified", async () => {
      const content = await fs.readFile(PRODUCT_IDENTITY_PATH, "utf-8");
      expect(content.toLowerCase()).not.toContain("flowguard is compliance certified");
      expect(content.toLowerCase()).not.toContain("certified compliant");
    });
  });
});

describe("docs/distribution-model.md", () => {
  describe("HAPPY", () => {
    it("file should exist", async () => {
      await expect(fs.access(DISTRIBUTION_MODEL_PATH)).resolves.not.toThrow();
    });

    it("should document Option A1 distribution model", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).toContain("Option A1");
    });

    it("should document artifact contents", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).toContain("Artifact Contents");
      expect(content).toContain("CLI");
      expect(content).toContain("Core");
      expect(content).toContain("Integration");
    });

    it("should document installation flow", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).toContain("Installation Flow");
      expect(content).toContain("--core-tarball");
    });

    it("should document offline compatibility", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content.toLowerCase()).toContain("offline");
      expect(content.toLowerCase()).toContain("air-gap");
    });

    it("should document upgrade and rollback", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content.toLowerCase()).toContain("upgrade");
      expect(content.toLowerCase()).toContain("rollback");
    });

    it("should document customer responsibilities", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).toContain("Customer Responsibilities");
    });
  });

  describe("BAD", () => {
    it("should not suggest npm registry installation", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).not.toContain("npm install -g @flowguard/core");
      expect(content).not.toContain("npm install @flowguard/core");
    });

    it("should not claim network calls at runtime", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content.toLowerCase()).not.toContain("network call");
    });
  });

  describe("CORNER", () => {
    it("should document integrity verification mechanisms", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).toContain("SHA-256");
      expect(content).toContain("checksum");
    });

    it("should document file:-based dependency model", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).toContain("file:");
      expect(content).toContain("vendor/");
    });
  });

  describe("EDGE", () => {
    it("should handle air-gapped scenario documentation", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content.toLowerCase()).toContain("air-gapped");
      expect(content).toContain("USB");
    });
  });

  describe("DELIVERY_SCOPE", () => {
    it("should have delivery scope table", async () => {
      const content = await fs.readFile(DISTRIBUTION_MODEL_PATH, "utf-8");
      expect(content).toContain("Delivery Scope");
      expect(content).toContain("Technically Enforced");
      expect(content).toContain("Currently Delivered");
      expect(content).toContain("Optional");
      expect(content).toContain("Not Covered");
      expect(content).toContain("Customer Responsibility");
    });
  });
});

describe("docs/delivery-scope.md", () => {
  describe("HAPPY", () => {
    it("file should exist", async () => {
      await expect(fs.access(DELIVERY_SCOPE_PATH)).resolves.not.toThrow();
    });

    it("should define scope categories", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content).toContain("Technically Enforced");
      expect(content).toContain("Currently Delivered");
      expect(content).toContain("Optional");
      expect(content).toContain("Not Covered");
      expect(content).toContain("Customer Responsibilities");
    });

    it("should document fail-closed enforcement", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content.toLowerCase()).toContain("fail-closed");
      expect(content.toLowerCase()).toContain("enforcement");
    });

    it("should document workflow engine features", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content).toContain("8 explicit phases");
      expect(content).toContain("3 policy modes");
      expect(content).toContain("4 built-in profiles");
    });

    it("should document audit & compliance features", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content).toContain("Hash-chained audit trail");
      expect(content).toContain("Compliance summary");
      expect(content).toContain("Four-eyes enforcement");
    });
  });

  describe("BAD", () => {
    it("should not claim compliance IS certified", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content.toLowerCase()).not.toContain("compliance certified");
      expect(content.toLowerCase()).not.toContain("certified compliant");
    });

    it("should not claim multi-user support exists", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content.toLowerCase()).not.toContain("multi-user support");
      expect(content.toLowerCase()).not.toContain("built-in multi-user");
    });

    it("should not claim CI/CD native integration exists", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content.toLowerCase()).not.toContain("ci-native integration");
      expect(content.toLowerCase()).not.toContain("built-in ci/cd");
    });
  });

  describe("CORNER", () => {
    it("should document Not Covered items clearly", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content).toContain("Not Covered");
      expect(content).toContain("Multi-user sessions");
      expect(content).toContain("CI/CD native integration");
      expect(content).toContain("Hosted / SaaS");
    });

    it("should document customer responsibilities", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content).toContain("Customer Responsibilities");
      expect(content).toContain("Security & Access Control");
      expect(content).toContain("Data Management");
      expect(content).toContain("Operations");
    });
  });

  describe("EDGE", () => {
    it("should document regulatory considerations table", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content).toContain("Regulatory Considerations");
      expect(content).toContain("What It Provides");
      expect(content).toContain("What It Does Not Provide");
    });

    it("should clarify audit trail provides building blocks only", async () => {
      const content = await fs.readFile(DELIVERY_SCOPE_PATH, "utf-8");
      expect(content).toContain("building blocks");
    });
  });
});

describe("docs/support-model.md", () => {
  describe("HAPPY", () => {
    it("should document responsibility matrix", async () => {
      const content = await fs.readFile(SUPPORT_MODEL_PATH, "utf-8");
      expect(content).toContain("Responsibility Matrix");
    });

    it("should document contact channels", async () => {
      const content = await fs.readFile(SUPPORT_MODEL_PATH, "utf-8");
      expect(content).toContain("Contact Channels");
    });

    it("should document response expectations", async () => {
      const content = await fs.readFile(SUPPORT_MODEL_PATH, "utf-8");
      expect(content).toContain("Response Expectations");
    });

    it("should clarify no SLA guarantees", async () => {
      const content = await fs.readFile(SUPPORT_MODEL_PATH, "utf-8");
      const hasNoSla = content.toLowerCase().includes("uptime sla") || content.toLowerCase().includes("contractual slas");
      expect(hasNoSla).toBe(true);
      expect(content.toLowerCase()).toContain("best-effort");
    });
  });

  describe("BAD", () => {
    it("should not claim contractual SLA guarantees", async () => {
      const content = await fs.readFile(SUPPORT_MODEL_PATH, "utf-8");
      expect(content.toLowerCase()).not.toContain("contractual sla guarantee");
      expect(content.toLowerCase()).not.toContain("guaranteed sla");
    });
  });
});
