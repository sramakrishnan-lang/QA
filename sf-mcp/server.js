import axios from "axios";
import jwt from "jsonwebtoken";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(level, message, meta) {
  const ts = new Date().toISOString();
  const metaText = meta ? ` | ${JSON.stringify(meta)}` : "";
  // Use stderr for logs so MCP stdio payload on stdout is untouched.
  console.error(`[${ts}] [${level}] ${message}${metaText}`);
}

async function importWithFallback(label, specifiers) {
  let lastErr = null;
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      log("DEBUG", `Loaded ${label} module`, { specifier });
      return { mod, specifier };
    } catch (e) {
      lastErr = e;
      log("WARN", `Failed loading ${label} module`, {
        specifier,
        message: e.message,
        code: e.code || null
      });
    }
  }

  const error = new Error(
    `Unable to load ${label} module. Tried: ${specifiers.join(", ")}. ` +
      "Run `npm install` and ensure @modelcontextprotocol/sdk is present."
  );
  error.cause = lastErr;
  throw error;
}

async function loadMcpSdk() {
  const mcpRes = await importWithFallback("McpServer", [
    "@modelcontextprotocol/sdk/server/mcp.js",
    "@modelcontextprotocol/sdk/dist/esm/server/mcp.js"
  ]);
  const transportRes = await importWithFallback("StdioServerTransport", [
    "@modelcontextprotocol/sdk/server/stdio.js",
    "@modelcontextprotocol/sdk/dist/esm/server/stdio.js"
  ]);

  if (!mcpRes.mod.McpServer || !transportRes.mod.StdioServerTransport) {
    throw new Error("MCP SDK loaded but required exports are missing.");
  }

  return {
    McpServer: mcpRes.mod.McpServer,
    StdioServerTransport: transportRes.mod.StdioServerTransport
  };
}

// Salesforce JWT config - set SF_PRIVATE_KEY_PATH if key is elsewhere
const PRIVATE_KEY_PATH = process.env.SF_PRIVATE_KEY_PATH || "/Users/kankit/Documents/sf-mcp/server.key";
const SF_CONSUMER_KEY = process.env.SF_CONSUMER_KEY || "3MVG9CVKiXR7Ri5reEzOtLwbaXRAsSsyRMHbKFboY87niksxUrTPRSMB3AEM3R6Nxj3k1DeZfgcJglG1XsCnR";
const SF_USERNAME = process.env.SF_USERNAME || "sfdc-devoncall@groupon.com";
const SF_AUDIENCE = process.env.SF_AUDIENCE || "https://login.salesforce.com";

let tokenCache = null;

function toIsoOrNull(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  const dt = new Date(value);
  const ms = dt.getTime();
  if (Number.isNaN(ms)) {
    return null;
  }
  return dt.toISOString();
}

function buildSalesforceErrorMessage(e) {
  const data = e.response?.data;
  if (data?.error === "invalid_grant" && data?.error_description?.includes("user hasn't approved")) {
    return (
      "Salesforce error: user has not approved this Connected App for JWT flow. " +
      "In Salesforce, open App Manager -> your app -> Manage -> Edit Policies, then pre-authorize the user/profile."
    );
  }
  return data ? JSON.stringify(data) : e.message;
}

