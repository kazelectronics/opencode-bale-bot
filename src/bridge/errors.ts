import { errorMessage } from "../logger.js";
import { OpenCodeError } from "../opencode/client.js";
import { truncate } from "../util.js";

/**
 * Turn an OpenCode failure into one short sentence a phone user can act on.
 * Raw provider envelopes are deliberately hidden.
 */
export function describeOpenCodeError(error: unknown): string {
  if (!(error instanceof OpenCodeError)) {
    return truncate(errorMessage(error).replace(/\s+/g, " ").trim(), 300);
  }

  const tag = error.tag ?? "";
  const message = error.message.replace(/\s+/g, " ").trim();

  if (error.status === 0) {
    return "OpenCode is not reachable. Start the server and try again.";
  }
  if (error.status === 401) {
    return "OpenCode rejected the credentials. Check OPENCODE_PASSWORD.";
  }
  if (error.status === 403 || /region/i.test(tag) || /region/i.test(message)) {
    return "The selected model is not available in this region. Pick another with /model.";
  }
  if (error.status === 404) {
    return "The requested object no longer exists.";
  }
  if (error.status === 429) {
    return "OpenCode is rate limiting requests. Try again in a moment.";
  }
  if (tag === "FormAlreadySettledError") {
    return "This form was already answered or cancelled.";
  }
  if (tag === "FormInvalidAnswerError") {
    return message.replace(/^External form field must be acknowledged:\s*/i, "Acknowledge the external field: ");
  }
  if (tag === "SessionBusyError") {
    return "The session is busy; wait for the current run to finish.";
  }
  if (message.length > 0 && message !== `OpenCode request failed with HTTP ${error.status}`) {
    return truncate(message, 300);
  }
  return `OpenCode request failed with HTTP ${error.status}.`;
}

export function describeError(error: unknown): string {
  return error instanceof OpenCodeError ? describeOpenCodeError(error) : errorMessage(error);
}