/**
 * A local egress-filtering HTTP proxy for page mode. Every request the
 * page's browser context makes (the navigation, every redirect hop,
 * subresources, fetch/XHR, HTTPS tunnels) goes through it, and each
 * destination is checked by the guard before anything is sent.
 * Interception inside the browser isn't enough: Playwright's request
 * routing never sees redirect targets, so a public page could redirect
 * to a private address unchecked.
 *
 * It connects to the exact address the guard checked, not the hostname,
 * so DNS can't be re-resolved to a private address in between. Plain-HTTP
 * WebSocket upgrades are refused.
 */

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import type { EgressGuard } from './guard';

export interface BlockedRequest {
  url: string;
  reason: string;
}

export interface EgressProxy {
  /** e.g. http://127.0.0.1:54321 */
  url: string;
  blocked: BlockedRequest[];
  close(): Promise<void>;
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive'];

function refuse(socket: net.Socket, status = '403 Forbidden'): void {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

/** `host:port` from a CONNECT request line, IPv6 in brackets. */
function parseAuthority(authority: string): { hostname: string; port: number } | null {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(authority);
  return match ? { hostname: match[1]!, port: Number(match[2]) } : null;
}

export async function startEgressProxy(guard: EgressGuard): Promise<EgressProxy> {
  const blocked: BlockedRequest[] = [];
  // Each URL once: browsers retry some failed loads (e.g. stylesheets).
  const record = (entry: BlockedRequest) => {
    if (!blocked.some((existing) => existing.url === entry.url)) blocked.push(entry);
  };
  const sockets = new Set<net.Socket>();

  const server = http.createServer(async (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const verdict = await guard.check(target.hostname, Number(target.port || 80));
    if (!verdict.allowed) {
      record({ url: target.href, reason: verdict.reason });
      res
        .writeHead(403, { 'content-type': 'text/plain' })
        .end(`Blocked by a11y-autofix: ${verdict.reason}`);
      return;
    }
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    const upstream = http.request(
      {
        host: verdict.address,
        family: verdict.family,
        port: Number(target.port || 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS (and wss:) tunnels: the authority is checked, then the tunnel
  // goes to the checked address. TLS stays end to end.
  server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const authority = parseAuthority(req.url ?? '');
    if (!authority) return refuse(client, '400 Bad Request');
    const verdict = await guard.check(authority.hostname, authority.port);
    if (!verdict.allowed) {
      record({ url: `https://${req.url}`, reason: verdict.reason });
      return refuse(client);
    }
    const upstream = net.connect(
      { host: verdict.address, port: authority.port, family: verdict.family },
      () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      },
    );
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    record({
      url: req.url ?? '',
      reason: 'plain-HTTP WebSocket connections are not proxied',
    });
    refuse(socket);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
