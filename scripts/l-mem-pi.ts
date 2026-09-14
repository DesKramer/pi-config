import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPatchedPi, installedPi } from "../extensions/l-mem/host-patch.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.L_MEM_PI_RUNTIME ?? resolve(root, "node_modules/.cache/l-mem/pi-0.85.1-v3");
buildPatchedPi(installedPi(), target);
// All ordinary pi CLI arguments and modes remain available. The extension still
// owns off/shadow/enable/experimental controls; the launcher only installs the host binding.
await import(pathToFileURL(resolve(target, "dist/cli.js")).href);
