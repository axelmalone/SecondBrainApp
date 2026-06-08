import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Make an isolated temp vault dir for a test; returns its absolute path. */
export async function makeTempVault(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "sb-vault-"));
}

/** Write a note file into a vault dir and return its absolute path. */
export async function writeNote(
  vault: string,
  name: string,
  content: string
): Promise<string> {
  const p = path.join(vault, name);
  await fs.writeFile(p, content, "utf8");
  return p;
}

export async function readFile(p: string): Promise<string> {
  return fs.readFile(p, "utf8");
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}
