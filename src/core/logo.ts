import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import type { AtomicLaunchConfig } from "./types.js";

const MAX_LOGO_BYTES = 10 * 1024 * 1024;
const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
]);

export interface LocalLogoFile {
  path: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
}

interface ResolveLogoOptions {
  dryRun: boolean;
  pinataJwt: string;
  fetchImpl?: typeof fetch;
}

export function readLocalLogo(path: string): LocalLogoFile {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new Error(`Launch logo file does not exist: ${path}`);
  }
  if (!stats.isFile()) throw new Error(`Launch logo path is not a file: ${path}`);
  if (stats.size <= 0) throw new Error(`Launch logo file is empty: ${path}`);
  if (stats.size > MAX_LOGO_BYTES) {
    throw new Error(`Launch logo exceeds the 10 MB limit: ${path}`);
  }

  const extension = extname(path).toLowerCase();
  const mimeType = MIME_TYPES.get(extension);
  if (!mimeType) {
    throw new Error("Launch logo must be PNG, JPEG, GIF, WebP, or SVG");
  }
  const buffer = readFileSync(path);
  return {
    path,
    name: basename(path),
    mimeType,
    bytes: new Uint8Array(buffer),
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export function validateLaunchLogo(token: AtomicLaunchConfig["token"]): void {
  if (token.logoFile) readLocalLogo(token.logoFile);
}

export async function resolveLaunchLogo(
  token: AtomicLaunchConfig["token"],
  options: ResolveLogoOptions,
): Promise<string> {
  if (token.logo) return token.logo;
  if (!token.logoFile) throw new Error("Launch token has no logo source");
  const file = readLocalLogo(token.logoFile);

  // A dry run must remain side-effect free. The placeholder is accepted by the
  // contract simulation but is never used for a broadcast launch.
  if (options.dryRun) return `ipfs://dry-run-${file.sha256}`;

  const jwt = options.pinataJwt.trim();
  if (!jwt || jwt === "YOUR_PINATA_JWT") {
    throw new Error("PINATA_JWT is required when launch.token.logoFile is configured");
  }

  const form = new FormData();
  form.append("network", "public");
  form.append("name", file.name);
  form.append("file", new File([file.bytes], file.name, { type: file.mimeType }));
  const response = await (options.fetchImpl ?? fetch)(PINATA_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });

  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`Pinata logo upload failed (${response.status}): ${detail || response.statusText}`);
  }
  const payload = await response.json() as { data?: { cid?: unknown } };
  const cid = payload.data?.cid;
  if (typeof cid !== "string" || !/^[a-zA-Z0-9]{20,}$/.test(cid)) {
    throw new Error("Pinata logo upload returned an invalid CID");
  }
  return `ipfs://${cid}`;
}
