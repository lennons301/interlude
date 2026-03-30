const http = require("http");
const net = require("net");
const { spawn } = require("child_process");
const url = require("url");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
const NEXT_PORT = PORT + 1;

const PREVIEW_PATH_RE = /^\/api\/tasks\/([^/]+)\/preview\/(.*)/;

// Subdomain-based preview routing (active when DOMAIN is set)
const DOMAIN = process.env.DOMAIN;
const SUBDOMAIN_RE = DOMAIN
  ? new RegExp(`^([a-z0-9-]+)\\.${DOMAIN.replace(/\./g, "\\.")}(:\\d+)?$`)
  : null;

// Persistent DB connection for WebSocket upgrade lookups
const Database = require("better-sqlite3");
const dbPath = process.env.DATABASE_URL || "local.db";
let taskLookupDb;
try {
  taskLookupDb = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error("[custom-server] Failed to open database:", err.message);
}

function lookupTask(taskId) {
  if (!taskLookupDb) return null;
  try {
    return taskLookupDb.prepare(
      "SELECT container_name, dev_port FROM tasks WHERE id = ?"
    ).get(taskId);
  } catch {
    return null;
  }
}

function lookupTaskBySubdomain(subdomain) {
  if (!taskLookupDb) return null;
  try {
    return taskLookupDb.prepare(
      "SELECT container_name, dev_port, preview_subdomain FROM tasks WHERE preview_subdomain = ? AND dev_port IS NOT NULL"
    ).get(subdomain);
  } catch {
    return null;
  }
}

// Start Next.js as a child process on internal port
const nextServer = spawn("node", [path.join(__dirname, "server.js")], {
  env: { ...process.env, PORT: String(NEXT_PORT), HOSTNAME: "127.0.0.1" },
  stdio: "inherit",
});

nextServer.on("exit", (code) => {
  console.error(`[custom-server] Next.js exited with code ${code}`);
  process.exit(code ?? 1);
});

// Public HTTP server
const server = http.createServer((req, res) => {
  // Check for subdomain-based preview routing
  const host = req.headers.host || "";
  const subMatch = SUBDOMAIN_RE && host.match(SUBDOMAIN_RE);

  if (subMatch) {
    const subdomain = subMatch[1];
    const row = lookupTaskBySubdomain(subdomain);
    if (!row || !row.dev_port) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Preview not available — no dev server running");
      return;
    }

    // Proxy directly to container (subdomain = Docker network alias)
    const proxyReq = http.request(
      {
        hostname: subdomain,
        port: row.dev_port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `${subdomain}:${row.dev_port}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Dev server unavailable");
      }
    });

    req.pipe(proxyReq);
    return;
  }

  // Default: proxy to Next.js
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: NEXT_PORT,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Service starting...");
    }
  });

  req.pipe(proxyReq);
});

server.on("upgrade", (req, socket, head) => {
  // Check for subdomain-based preview WebSocket
  const host = req.headers.host || "";
  const subMatch = SUBDOMAIN_RE && host.match(SUBDOMAIN_RE);

  if (subMatch) {
    const subdomain = subMatch[1];
    const row = lookupTaskBySubdomain(subdomain);
    if (!row || !row.dev_port) {
      socket.destroy();
      return;
    }

    const proxySocket = net.connect(row.dev_port, subdomain, () => {
      let rawReq = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        if (key.toLowerCase() === "host") {
          rawReq += `Host: ${subdomain}:${row.dev_port}\r\n`;
        } else {
          rawReq += `${key}: ${req.rawHeaders[i + 1]}\r\n`;
        }
      }
      rawReq += "\r\n";
      proxySocket.write(rawReq);
      if (head.length > 0) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.on("close", () => socket.destroy());
    socket.on("close", () => proxySocket.destroy());
    return;
  }

  // Path-based preview or Next.js WebSocket
  const parsed = url.parse(req.url || "");
  const pathname = parsed.pathname || "";
  const match = pathname.match(PREVIEW_PATH_RE);

  if (!match) {
    // Not a preview path — proxy upgrade to Next.js
    const proxySocket = net.connect(NEXT_PORT, "127.0.0.1", () => {
      proxySocket.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      );
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        proxySocket.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      }
      proxySocket.write("\r\n");
      if (head.length > 0) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    return;
  }

  // Preview WebSocket — proxy to agent container
  const taskId = match[1];
  const targetPath = "/" + (match[2] || "") + (parsed.search || "");

  const row = lookupTask(taskId);
  if (!row || !row.container_name || !row.dev_port) {
    socket.destroy();
    return;
  }

  const proxySocket = net.connect(row.dev_port, row.container_name, () => {
    let rawReq = `${req.method} ${targetPath} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      if (key.toLowerCase() === "host") {
        rawReq += `Host: ${row.container_name}:${row.dev_port}\r\n`;
      } else {
        rawReq += `${key}: ${req.rawHeaders[i + 1]}\r\n`;
      }
    }
    rawReq += "\r\n";
    proxySocket.write(rawReq);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxySocket.on("error", () => socket.destroy());
  socket.on("error", () => proxySocket.destroy());
  proxySocket.on("close", () => socket.destroy());
  socket.on("close", () => proxySocket.destroy());
});

// Wait for Next.js to start, then listen
setTimeout(() => {
  server.listen(PORT, HOSTNAME, () => {
    console.log(`[custom-server] Listening on http://${HOSTNAME}:${PORT}`);
    console.log(`[custom-server] Proxying to Next.js on 127.0.0.1:${NEXT_PORT}`);
  });
}, 2000);
