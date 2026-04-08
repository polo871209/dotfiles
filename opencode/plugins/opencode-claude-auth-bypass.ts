import type { Plugin } from "@opencode-ai/plugin"

const OPENCODE_PATTERNS = [
	/opencode/i,
	/anomalyco/i,
	/open\s*code/i,
]

function containsOpencode(text: string): boolean {
	return OPENCODE_PATTERNS.some((p) => p.test(text))
}

function scrubText(text: string): string {
	return text
		.replace(/https?:\/\/[^\s]*(?:opencode|anomalyco)[^\s]*/gi, "")
		.replace(/\bopencode\b/gi, "")
}

export const MyPlugin: Plugin = async () => {
	return {
		"experimental.chat.system.transform": async (input, output) => {
			if (input.model.providerID !== "anthropic") return
			for (let i = output.system.length - 1; i >= 0; i--) {
				if (containsOpencode(output.system[i])) {
					output.system.splice(i, 1)
				}
			}
		},
		"experimental.chat.messages.transform": async (_input, output) => {
			for (const msg of output.messages) {
				for (const part of msg.parts) {
					if (part.type === "text" && containsOpencode(part.text)) {
						part.text = scrubText(part.text)
					}
				}
			}
		},
	}
}

