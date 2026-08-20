import { spawn } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import manifest from "../../package.json";

type RainbondConfig = {
  command: string;
  args: string[];
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

export function readRainbondConfig(_input: ConfigInput = {}): RainbondConfig {
  return {
    command: "npx",
    args: [
      "--yes", `rainskills@${manifest.version}`, "mcp", "serve", "--client", "pi",
    ],
  };
}

export function publicConfig(config: RainbondConfig) {
  return { command: config.command, args: [...config.args] };
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
  const readBuffer = new ReadBuffer();
  let child: ReturnType<typeof spawn> | null = null;
  const inherited: Record<string, string> = {};
  for (const key of ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "APPDATA", "USERPROFILE", "TEMP"]) {
    if (process.env[key]) inherited[key] = process.env[key] as string;
  }
  const transport: any = {
    onmessage: undefined,
    onerror: undefined,
    onclose: undefined,
    async start() {
      child = spawn(config.command, config.args, {
        env: inherited,
        shell: false,
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
      });
      await new Promise<void>((resolve, reject) => {
        child?.once("spawn", resolve);
        child?.once("error", reject);
      });
      child.stdout?.on("data", (chunk) => {
        try {
          readBuffer.append(chunk);
          for (;;) {
            const message = readBuffer.readMessage();
            if (message === null) break;
            transport.onmessage?.(message);
          }
        } catch (error) {
          transport.onerror?.(error);
        }
      });
      child.once("close", () => transport.onclose?.());
      child.once("error", (error) => transport.onerror?.(error));
    },
    async send(message: unknown) {
      if (!child?.stdin?.writable) throw new Error("Rainskills local MCP is not writable.");
      await new Promise<void>((resolve, reject) => {
        child?.stdin?.write(serializeMessage(message as any), (error) => error ? reject(error) : resolve());
      });
    },
    async close() {
      const running = child;
      child = null;
      if (!running) return;
      running.stdin?.end();
      if (running.exitCode === null) running.kill("SIGTERM");
    },
  };
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
        "Rainskills 本地运行环境路由连接失败。",
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
