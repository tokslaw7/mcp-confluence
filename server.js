
import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = process.env.CONFLUENCE_BASE_URL?.replace(/\/+$/, "");
const PAT = process.env.CONFLUENCE_PAT;

const ALLOWED_SPACES = new Set(
  (process.env.CONFLUENCE_SPACE_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

if (!BASE_URL || !PAT || ALLOWED_SPACES.size === 0) {
  throw new Error(
    "Configure CONFLUENCE_BASE_URL, CONFLUENCE_PAT, " +
    "and CONFLUENCE_SPACE_ALLOWLIST."
  );
}

const API_URL = `${BASE_URL}/rest/api`;

const server = new McpServer({
  name: "confluence-data-center",
  version: "1.0.0",
});

class ConfluenceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ConfluenceError";
    this.status = status;
  }
}

async function apiRequest(path, options = {}) {
  const url = new URL(`${API_URL}/${path.replace(/^\/+/, "")}`);

  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${PAT}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body
      ? { body: JSON.stringify(options.body) }
      : {}),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    // Avoid returning raw response bodies that might expose
    // internal information in MCP error messages.
    throw new ConfluenceError(
      `Confluence API request failed with HTTP ${response.status}.`,
      response.status
    );
  }

  if (response.status === 204) return {};

  return response.json();
}

function requireSpace(spaceKey) {
  if (!ALLOWED_SPACES.has(spaceKey)) {
    throw new Error("Space is not on the approved allowlist.");
  }
}

function requirePageId(pageId) {
  if (!/^\d+$/.test(pageId)) {
    throw new Error("Page ID must contain only digits.");
  }
}

function toolResult(value) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

function registerTool(name, description, schema, handler) {
  server.tool(name, description, schema, async (args) => {
    try {
      return toolResult(await handler(args));
    } catch (error) {
      // Keep secrets, response bodies, and stack traces out
      // of the model-visible error.
      const message = error instanceof Error
        ? error.message
        : "Unexpected server error.";

      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });
}

// 1. Search pages
registerTool(
  "search_pages",
  "Search accessible Confluence pages using CQL.",
  {
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(25).default(10),
  },
  async ({ query, limit }) => {
    // Escape CQL string delimiters and backslashes.
    const escaped = query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const cql =
      `type = page AND text ~ "${escaped}" ` +
      "ORDER BY lastmodified DESC";

    const data = await apiRequest("content/search", {
      params: { cql, limit },
    });

    return data.results.map((page) => ({
      id: page.id,
      title: page.title,
      space: page.space?.key,
      url: page._links?.webui
        ? new URL(page._links.webui, `${BASE_URL}/`).href
        : null,
    }));
  }
);

// 2. Read a page
registerTool(
  "get_page",
  "Retrieve a Confluence page, its storage body, space, and version.",
  { pageId: z.string().regex(/^\d+$/) },
  async ({ pageId }) => {
    requirePageId(pageId);

    const page = await apiRequest(`content/${pageId}`, {
      params: { expand: "body.storage,version,space" },
    });

    requireSpace(page.space.key);

    return {
      id: page.id,
      title: page.title,
      space: page.space.key,
      version: page.version.number,
      body: page.body?.storage?.value ?? "",
      url: page._links?.webui
        ? new URL(page._links.webui, `${BASE_URL}/`).href
        : null,
    };
  }
);

// 3. Create a page
registerTool(
  "create_page",
  "Create a Confluence page in an approved space.",
  {
    spaceKey: z.string().trim().min(1).max(50),
    title: z.string().trim().min(1).max(200),
    bodyHtml: z.string().min(1).max(100000),
  },
  async ({ spaceKey, title, bodyHtml }) => {
    requireSpace(spaceKey);

    const page = await apiRequest("content", {
      method: "POST",
      body: {
        type: "page",
        title,
        space: { key: spaceKey },
        body: {
          storage: {
            value: bodyHtml,
            representation: "storage",
          },
        },
      },
    });

    return {
      id: page.id,
      title: page.title,
      space: spaceKey,
      version: page.version?.number ?? 1,
      url: page._links?.webui
        ? new URL(page._links.webui, `${BASE_URL}/`).href
        : null,
    };
  }
);

// 4. Update an existing page
registerTool(
  "update_page",
  "Update a page only when its current version matches expectedVersion.",
  {
    pageId: z.string().regex(/^\d+$/),
    expectedVersion: z.number().int().min(1),
    title: z.string().trim().min(1).max(200),
    bodyHtml: z.string().min(1).max(100000),
  },
  async ({ pageId, expectedVersion, title, bodyHtml }) => {
    requirePageId(pageId);

    const current = await apiRequest(`content/${pageId}`, {
      params: { expand: "version,space" },
    });

    requireSpace(current.space.key);

    if (current.version.number !== expectedVersion) {
      throw new Error(
        `Version conflict: expected ${expectedVersion}, ` +
        `current version is ${current.version.number}. ` +
        "Read the latest page and review it before retrying."
      );
    }

    const updated = await apiRequest(`content/${pageId}`, {
      method: "PUT",
      body: {
        id: current.id,
        type: "page",
        title,
        space: { key: current.space.key },
        body: {
          storage: {
            value: bodyHtml,
            representation: "storage",
          },
        },
        version: {
          number: current.version.number + 1,
          message: "Updated through Confluence MCP",
        },
      },
    });

    return {
      id: updated.id,
      title: updated.title,
      space: current.space.key,
      version: updated.version?.number,
      status: "updated",
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
