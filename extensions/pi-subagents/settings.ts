import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export const DEFAULT_AGENT_MODEL = "cosine/glm-5.2";
export const DEFAULT_AGENT_THINKING: ModelThinkingLevel = "medium";

export const ALL_MODEL_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface AgentSettingsSource {
	name: string;
	model?: string;
	thinking?: string;
}

export interface AgentSettingsOverride {
	model: string;
	thinking: ModelThinkingLevel;
}

export interface AgentEffectiveSettings extends AgentSettingsOverride {
	resolvedModel?: Model<Api>;
	supportedThinkingLevels: ModelThinkingLevel[];
}

const agentOverrides = new Map<string, AgentSettingsOverride>();
const userDisabledAgents = new Set<string>();
const temporaryAgentRestrictions = new Map<string, ReadonlySet<string>>();
const thinkingLevels = new Set<ModelThinkingLevel>(ALL_MODEL_THINKING_LEVELS);

export function canonicalModelRef(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function resolveModelRef(modelRef: string | undefined, models: readonly Model<Api>[]): Model<Api> | undefined {
	const ref = modelRef?.trim();
	if (!ref) return undefined;

	const canonical = models.find((model) => canonicalModelRef(model) === ref);
	if (canonical) return canonical;

	const bareMatches = models.filter((model) => model.id === ref);
	return bareMatches.length === 1 ? bareMatches[0] : undefined;
}

export function isModelThinkingLevel(value: string | undefined): value is ModelThinkingLevel {
	return !!value && thinkingLevels.has(value as ModelThinkingLevel);
}

export function normalizeThinkingLevel(
	value: string | undefined,
	fallback: ModelThinkingLevel = DEFAULT_AGENT_THINKING,
): ModelThinkingLevel {
	return isModelThinkingLevel(value) ? value : fallback;
}

export function coerceThinkingLevel(
	supported: readonly ModelThinkingLevel[],
	requested: ModelThinkingLevel,
): ModelThinkingLevel {
	if (supported.includes(requested)) return requested;
	if (supported.includes("off")) return "off";
	return supported[0] ?? "off";
}

export function getAgentOverride(agentName: string): AgentSettingsOverride | undefined {
	const override = agentOverrides.get(agentName);
	return override ? { ...override } : undefined;
}

export function setAgentOverride(agentName: string, override: AgentSettingsOverride): void {
	agentOverrides.set(agentName, { ...override });
}

export function clearAgentOverride(agentName: string): void {
	agentOverrides.delete(agentName);
}

export function clearAllAgentOverrides(): void {
	agentOverrides.clear();
}

export function isAgentUserEnabled(agentName: string): boolean {
	return !userDisabledAgents.has(agentName);
}

export function isAgentTemporarilyRestricted(agentName: string): boolean {
	for (const allowedAgents of temporaryAgentRestrictions.values()) {
		if (!allowedAgents.has(agentName)) return true;
	}
	return false;
}

/** Effective runtime availability: the user's choice intersected with temporary restrictions. */
export function isAgentEnabled(agentName: string): boolean {
	return isAgentUserEnabled(agentName) && !isAgentTemporarilyRestricted(agentName);
}

/** Update only the user's session-level availability choice. */
export function setAgentEnabled(agentName: string, enabled: boolean): void {
	if (enabled) userDisabledAgents.delete(agentName);
	else userDisabledAgents.add(agentName);
}

export function toggleAgentEnabled(agentName: string): boolean {
	const enabled = !isAgentUserEnabled(agentName);
	setAgentEnabled(agentName, enabled);
	return enabled;
}

export function setTemporaryAgentRestriction(owner: string, allowedAgents: readonly string[]): void {
	if (!owner.trim()) throw new Error("Temporary agent restriction owner must be non-empty.");
	temporaryAgentRestrictions.set(owner, new Set(allowedAgents));
}

export function clearTemporaryAgentRestriction(owner: string): void {
	temporaryAgentRestrictions.delete(owner);
}

export function clearAgentAvailabilityOverride(agentName: string): void {
	userDisabledAgents.delete(agentName);
}

export function clearAllAgentAvailabilityOverrides(): void {
	userDisabledAgents.clear();
	temporaryAgentRestrictions.clear();
}

export function resolveEffectiveAgentSettings(
	agent: AgentSettingsSource,
	models: readonly Model<Api>[],
): AgentEffectiveSettings {
	const override = getAgentOverride(agent.name);
	const rawModel = override?.model ?? agent.model ?? DEFAULT_AGENT_MODEL;
	const resolvedModel = resolveModelRef(rawModel, models);
	const model = resolvedModel ? canonicalModelRef(resolvedModel) : rawModel;
	const requestedThinking = override?.thinking ?? normalizeThinkingLevel(agent.thinking);
	const supportedThinkingLevels = resolvedModel
		? getSupportedThinkingLevels(resolvedModel)
		: [...ALL_MODEL_THINKING_LEVELS];
	const thinking = resolvedModel
		? coerceThinkingLevel(supportedThinkingLevels, requestedThinking)
		: requestedThinking;

	return {
		model,
		thinking,
		resolvedModel,
		supportedThinkingLevels: [...supportedThinkingLevels],
	};
}
