#!/usr/bin/env -S deno run -A
/**
 * Release helper script.
 * Usage:
 *   deno run -A scripts/release.ts <new-version> [--tag]
 * Example:
 *   deno run -A scripts/release.ts 0.1.1 --tag
 *
 * Performs:
 * 1. Validates semantic version.
 * 2. Updates package.json version field.
 * 3. Generates simple CHANGELOG snippet from recent commits.
 * 4. Creates annotated git tag (if --tag provided).
 */

const [versionArg, ...rest] = Deno.args;
if (!versionArg) {
  console.error("Usage: release <version> [--tag]");
  Deno.exit(1);
}

const shouldTag = rest.includes("--tag");

function isSemVer(v: string) {
  return /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v);
}

const normalized = versionArg.startsWith("v") ? versionArg.slice(1) : versionArg;
if (!isSemVer(normalized)) {
  console.error("Invalid semantic version:", versionArg);
  Deno.exit(1);
}

// Update package.json
const pkgPath = "package.json";
const pkgText = await Deno.readTextFile(pkgPath);
type PackageJson = { name?: string; version?: string; [k: string]: unknown };
const pkg: PackageJson = JSON.parse(pkgText);
const oldVersion = pkg.version ?? "0.0.0";
pkg.version = normalized;
await Deno.writeTextFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Gather recent commits (exclude merges, limit 20)
const gitLog = new TextDecoder().decode(
  await new Deno.Command("git", { args: ["log", "--oneline", "-n", "20"] }).output().then(r => r.stdout)
);
const commits = gitLog.trim().split(/\n+/).map(line => line.replace(/^([0-9a-f]+) /, "")).filter(c => !c.startsWith("Merge"));

const changes = commits.map(c => `- ${c}`).join("\n");
const releaseNotes = `Release v${normalized}\n\nUpdated version: ${oldVersion} -> ${normalized}\n\nChanges (last 20 commits):\n${changes}\n`;

await Deno.writeTextFile(`RELEASE_NOTES_v${normalized}.md`, releaseNotes);
console.log(`Generated RELEASE_NOTES_v${normalized}.md`);

if (shouldTag) {
  const tagName = `v${normalized}`;
  // Create annotated tag
  const tagResult = await new Deno.Command("git", { args: ["tag", "-a", tagName, "-m", `Release ${tagName}`] }).spawn().status;
  if (!tagResult.success) {
    console.error("Failed to create tag", tagName);
    Deno.exit(1);
  }
  console.log("Created tag", tagName);
  const pushStatus = await new Deno.Command("git", { args: ["push", "origin", tagName] }).spawn().status;
  if (!pushStatus.success) {
    console.error("Failed to push tag", tagName);
    Deno.exit(1);
  }
  console.log("Pushed tag", tagName, "-- GitHub Actions should now build release artifacts.");
}

console.log("Done.");
