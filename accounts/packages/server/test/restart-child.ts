import { createAccountServer } from "../src/index.ts";
import type { AccountServerConfiguration, AccountMail } from "../src/index.ts";

process.once("message", async (input: { config: AccountServerConfiguration; cookie: string; template: unknown }) => {
  let app: ReturnType<typeof createAccountServer> | undefined;
  try {
    const messages: AccountMail[] = [];
    app = createAccountServer({ ...input.config, mail: { send: async (message) => { messages.push(message); } } });
    await app.ready();
    await app.mailOutbox!.drain();
    const signed = await app.handler(new Request(`${input.config.baseURL}/v1/identity/sign`, { method: "POST", headers: {
      origin: input.config.trustedOrigins[0]!, cookie: input.cookie, "content-type": "application/json",
    }, body: JSON.stringify({ template: input.template }) }));
    const result = { pid: process.pid, messages, status: signed.status, signed: await signed.json() };
    await new Promise<void>((resolve, reject) => process.send!(result, (error: Error | null) => error ? reject(error) : resolve()));
  } catch { process.exitCode = 1; }
  finally { app?.close(); process.disconnect(); }
});
