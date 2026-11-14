import type { OrchestrationV2MessageAuthor } from "@t3tools/contracts";

/**
 * What the agent reads for a user message. A teammate's words say who wrote them, so in a thread
 * several people use the agent knows whose request it is working on; the owner's go as written.
 * Slash commands go as written too: providers parse them from the start of the prompt.
 */
export const authoredText = (message: {
  readonly text: string;
  readonly author?: OrchestrationV2MessageAuthor | undefined;
}) =>
  message.author === undefined || message.text.trimStart().startsWith("/")
    ? message.text
    : `Message from teammate ${message.author.name}:\n\n${message.text}`;
