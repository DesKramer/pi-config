import {
	buildSessionContext,
	type ExtensionAPI,
	type SessionContext,
} from "@earendil-works/pi-coding-agent";

type Message = SessionContext["messages"][number];
const RETRY_MESSAGE_TYPE = "deskramer-retry";

function isRetryMessage(message: Message): boolean {
	return message.role === "custom" && message.customType === RETRY_MESSAGE_TYPE;
}

export default function retry(pi: ExtensionAPI) {
	// The public extension API has no continue() method. A hidden custom message
	// starts a turn without replaying user input or completed tools. Strip that
	// marker and the failed responses it retries before sending model context.
	pi.on("context", (event) => {
		const messages: Message[] = [];
		for (const message of event.messages) {
			if (isRetryMessage(message)) {
				while (messages.length > 0) {
					const last = messages.at(-1)!;
					if (last.role !== "assistant" || last.stopReason !== "error") break;
					messages.pop();
				}
			} else {
				messages.push(message);
			}
		}
		return { messages };
	});

	pi.registerCommand("retry", {
		description: "Retry the last failed model request without replaying completed tools",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /retry", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Pi is still working or has queued messages. Run /retry after it stops.", "warning");
				return;
			}

			// Read the active branch on each invocation, including compacted context.
			// This also works after /reload, /resume, and /tree without cached state.
			const { messages } = buildSessionContext(ctx.sessionManager.getBranch());
			const last = messages.findLast((message) =>
				!isRetryMessage(message)
				&& !(message.role === "bashExecution" && message.excludeFromContext),
			);
			if (last?.role !== "assistant" || last.stopReason !== "error") {
				ctx.ui.notify("No failed model request to retry at the end of this branch.", "warning");
				return;
			}

			pi.sendMessage({
				customType: RETRY_MESSAGE_TYPE,
				content: [],
				display: false,
			}, { triggerTurn: true });
			ctx.ui.notify("Retrying the last failed request.", "info");
		},
	});
}
