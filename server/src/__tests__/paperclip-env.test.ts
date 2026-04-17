import { afterEach, describe, expect, it } from "vitest";
import { buildPaperclipEnv, runChildProcess } from "../adapters/utils.js";

const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;
const ORIGINAL_HOST = process.env.HOST;
const ORIGINAL_PORT = process.env.PORT;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

  if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
  else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

  if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
  else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;

  if (ORIGINAL_HOST === undefined) delete process.env.HOST;
  else process.env.HOST = ORIGINAL_HOST;

  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
});

describe("buildPaperclipEnv", () => {
  it("prefers an explicit PAPERCLIP_API_URL", () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:4100");
  });

  it("uses runtime listen host/port when explicit URL is not set", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";
    process.env.PORT = "3100";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3101");
  });

  it("formats IPv6 hosts safely in fallback URL generation", () => {
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "::1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://[::1]:3101");
  });
});

/**
 * scrubFromInheritedEnv: simulates what heartbeat does for an agent that
 * does NOT have an env_ref binding for a system-wide managed var. The
 * subprocess should NOT see the value from the parent process.env.
 *
 * For an agent that DOES bind it via env_ref, the value lands in opts.env
 * and survives the merge — scrub only strips from process.env inheritance.
 */
describe("runChildProcess scrubFromInheritedEnv", () => {
  const SENSITIVE_VAR = "TEST_PAPERCLIP_SCRUB_ANTHROPIC_API_KEY";
  const ORIGINAL = process.env[SENSITIVE_VAR];

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[SENSITIVE_VAR];
    else process.env[SENSITIVE_VAR] = ORIGINAL;
  });

  async function runEcho(
    env: Record<string, string>,
    scrubFromInheritedEnv: string[] | undefined,
  ): Promise<string> {
    let out = "";
    const result = await runChildProcess(
      `scrub-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      process.execPath,
      [
        "-e",
        `process.stdout.write(String(process.env.${SENSITIVE_VAR} ?? "__UNSET__"));`,
      ],
      {
        cwd: process.cwd(),
        env,
        timeoutSec: 20,
        graceSec: 2,
        onLog: async (stream, chunk) => {
          if (stream === "stdout") out += chunk;
        },
        scrubFromInheritedEnv,
      },
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    return out;
  }

  it("agent B (no env_ref binding) does not inherit the scrubbed var", async () => {
    process.env[SENSITIVE_VAR] = "real-key-from-parent";
    const out = await runEcho({}, [SENSITIVE_VAR]);
    expect(out).toBe("__UNSET__");
  });

  it("agent A (with env_ref binding) still gets the value via opts.env", async () => {
    process.env[SENSITIVE_VAR] = "real-key-from-parent";
    // Simulates heartbeat putting the resolved env_ref value into opts.env
    // while scrub list is empty (this agent binds it, so it's not scrubbed).
    const out = await runEcho({ [SENSITIVE_VAR]: "real-key-from-parent" }, []);
    expect(out).toBe("real-key-from-parent");
  });

  it("scrub does not strip values explicitly set in opts.env", async () => {
    process.env[SENSITIVE_VAR] = "parent-value";
    // Even if scrub list names the var, opts.env takes precedence —
    // scrub only affects inheritance.
    const out = await runEcho({ [SENSITIVE_VAR]: "adapter-provided-value" }, [SENSITIVE_VAR]);
    expect(out).toBe("adapter-provided-value");
  });

  it("is a no-op when scrubFromInheritedEnv is empty/undefined", async () => {
    process.env[SENSITIVE_VAR] = "inherited";
    const out = await runEcho({}, undefined);
    expect(out).toBe("inherited");
  });
});
