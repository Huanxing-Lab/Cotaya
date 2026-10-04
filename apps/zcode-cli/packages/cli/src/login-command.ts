import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv, type CliEnv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";

export type LoginProviderId = "bigmodel" | "openai" | "zai";

const LOGIN_PROVIDER_IDS: readonly LoginProviderId[] = ["bigmodel", "openai", "zai"];

export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  noBrowser: boolean,
  args: readonly string[] = [],
): Promise<number> {
  try {
    const providerId = args[0] ?? "zai";
    if (args.length > 1 || !LOGIN_PROVIDER_IDS.includes(providerId as LoginProviderId)) {
      throw new Error("Usage: zcode login [zai|bigmodel|openai] [--no-browser]");
    }
    const loginProviderId = providerId as LoginProviderId;
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const result =
      loginProviderId === "openai"
        ? await runOpenAILogin(ctx, options, deps, env, noBrowser)
        : await runZaiDomainLogin(ctx, options, deps, env, noBrowser, loginProviderId);

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "ready",
          provider: result.providerId,
          user: {
            user_id: result.user.user_id,
            ...(result.user.email ? { email: result.user.email } : {}),
            ...(result.user.name ? { name: result.user.name } : {}),
            ...(result.user.avatar ? { avatar: result.user.avatar } : {}),
          },
          model: result.model,
          credentialsPath: result.credentialsPath,
          configPath: result.configPath,
          browserOpened: result.browser?.opened ?? false,
          ...(result.method ? { method: result.method } : {}),
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      [
        `Login successful${formatUserLabel(result.user)}.`,
        `Model: ${result.model}`,
        `Credentials: ${result.credentialsPath}`,
        `Model selection: ${result.configPath}`,
      ].join("\n") + "\n",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

interface CliLoginResult {
  browser?: { opened: boolean; reason?: string };
  configPath: string;
  credentialsPath: string;
  method?: "loopback" | "device-code";
  model: string;
  providerId: LoginProviderId;
  user: { avatar?: string; email?: string; name?: string; user_id: string };
}

async function runZaiDomainLogin(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  env: CliEnv,
  noBrowser: boolean,
  providerId: "bigmodel" | "zai",
): Promise<CliLoginResult> {
  const login = deps.loginZCodeCli ?? (await loadBootstrapModule()).loginZCodeCli;
  const result = await login({
    env,
    noBrowser,
    providerId,
    onAuthorizeUrl: (data) => {
      writeAuthorizeUrl(ctx, options, data.authorize_url, noBrowser, providerId);
    },
    onBrowserOpen: (browser) => {
      if (!options.json && !browser.opened) {
        ctx.stdout.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
      }
    },
  });
  return { ...result, providerId };
}

async function runOpenAILogin(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  env: CliEnv,
  noBrowser: boolean,
): Promise<CliLoginResult> {
  const login = deps.loginOpenAICli ?? (await loadBootstrapModule()).loginOpenAICli;
  const result = await login({
    env,
    noBrowser,
    onAuthorizeUrl: (authorizeUrl) => {
      writeAuthorizeUrl(ctx, options, authorizeUrl, noBrowser, "openai");
    },
    // 设备码 fallback：userCode 必须展示给用户（json 模式走 stderr，保持 stdout 纯 JSON）。
    onDeviceCode: (data) => {
      const target = options.json ? ctx.stderr : ctx.stdout;
      target.write(
        [
          "Switched to OpenAI device code flow (loopback port unavailable or no browser).",
          `Open ${data.inputPageUrl} and enter this code:`,
          `  ${data.userCode}`,
        ].join("\n") + "\n",
      );
    },
    onBrowserOpen: (browser) => {
      if (!options.json && !browser.opened) {
        ctx.stdout.write(`Browser open failed: ${browser.reason ?? "unknown error"}\n`);
      }
    },
  });
  return { ...result, providerId: "openai" };
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const workingDirectory = (deps.cwd ?? process.cwd)();
    const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
      cwd: workingDirectory,
      env,
    });

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const logout = deps.logoutZCodeCli ?? (await loadBootstrapModule()).logoutZCodeCli;
    const result = await logout({ env });

    if (options.json) {
      ctx.stdout.write(
        formatJson({
          status: "logged_out",
          provider: "zai",
          credentialsPath: result.credentialsPath,
        }),
      );
      return 0;
    }

    ctx.stdout.write(
      `Logged out from Coding Plan accounts. Credentials: ${result.credentialsPath}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
}

function writeAuthorizeUrl(
  ctx: RunContext,
  options: GlobalOptions,
  authorizeUrl: string,
  noBrowser: boolean,
  providerId: LoginProviderId,
): void {
  const target = options.json ? ctx.stderr : ctx.stdout;
  if (noBrowser) {
    target.write(`Open this URL to sign in:\n${authorizeUrl}\n`);
    return;
  }

  target.write(
    `Opening browser for ${loginProviderDisplayName(providerId)} authorization.\nFallback URL:\n${authorizeUrl}\n`,
  );
}

function loginProviderDisplayName(providerId: LoginProviderId): string {
  if (providerId === "bigmodel") return "BigModel";
  if (providerId === "openai") return "OpenAI";
  return "Z.AI";
}

function formatUserLabel(user: { email?: string; name?: string; user_id: string }): string {
  const label = user.name || user.email || user.user_id;
  return label ? ` as ${label}` : "";
}
