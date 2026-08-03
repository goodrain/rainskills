import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type RainbondConfig = {
  token: string;
  url: string;
};

type ConfigInput = {
  env?: Record<string, string | undefined>;
  home?: string;
};

type PiApi = {
  on(name: string, handler: (...args: any[]) => any): void;
  registerTool(definition: Record<string, any>): void;
};

type McpClient = {
  connect(): Promise<void>;
  listTools(params?: { cursor?: string }): Promise<any>;
  callTool(request: Record<string, any>, schema?: unknown, options?: unknown): Promise<any>;
  close(): Promise<void>;
};

function decodeEnvValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'") {
    return value.slice(1, -1).replace(/'"'"'/g, "'");
  }
  if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') {
    return value.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
  }
  return value;
}

function readManagedEnv(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};

  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(RAINBOND_JWT|RAINBOND_URL)=(.*)$/);
    if (match) values[match[1]] = decodeEnvValue(match[2]);
  }
  return values;
}

export function readRainbondConfig(input: ConfigInput = {}): RainbondConfig | null {
  const env = input.env ?? process.env;
  const home = input.home ?? os.homedir();
  const stored = readManagedEnv(path.join(home, ".rainbond", "mcp.env"));
  const token = env.RAINBOND_JWT || stored.RAINBOND_JWT;
  const baseUrl = (env.RAINBOND_URL || stored.RAINBOND_URL || "").replace(/\/+$/, "");
  if (!token || !baseUrl || !/^https?:\/\//.test(baseUrl)) return null;

  return {
    token,
    url: `${baseUrl}/console/mcp/rainskills/pi/query`,
  };
}

export function publicConfig(config: RainbondConfig) {
  const parsed = new URL(config.url);
  return { origin: parsed.origin, endpoint: parsed.pathname };
}

export function toPiContent(result: any): Array<{ type: "text"; text: string }> {
  const content = Array.isArray(result?.content) ? result.content : [];
  if (content.length === 0) {
    return [{ type: "text", text: result?.isError ? "Rainbond MCP call failed." : "Done." }];
  }
  return content.map((item: any) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return { type: "text" as const, text: item.text };
    }
    return { type: "text" as const, text: JSON.stringify(item) };
  });
}

function createMcpClient(config: RainbondConfig): McpClient {
  const client = new Client({ name: "rainskills-pi", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: {
        Authorization: `GRJWT ${config.token}`,
      },
    },
  });
  return {
    connect: () => client.connect(transport),
    listTools: (params) => client.listTools(params),
    callTool: (request, schema, options) => client.callTool(request, schema as any, options as any),
    close: () => client.close(),
  };
}

async function listAllTools(client: McpClient): Promise<any[]> {
  const tools: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(page.tools || []));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

export function registerRainbondExtension(
  pi: PiApi,
  dependencies: {
    readConfig?: () => RainbondConfig | null;
    createClient?: (config: RainbondConfig) => McpClient;
    onError?: (error: unknown) => void;
  } = {}
) {
  const getConfig = dependencies.readConfig ?? (() => readRainbondConfig());
  const makeClient = dependencies.createClient ?? createMcpClient;
  let client: McpClient | null = null;

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    const config = getConfig();
    if (!config) return;

    try {
      client = makeClient(config);
      await client.connect();
      for (const tool of await listAllTools(client)) {
        if (!tool?.name || !tool?.inputSchema) continue;
        pi.registerTool({
          name: tool.name,
          label: tool.title || tool.name,
          description: tool.description || `Call the Rainbond MCP tool ${tool.name}`,
          parameters: tool.inputSchema,
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>,
            signal?: AbortSignal
          ) {
            if (!client) throw new Error("Rainbond MCP is not connected.");
            const result = await client.callTool(
              { name: tool.name, arguments: params },
              undefined,
              signal ? { signal } : undefined
            );
            if (result?.isError) {
              throw new Error(toPiContent(result).map((item) => item.text).join("\n"));
            }
            return { content: toPiContent(result), details: {} };
          },
        });
      }
    } catch (error) {
      dependencies.onError?.(error);
      await client?.close().catch(() => undefined);
      client = null;
      ctx?.ui?.notify?.(
        "Rainbond MCP 连接失败。请运行 rainskills refresh 后执行 /reload。",
        "warning"
      );
    }
  });

  pi.on("session_shutdown", async () => {
    await client?.close().catch(() => undefined);
    client = null;
  });
}

export default function rainskillsMcpExtension(pi: PiApi) {
  registerRainbondExtension(pi);
}
