/** An error whose message is safe and meant to be shown to the MCP client. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
