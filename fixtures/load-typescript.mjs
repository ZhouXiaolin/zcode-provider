import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

// Tests already require Pi; reuse its TypeScript loader without adding dependencies.
const piPath = execFileSync("which", [process.env.PI_BIN || "pi"], { encoding: "utf8" }).trim();
const require = createRequire(realpathSync(piPath));
const { createJiti } = require("jiti");
export const loadTypeScript = createJiti(import.meta.url).import;
