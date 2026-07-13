import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];

type ModelsConfig = {
  providers?: Record<string, ProviderConfig>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelsConfigPath = join(__dirname, "..", "config", "models.json");

export default function (pi: ExtensionAPI) {
  const config = JSON.parse(readFileSync(modelsConfigPath, "utf8")) as ModelsConfig;

  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    pi.registerProvider(name, provider);
  }
}
