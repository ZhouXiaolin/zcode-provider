import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

export interface StartPlanLogin {
  family: "zai" | "bigmodel";
  token: string;
}

// ZCode's shared credential format; read-only, never copy decrypted values to disk.
export function readStartPlanLogin(directory: string, env = process.env): StartPlanLogin | undefined {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(readFileSync(join(directory, "credentials.json"), "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid credential record");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read ZCode login. Open ZCode Desktop and sign in again.");
  }
  const decrypt = (value: unknown): string => {
    if (typeof value !== "string") return "";
    if (!value.startsWith("enc:v1:")) return value.trim();
    try {
      let username = "unknown";
      try { username = userInfo().username; } catch { /* Matches ZCode's fallback. */ }
      const secret = env.ZCODE_CREDENTIAL_SECRET?.trim() ||
        `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
      const parts = value.slice(7).split(".");
      if (parts.length !== 3) throw new Error("Invalid credential format");
      const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64url"));
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid credential format");
      const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8").trim();
    } catch {
      throw new Error("Cannot decrypt ZCode login. Use the same ZCODE_CREDENTIAL_SECRET as Desktop.");
    }
  };
  const family = decrypt(record["oauth:active_provider"]);
  if (family !== "zai" && family !== "bigmodel") return undefined;
  const token = decrypt(record.zcodejwttoken);
  return token ? { family, token } : undefined;
}
