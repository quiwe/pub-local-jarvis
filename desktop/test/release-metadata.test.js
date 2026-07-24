"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(desktopRoot, "..");

test("release metadata references existing legal resources", () => {
  const packageJson = require("../package.json");
  const legalResources = packageJson.build.extraResources.filter(resource =>
    resource.to.startsWith("licenses/"),
  );

  assert.ok(legalResources.length > 0);
  for (const resource of legalResources) {
    const source = path.resolve(desktopRoot, resource.from);
    assert.ok(fs.existsSync(source), `missing release resource: ${resource.from}`);
  }

  const pyproject = fs.readFileSync(path.join(projectRoot, "pyproject.toml"), "utf8");
  assert.match(pyproject, /^\s*"\/THIRD_PARTY_NOTICES\.md",?\s*$/m);
  assert.ok(fs.existsSync(path.join(projectRoot, "THIRD_PARTY_NOTICES.md")));
});
