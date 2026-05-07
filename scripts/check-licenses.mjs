import { readFile } from "node:fs/promises";

const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const forbidden = /\b(A?GPL|LGPL)\b/i;
const allowedCopyleftExceptions = new Set();
const offenders = [];

for (const [path, meta] of Object.entries(lockfile.packages ?? {})) {
  if (!path || !path.startsWith("node_modules/")) continue;
  const license = String(meta.license ?? "");
  if (forbidden.test(license) && !allowedCopyleftExceptions.has(meta.name)) {
    offenders.push(`${path}: ${license || "unknown"}`);
  }
}

if (offenders.length > 0) {
  console.error("Forbidden copyleft licenses found in dependency tree:");
  for (const offender of offenders) console.error(`- ${offender}`);
  process.exit(1);
}

console.log("No AGPL/GPL/LGPL dependencies found in package-lock.json.");
