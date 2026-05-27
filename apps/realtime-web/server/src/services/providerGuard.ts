import { z } from "zod";
import type { ProviderKey, SupportedProvider } from "../types.js";

const supportedProviders: SupportedProvider[] = ["openai", "anthropic", "gemini", "openrouter"];

const providerSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "openrouter"]),
  apiKey: z.string().min(12).max(300),
});

const providersSchema = z.array(providerSchema).max(8);

export function validateProviders(input: unknown): ProviderKey[] {
  const providers = providersSchema.parse(input);

  const unique = new Set<string>();
  for (const provider of providers) {
    const key = provider.provider;
    if (unique.has(key)) {
      throw new Error(`Duplicate provider key found for ${key}`);
    }
    unique.add(key);
  }

  return providers;
}

export function listSupportedProviders(): SupportedProvider[] {
  return supportedProviders;
}
