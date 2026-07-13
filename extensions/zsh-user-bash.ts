import { createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const zshOps = createLocalBashOperations({ shellPath: process.env.PI_USER_BASH_ZSH ?? "/bin/zsh" });

export default function zshUserBash(pi: ExtensionAPI) {
	pi.on("user_bash", () => ({ operations: zshOps }));
}