async function getSalesforceToken() {
  log("DEBUG", "getSalesforceToken called", {
    cacheHit: Boolean(tokenCache && tokenCache.expiresAt > Date.now())
  });
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    log("DEBUG", "Using cached Salesforce token", {
      expiresAt: toIsoOrNull(tokenCache.expiresAt)
    });
    return tokenCache;
  }

  log("INFO", "Refreshing Salesforce token", {
    privateKeyPath: PRIVATE_KEY_PATH,
    audience: SF_AUDIENCE,
    username: SF_USERNAME
  });

  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    log("ERROR", "Private key path does not exist", { privateKeyPath: PRIVATE_KEY_PATH });
    throw new Error(`Private key file not found at: ${PRIVATE_KEY_PATH}`);
  }

  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
  log("DEBUG", "Private key loaded", { privateKeyLength: privateKey.length });
  const assertion = jwt.sign(
    {
      iss: SF_CONSUMER_KEY,
      sub: SF_USERNAME,
      aud: SF_AUDIENCE,
      exp: Math.floor(Date.now() / 1000) + 300
    },
    privateKey,
    { algorithm: "RS256" }
  );
  log("DEBUG", "JWT assertion created", { assertionLength: assertion.length });
  const res = await axios.post(
    `${SF_AUDIENCE}/services/oauth2/token`,
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  );
  const { access_token, instance_url, expires_in } = res.data;
  const expiresInSec = Number(expires_in);
  const safeExpiresInSec = Number.isFinite(expiresInSec) && expiresInSec > 60 ? expiresInSec : 3600;
  tokenCache = {
    access_token,
    instance_url,
    expiresAt: Date.now() + (safeExpiresInSec - 60) * 1000
  };
  log("INFO", "Salesforce token received", {
    instanceUrl: instance_url,
    expiresIn: expires_in,
    safeExpiresInSec
  });
  return tokenCache;
}

function extractPrimaryObjectFromSoql(soql) {
  // Basic extraction for common SOQL forms: SELECT ... FROM ObjectName ...
  const match = soql.match(/\bFROM\s+([a-zA-Z0-9_]+)/i);
  return match ? match[1] : null;
}

async function precheckSoqlWithDescribe(soql, access_token, instance_url) {
  const objectApiName = extractPrimaryObjectFromSoql(soql);
  if (!objectApiName) {
    log("WARN", "SOQL precheck skipped: could not parse object from query");
    return {
      precheckRun: false,
      reason: "Could not determine object from SOQL"
    };
  }

  log("INFO", "Running Tooling API precheck", { objectApiName });

  let toolingCheck = {
    attempted: true,
    supported: true,
    passed: false,
    skippedReason: null
  };
  // 1) Tooling API lookup to validate object metadata presence.
  // Some orgs/users don't support EntityDefinition through Tooling API; fallback to describe if so.
  try {
    const toolingSoql = `SELECT Id, QualifiedApiName, Label FROM EntityDefinition WHERE QualifiedApiName = '${objectApiName}' LIMIT 1`;
    const toolingRes = await axios.get(
      `${instance_url}/services/data/v60.0/tooling/query`,
      {
        params: { q: toolingSoql },
        headers: { Authorization: `Bearer ${access_token}` }
      }
    );

    if (!toolingRes.data?.totalSize) {
      toolingCheck.passed = false;
      toolingCheck.skippedReason = `EntityDefinition returned no rows for ${objectApiName}`;
      log("WARN", "Tooling precheck returned no EntityDefinition rows; continuing with describe", {
        objectApiName
      });
    } else {
      toolingCheck.passed = true;
    }
  } catch (e) {
    const data = e.response?.data;
    const errors = Array.isArray(data) ? data : data ? [data] : [];
    const invalidType = errors.some((item) => item?.errorCode === "INVALID_TYPE");

    toolingCheck.passed = false;
    toolingCheck.supported = !invalidType;
    toolingCheck.skippedReason = invalidType
      ? "EntityDefinition INVALID_TYPE for this org/user"
      : "Tooling precheck failed; continued with describe fallback";

    log("WARN", "Tooling precheck failed; continuing with describe fallback", {
      objectApiName,
      invalidType,
      responseData: data || null,
      message: e.message
    });
  }

  // 2) Describe call to ensure the current user can describe/read the object
  const describeRes = await axios.get(
    `${instance_url}/services/data/v60.0/sobjects/${objectApiName}/describe`,
    {
      headers: { Authorization: `Bearer ${access_token}` }
    }
  );

  if (!describeRes.data?.queryable) {
    throw new Error(`Describe precheck failed: object '${objectApiName}' is not queryable for this user.`);
  }

  log("INFO", "SOQL precheck successful", {
    objectApiName,
    queryable: describeRes.data.queryable,
    toolingCheck
  });

  return {
    precheckRun: true,
    objectApiName,
    queryable: describeRes.data.queryable
  };
}

