import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

// Tests already require Pi; reuse its TypeScript loader without adding dependencies.
const piPath = process.env.PI_BIN || execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const require = createRequire(realpathSync(piPath));
const { createJiti } = require("jiti");
export const loadTypeScript = createJiti(import.meta.url).import;
