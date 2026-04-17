import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secretService } from "../services/secrets.js";

type SelectResult = unknown[];

/**
 * Minimal drizzle-style db stub sufficient for secretService.
 * We only exercise code paths that don't hit resolveSecretValue (secret_ref)
 * in this test — env_ref and plain bindings don't touch the DB for values,
 * and getSystemEnvRefVarNames uses a single select().from().where() chain.
 */
function createDbStub(selectResults: SelectResult[]) {
  const pending = [...selectResults];
  const selectWhere = vi.fn(async () => pending.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));
  return {
    db: { select } as unknown as Parameters<typeof secretService>[0],
    selectWhere,
  };
}

const ORIGINAL_FOO = process.env.FOO_SRC;
const ORIGINAL_BAR = process.env.BAR_SRC;

beforeEach(() => {
  delete process.env.FOO_SRC;
  delete process.env.BAR_SRC;
});

afterEach(() => {
  if (ORIGINAL_FOO === undefined) delete process.env.FOO_SRC;
  else process.env.FOO_SRC = ORIGINAL_FOO;
  if (ORIGINAL_BAR === undefined) delete process.env.BAR_SRC;
  else process.env.BAR_SRC = ORIGINAL_BAR;
});

describe("secretService.resolveEnvBindings (env_ref)", () => {
  it("resolves env_ref to process.env value and reports envRefKeys/envRefVarNames", async () => {
    process.env.FOO_SRC = "real-secret-value";
    const { db } = createDbStub([]);
    const svc = secretService(db);
    const { env, secretKeys, envRefKeys, envRefVarNames } = await svc.resolveEnvBindings("company-1", {
      MY_KEY: { type: "env_ref", envVar: "FOO_SRC" },
    });
    expect(env.MY_KEY).toBe("real-secret-value");
    expect(secretKeys.size).toBe(0);
    expect([...envRefKeys]).toEqual(["MY_KEY"]);
    expect([...envRefVarNames]).toEqual(["FOO_SRC"]);
  });

  it("omits env_ref key when source var is unset (does NOT set empty string)", async () => {
    // FOO_SRC intentionally unset
    const { db } = createDbStub([]);
    const svc = secretService(db);
    const { env, envRefKeys, envRefVarNames } = await svc.resolveEnvBindings("company-1", {
      MY_KEY: { type: "env_ref", envVar: "FOO_SRC" },
    });
    expect("MY_KEY" in env).toBe(false);
    // Still tracked so scrub logic knows this key was bound.
    expect(envRefKeys.has("MY_KEY")).toBe(true);
    expect(envRefVarNames.has("FOO_SRC")).toBe(true);
  });

  it("omits env_ref key when source var is empty string", async () => {
    process.env.FOO_SRC = "";
    const { db } = createDbStub([]);
    const svc = secretService(db);
    const { env } = await svc.resolveEnvBindings("company-1", {
      MY_KEY: { type: "env_ref", envVar: "FOO_SRC" },
    });
    expect("MY_KEY" in env).toBe(false);
  });

  it("handles mixed binding types in a single config", async () => {
    process.env.FOO_SRC = "env-value";
    const { db } = createDbStub([]);
    const svc = secretService(db);
    const { env, envRefKeys, secretKeys } = await svc.resolveEnvBindings("company-1", {
      PLAIN_KEY: { type: "plain", value: "plain-value" },
      LEGACY_PLAIN: "legacy",
      REFD: { type: "env_ref", envVar: "FOO_SRC" },
    });
    expect(env.PLAIN_KEY).toBe("plain-value");
    expect(env.LEGACY_PLAIN).toBe("legacy");
    expect(env.REFD).toBe("env-value");
    expect(envRefKeys.has("REFD")).toBe(true);
    expect(secretKeys.size).toBe(0);
  });
});

describe("secretService.resolveAdapterConfigForRuntime (env_ref)", () => {
  it("resolves env_ref in adapter config and surfaces envRefVarNames", async () => {
    process.env.BAR_SRC = "cfg-value";
    const { db } = createDbStub([]);
    const svc = secretService(db);
    const { config, envRefKeys, envRefVarNames } = await svc.resolveAdapterConfigForRuntime(
      "company-1",
      {
        command: "claude",
        env: {
          ANTHROPIC_API_KEY: { type: "env_ref", envVar: "BAR_SRC" },
        },
      },
    );
    const env = config.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe("cfg-value");
    expect(envRefKeys.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(envRefVarNames.has("BAR_SRC")).toBe(true);
  });

  it("omits env_ref key in adapter config when source var is unset", async () => {
    const { db } = createDbStub([]);
    const svc = secretService(db);
    const { config } = await svc.resolveAdapterConfigForRuntime("company-1", {
      env: {
        MY_KEY: { type: "env_ref", envVar: "BAR_SRC" },
      },
    });
    const env = config.env as Record<string, string>;
    expect("MY_KEY" in env).toBe(false);
  });
});

describe("secretService.getSystemEnvRefVarNames", () => {
  it("unions envVar names across all agents' env_ref bindings", async () => {
    const { db } = createDbStub([
      [
        {
          adapterConfig: {
            env: {
              K1: { type: "env_ref", envVar: "VAR_A" },
              K2: { type: "plain", value: "x" },
            },
          },
        },
        {
          adapterConfig: {
            env: {
              K3: { type: "env_ref", envVar: "VAR_B" },
              K4: { type: "env_ref", envVar: "VAR_A" },
            },
          },
        },
        { adapterConfig: { env: {} } },
        { adapterConfig: null },
      ],
    ]);
    const svc = secretService(db);
    const names = await svc.getSystemEnvRefVarNames("company-1");
    expect([...names].sort()).toEqual(["VAR_A", "VAR_B"]);
  });

  it("returns an empty set when no agents use env_ref", async () => {
    const { db } = createDbStub([
      [
        { adapterConfig: { env: { X: { type: "plain", value: "y" } } } },
        { adapterConfig: {} },
      ],
    ]);
    const svc = secretService(db);
    const names = await svc.getSystemEnvRefVarNames("company-1");
    expect(names.size).toBe(0);
  });
});
