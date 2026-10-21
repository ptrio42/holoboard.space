import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const files = await readdir("test").catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
const tests = files.filter((file) => file.endsWith(".test.ts")).sort();
if (tests.length === 0) {
  console.log(`${process.env.npm_package_name}: no behavioral tests yet (scaffolding only).`);
} else {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", "--test", "--test-concurrency=1", ...tests.map((file) => `test/${file}`),
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
