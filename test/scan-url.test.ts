import { readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runScanUrl } from '../src/cli';
import { UrlNotAllowedError, createEgressGuard, isBlockedAddress, scanUrl } from '../src/page';
import type { PageScanResult } from '../src/page';
import { startEgressProxy } from '../src/page/proxy';

import { chromiumAvailable } from './helpers/chromium';

describe('SSRF guard: addresses', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2002:c0a8:101::1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '93.184.215.14',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows public %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('SSRF guard: URLs are refused before anything is loaded', () => {
  it.each([
    ['http://127.0.0.1/', 'private, loopback or reserved'],
    ['http://localhost:3000/', 'loopback hostname'],
    ['http://app.localhost/', 'loopback hostname'],
    ['http://[::1]:8080/', 'private, loopback or reserved'],
    ['http://169.254.169.254/latest/meta-data/', 'private, loopback or reserved'],
    ['http://10.0.0.1/', 'private, loopback or reserved'],
    ['http://0x7f000001/', 'private, loopback or reserved'], // the URL parser reads this as 127.0.0.1
    ['http://2130706433/', 'private, loopback or reserved'],
    ['file:///etc/passwd', 'Only http and https URLs'],
    ['ftp://example.com/', 'Only http and https URLs'],
    ['javascript:alert(1)', 'Only http and https URLs'],
    ['not a url', 'Not a valid URL'],
  ])('%s', async (url, message) => {
    const attempt = scanUrl(url);
    await expect(attempt).rejects.toThrow(UrlNotAllowedError);
    await expect(scanUrl(url)).rejects.toThrow(message);
  });

  it('never suggests allowlisting the cloud metadata address', async () => {
    await expect(scanUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /^Refusing to scan http:\/\/169\.254\.169\.254\/latest\/meta-data\/: 169\.254\.169\.254 is a private, loopback or reserved address\.$/,
    );
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const lookup = vi.fn(async () => [{ address: '10.0.0.5', family: 4 }]);

    await expect(scanUrl('http://intranet.example.com/', { lookup })).rejects.toThrow(
      'intranet.example.com resolves to 10.0.0.5, a private, loopback or reserved address',
    );
  });

  it('refuses a hostname if any of its addresses is private', async () => {
    const guard = createEgressGuard({
      lookup: async () => [
        { address: '93.184.215.14', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    });
    expect(await guard.check('mixed.example.com', 80)).toMatchObject({ allowed: false });
  });

  it('an allowlisted host:port is allowed, and only that one', async () => {
    const guard = createEgressGuard({ allowHosts: ['localhost:3000', '127.0.0.1'] });

    expect(await guard.check('localhost', 3000)).toMatchObject({ allowed: true });
    expect(await guard.check('localhost', 3001)).toMatchObject({ allowed: false });
    expect(await guard.check('127.0.0.1', 9999)).toMatchObject({
      allowed: true,
      address: '127.0.0.1',
    });
    expect(await guard.check('10.0.0.1', 80)).toMatchObject({ allowed: false });
  });
});

describe('the egress proxy itself (no browser)', () => {
  /** Sends raw bytes to the proxy and returns everything it answers before closing or 500 ms of quiet. */
  async function rawExchange(proxyUrl: string, request: string): Promise<string> {
    const { port } = new URL(proxyUrl);
    return new Promise((resolve, reject) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => socket.write(request));
      let answer = '';
      let quiet: NodeJS.Timeout;
      const done = () => {
        socket.destroy();
        resolve(answer);
      };
      socket.on('data', (chunk) => {
        answer += chunk.toString();
        clearTimeout(quiet);
        quiet = setTimeout(done, 500);
      });
      socket.on('end', done);
      socket.on('error', reject);
    });
  }

  it('refuses an HTTPS tunnel (CONNECT) to a private address and never connects', async () => {
    let connections = 0;
    const target = net.createServer((socket) => {
      connections += 1;
      socket.end();
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const { port } = target.address() as AddressInfo;
    const proxy = await startEgressProxy(createEgressGuard());
    try {
      const answer = await rawExchange(
        proxy.url,
        `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
      );
      expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden/);
      expect(proxy.blocked).toEqual([
        { url: `https://127.0.0.1:${port}`, reason: expect.stringContaining('private, loopback') },
      ]);
      expect(connections).toBe(0);
    } finally {
      await proxy.close();
      target.close();
    }
  });

  it('tunnels to an allowlisted host', async () => {
    const target = net.createServer((socket) => socket.end('hello through the tunnel'));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const { port } = target.address() as AddressInfo;
    const proxy = await startEgressProxy(createEgressGuard({ allowHosts: [`127.0.0.1:${port}`] }));
    try {
      const answer = await rawExchange(proxy.url, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`);
      expect(answer).toContain('HTTP/1.1 200 Connection Established');
      expect(answer).toContain('hello through the tunnel');
    } finally {
      await proxy.close();
      target.close();
    }
  });

  it('refuses plain-HTTP WebSocket upgrades', async () => {
    const proxy = await startEgressProxy(createEgressGuard());
    try {
      const answer = await rawExchange(
        proxy.url,
        'GET http://example.com/socket HTTP/1.1\r\nHost: example.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
      expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden/);
    } finally {
      await proxy.close();
    }
  });
});

describe.runIf(chromiumAvailable)('scan-url against a local fixture server', () => {
  const ACCESSIBLE = (body: string, script = '') =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body><main><h1>Fixture</h1>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;

  let site: http.Server;
  let secret: http.Server;
  let siteOrigin: string;
  let siteHost: string;
  const secretHits: string[] = [];
  const hanging: http.ServerResponse[] = [];

  async function listen(server: http.Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  beforeAll(async () => {
    secret = http.createServer((req, res) => {
      secretHits.push(req.url ?? '');
      res.end('internal');
    });
    const secretOrigin = `http://localhost:${await listen(secret)}`;
    const brokenPage = readFileSync(
      path.join(__dirname, 'fixtures', 'pages', 'broken-page.html'),
      'utf8',
    ).replaceAll('{{SECRET_ORIGIN}}', secretOrigin);

    site = http.createServer((req, res) => {
      const send = (html: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(html);
      switch (req.url) {
        case '/':
          return send(brokenPage);
        case '/clean':
          return send(ACCESSIBLE('<p>All good.</p>'));
        case '/go':
          return res.writeHead(302, { location: `${secretOrigin}/admin` }).end();
        case '/late':
          // An unlabeled image appears 1.5 s after load, well after the network goes idle.
          return send(
            ACCESSIBLE(
              '',
              "setTimeout(() => { const i = document.createElement('img'); i.src = 'data:,'; document.querySelector('main').append(i); }, 1500);",
            ),
          );
        case '/lazy':
          // An unlabeled image appears only once the page is scrolled near the bottom.
          return send(
            ACCESSIBLE(
              '<div style="height: 4000px">Tall content</div>',
              "addEventListener('scroll', () => { if (scrollY > 2000 && !document.querySelector('img')) { const i = document.createElement('img'); i.src = 'data:,'; document.querySelector('main').append(i); } });",
            ),
          );
        case '/hang':
          hanging.push(res);
          return;
        default:
          res.writeHead(404).end();
      }
    });
    const port = await listen(site);
    siteHost = `127.0.0.1:${port}`;
    siteOrigin = `http://${siteHost}`;
  });

  afterAll(async () => {
    for (const res of hanging) res.end();
    await new Promise((resolve) => site.close(resolve));
    await new Promise((resolve) => secret.close(resolve));
  });

  beforeEach(() => {
    secretHits.length = 0;
  });

  const scan = (pathname: string, options = {}) =>
    scanUrl(`${siteOrigin}${pathname}`, { allowHosts: [siteHost], settleMs: 100, ...options });

  let broken: PageScanResult;

  it('reports the document-level problems component mode cannot see, grouped by rule', async () => {
    broken = await scan('/');

    const byRule = Object.fromEntries(broken.violations.map((v) => [v.ruleId, v]));
    expect(Object.keys(byRule).sort()).toEqual([
      'color-contrast',
      'document-title',
      'heading-order',
      'html-has-lang',
    ]);

    // One finding for contrast, with every failing element as an instance.
    expect(byRule['color-contrast']).toMatchObject({
      impact: 'serious',
      elementCount: 3,
      wcag: { criteria: ['1.4.3'], levels: ['WCAG 2.0 AA'] },
    });
    expect(byRule['color-contrast']!.elements.map((e) => e.html)).toEqual([
      '<p class="muted">Free shipping on orders over $50.</p>',
      '<p class="muted">Returns are accepted within 30 days.</p>',
      '<p class="muted">The spring sale ends on Sunday.</p>',
    ]);
    expect(byRule['html-has-lang']).toMatchObject({
      elementCount: 1,
      wcag: { criteria: ['3.1.1'] },
    });
    expect(byRule['html-has-lang']!.elements[0]!.selector).toBe('html');
    expect(byRule['document-title']).toMatchObject({
      elementCount: 1,
      wcag: { criteria: ['2.4.2'] },
    });
    expect(byRule['heading-order']).toMatchObject({ bestPractice: true, elementCount: 1 });

    expect(broken).toMatchObject({
      mode: 'page',
      httpStatus: 200,
      title: null,
      fixesGenerated: false,
      totals: { rules: 4, elements: 6 },
    });
    expect(broken.note).toContain('no fixes are generated');
    expect(broken.ruleTags).toEqual([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22aa',
      'best-practice',
    ]);
  });

  it("never lets the page's own requests reach a private address", async () => {
    const result = await scan('/');

    expect(secretHits).toEqual([]);
    expect(result.blockedRequests).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/^http:\/\/localhost:\d+\/internal\.css$/),
        reason: expect.stringContaining('loopback hostname'),
      }),
    ]);
  });

  it('refuses a page that redirects to a private address, without reaching it', async () => {
    await expect(scan('/go')).rejects.toThrow(
      /redirected to http:\/\/localhost:\d+\/admin, and localhost is a loopback hostname/,
    );
    expect(secretHits).toEqual([]);
  });

  it('refuses the local server itself unless it is allowlisted', async () => {
    await expect(scanUrl(`${siteOrigin}/clean`)).rejects.toThrow(UrlNotAllowedError);
  });

  it('a clean page has no violations', async () => {
    expect((await scan('/clean')).violations).toEqual([]);
  });

  it('waits for late rendering: the settle delay catches content added after load', async () => {
    const early = await scan('/late', { settleMs: 0 });
    const settled = await scan('/late', { settleMs: 2500 });

    expect(early.violations.map((v) => v.ruleId)).not.toContain('image-alt');
    expect(settled.violations.map((v) => v.ruleId)).toContain('image-alt');
  });

  it('--scroll triggers lazy-loaded content, and nothing is clicked', async () => {
    const still = await scan('/lazy');
    const scrolled = await scan('/lazy', { scroll: true });

    expect(still.violations.map((v) => v.ruleId)).not.toContain('image-alt');
    expect(scrolled.violations.map((v) => v.ruleId)).toContain('image-alt');
  });

  it('gives up with a clear error at the timeout', async () => {
    await expect(scan('/hang', { timeoutMs: 1500 })).rejects.toThrow(
      'scan-url timed out after 1500 ms (loading the page)',
    );
  });

  describe('cli: scan-url', () => {
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      process.exitCode = undefined;
    });

    const printed = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls.map((call) => call.join(' ')).join('\n');

    it('prints grouped findings, says no fixes are generated, and exits 1', async () => {
      await runScanUrl(`${siteOrigin}/`, { allowHosts: [siteHost], settleMs: 100 });

      const output = printed(logSpy);
      expect(output).toContain(`Scanned ${siteOrigin}/`);
      expect(output).toContain('Page mode reports issues only: no fixes are generated.');
      expect(output).toContain(
        '[serious] color-contrast: Elements must meet minimum color contrast ratio thresholds (WCAG 1.4.3, WCAG 2.0 AA) — 3 elements',
      );
      expect(output).toContain('[serious] html-has-lang:');
      expect(output).toContain(
        '4 rule(s) failed across 6 element(s). 1 request(s) to private or loopback addresses were blocked.',
      );
      expect(process.exitCode).toBe(1);
    });

    it('--json prints the full result', async () => {
      await runScanUrl(`${siteOrigin}/clean`, {
        allowHosts: [siteHost],
        settleMs: 100,
        json: true,
      });

      const result = JSON.parse(logSpy.mock.calls[0]![0] as string);
      expect(result).toMatchObject({ mode: 'page', fixesGenerated: false, violations: [] });
      expect(process.exitCode).not.toBe(1);
    });

    it('a refused URL is an error with a hint, and exits 1', async () => {
      await runScanUrl('http://127.0.0.1:9/');

      expect(printed(errorSpy)).toContain('Refusing to scan http://127.0.0.1:9/');
      expect(printed(errorSpy)).toContain(
        'If this is your own local server, allow just that host: --allow-host 127.0.0.1:9.',
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