async function runSoqlQuery(soql) {
  const { access_token, instance_url, expiresAt } = await getSalesforceToken();
  await precheckSoqlWithDescribe(soql, access_token, instance_url);
  const res = await axios.get(
    `${instance_url}/services/data/v60.0/query`,
    {
      params: { q: soql },
      headers: { Authorization: `Bearer ${access_token}` }
    }
  );

  return {
    instance_url,
    token_expires_at: toIsoOrNull(expiresAt),
    total_size: res.data.totalSize,
    records: res.data.records
  };
}

const { McpServer, StdioServerTransport } = await loadMcpSdk();

const server = new McpServer(
  { name: "salesforce-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

log("INFO", "Salesforce MCP server booting", {
  nodeVersion: process.version,
  privateKeyPath: PRIVATE_KEY_PATH,
  hasConsumerKey: Boolean(process.env.SF_CONSUMER_KEY),
  hasUsername: Boolean(process.env.SF_USERNAME),
  audience: SF_AUDIENCE
});
log("INFO", "Salesforce MCP server started, waiting for connections...");
// Tool: Query Salesforce
server.registerTool(
  "sf_query",
  {
    description: "Run a SOQL query in Salesforce. Pass the SOQL query string (e.g. SELECT Id, Name FROM Account LIMIT 5).",
    inputSchema: {
      soql: z.string().describe("The SOQL query to execute (e.g. SELECT Id, Name FROM Account LIMIT 5)")
    }
  },
  async ({ soql }) => {
    log("INFO", "sf_query invoked", {
      soqlPreview: soql.length > 120 ? `${soql.slice(0, 120)}...` : soql
    });
    try {
      const result = await runSoqlQuery(soql);

      log("INFO", "sf_query completed", {
        totalRecords: result.total_size,
        returnedRecords: Array.isArray(result.records) ? result.records.length : null
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.records, null, 2)
          }
        ]
      };
    } catch (e) {
      const msg = buildSalesforceErrorMessage(e);
      log("ERROR", "sf_query failed", {
        message: e.message,
        responseStatus: e.response?.status || null,
        responseData: e.response?.data || null,
        stack: e.stack
      });
      return {
        content: [{ type: "text", text: "Error: " + msg }]
      };
    }
  }
);

// Tool: Test Salesforce connection (merged from jwt.js flow)
server.registerTool(
  "sf_test_connection",
  {
    description: "Validate JWT login and run a sample Account query",
    inputSchema: {}
  },
  async () => {
    const testSoql = "SELECT Id, Name FROM Account LIMIT 5";
    log("INFO", "sf_test_connection invoked", { soql: testSoql });
    try {
      const result = await runSoqlQuery(testSoql);
      log("INFO", "sf_test_connection completed", {
        instanceUrl: result.instance_url,
        totalRecords: result.total_size
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "ok",
                soql: testSoql,
                instance_url: result.instance_url,
                token_expires_at: result.token_expires_at,
                records: result.records
              },
              null,
              2
            )
          }
        ]
      };
    } catch (e) {
      const msg = buildSalesforceErrorMessage(e);
      log("ERROR", "sf_test_connection failed", {
        message: e.message,
        responseStatus: e.response?.status || null,
        responseData: e.response?.data || null,
        stack: e.stack
      });
      return {
        content: [{ type: "text", text: "Error: " + msg }]
      };
    }
  }
);

const transport = new StdioServerTransport();
log("INFO", "Connecting MCP server transport");
await server.connect(transport);
log("INFO", "MCP server transport connected");
