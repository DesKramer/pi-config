import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

const PROVIDER_LABELS: Record<string, string> = {
	"azure-openai-responses": "Azure OpenAI",
};

function providerLabel(ctx: ExtensionCommandContext, provider: string): string {
	return PROVIDER_LABELS[provider] ?? ctx.modelRegistry.getProviderDisplayName(provider);
}

function modelLabel(model: Model<any>, current: Model<any> | undefined): string {
	const selected = current?.provider === model.provider && current.id === model.id;
	const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
	return `${selected ? "✓ " : "  "}${model.id}${name}`;
}

async function chooseModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	availableModels: Model<any>[],
	initialProvider?: string,
): Promise<void> {
	let provider = initialProvider;

	while (true) {
		if (!provider) {
			const providers = [...new Set(availableModels.map((model) => model.provider))].sort((a, b) => {
				const aCurrent = a === ctx.model?.provider;
				const bCurrent = b === ctx.model?.provider;
				if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
				return providerLabel(ctx, a).localeCompare(providerLabel(ctx, b));
			});
			const choices = providers.map((id) => {
				const count = availableModels.filter((model) => model.provider === id).length;
				const current = id === ctx.model?.provider ? "✓ " : "  ";
				return `${current}${providerLabel(ctx, id)} [${id}] — ${count} model${count === 1 ? "" : "s"}`;
			});
			const choice = await ctx.ui.select("Select model provider", choices);
			if (!choice) return;
			provider = providers[choices.indexOf(choice)];
			if (!provider) return;
		}

		const models = availableModels
			.filter((model) => model.provider === provider)
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0) {
			ctx.ui.notify(`No available models for ${providerLabel(ctx, provider)}.`, "warning");
			provider = undefined;
			continue;
		}

		const choices = [
			...models.map((model) => modelLabel(model, ctx.model)),
			"← Back to providers",
		];
		const choice = await ctx.ui.select(`${providerLabel(ctx, provider)} models`, choices);
		if (!choice) return;
		if (choice === "← Back to providers") {
			provider = undefined;
			continue;
		}

		const model = models[choices.indexOf(choice)];
		if (!model) return;
		const success = await pi.setModel(model);
		if (!success) {
			ctx.ui.notify(`No API key available for ${model.provider}/${model.id}.`, "error");
			return;
		}
		ctx.ui.notify(`Model: ${model.provider}/${model.id}`, "info");
		return;
	}
}

export default function providerModelPicker(pi: ExtensionAPI): void {
	pi.registerCommand("model", {
		description: "Select a provider first, then choose one of that provider's models",
		handler: async (args, ctx) => {
			ctx.modelRegistry.refresh();
			const availableModels = await ctx.modelRegistry.getAvailable();
			if (availableModels.length === 0) {
				ctx.ui.notify("No models available. Configure provider authentication first.", "warning");
				return;
			}

			const query = args.trim().toLowerCase();
			if (!query) {
				await chooseModel(pi, ctx, availableModels);
				return;
			}

			const exactModels = availableModels.filter((model) =>
				model.id.toLowerCase() === query || `${model.provider}/${model.id}`.toLowerCase() === query,
			);
			if (exactModels.length === 1) {
				const success = await pi.setModel(exactModels[0]);
				ctx.ui.notify(
					success ? `Model: ${exactModels[0].provider}/${exactModels[0].id}` : `No API key available for ${exactModels[0].provider}/${exactModels[0].id}.`,
					success ? "info" : "error",
				);
				return;
			}

			const exactProvider = [...new Set(availableModels.map((model) => model.provider))]
				.find((provider) => provider.toLowerCase() === query || providerLabel(ctx, provider).toLowerCase() === query);
			if (exactProvider) {
				await chooseModel(pi, ctx, availableModels, exactProvider);
				return;
			}

			const filtered = availableModels.filter((model) =>
				model.id.toLowerCase().includes(query) ||
				model.name?.toLowerCase().includes(query) ||
				model.provider.toLowerCase().includes(query) ||
				providerLabel(ctx, model.provider).toLowerCase().includes(query),
			);
			if (filtered.length === 0) {
				ctx.ui.notify(`No models match “${args.trim()}”.`, "warning");
				return;
			}
			await chooseModel(pi, ctx, filtered, [...new Set(filtered.map((model) => model.provider))].length === 1 ? filtered[0].provider : undefined);
		},
	});
}
