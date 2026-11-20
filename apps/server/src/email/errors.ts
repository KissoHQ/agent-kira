// A refusal of the mail server that will not change by waiting: a reply code 5xx (RFC 5321, 4.2.1)
// to the recipient or to the message itself, such as an address that does not exist or a message
// refused as spam. 503 only says the commands came in the wrong order. A refusal of the sign-in of
// the agent is not one of them: it is fixed in the configuration, and the answers then go out.
const permanentCommands = new Set(["RCPT TO", "DATA"]);

export function isPermanentSmtpError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("responseCode" in error) ||
    !("command" in error)
  ) {
    return false;
  }
  const { responseCode, command } = error;
  return (
    typeof responseCode === "number" &&
    responseCode >= 500 &&
    responseCode < 600 &&
    responseCode !== 503 &&
    typeof command === "string" &&
    permanentCommands.has(command)
  );
}
