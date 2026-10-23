// Consume a host-captured, unchanged Shed Release on the isolated native fixture.
// Usage: test:shed-terminal <shed-directory> <shed-revision> <tourtois-directory> <tourtois-revision>
// Run SECOND, only after the fixture custodian's handoff, under the bounded
// proof runner and HEAVY_CLASS=prepush with four-core affinity.
// CELLD_PLATFORM_CELLD + wrangler-on-celld.mjs selects celld; otherwise workerd.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import { chromium, expect } from "playwright/test";
import * as z from "zod";
import { installRelease } from "@fungi.computer/oyster/pack";
import { parseSourceRevision } from "@fungi.computer/puffball";
import { releaseSchema } from "@fungi.computer/puffball/effect";
import { workbenchDirectorySchema } from "@fungi.computer/nacre/workbench-directory";

const [packedDirectory, expectedRevision, tourtoisDirectory, tourtoisRevision] =
  z
    .tuple([
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
      z.string().min(1),
    ])
    .parse(process.argv.slice(2));
const directory = resolve(packedDirectory);
const release = Schema.decodeUnknownSync(Schema.fromJsonString(releaseSchema))(
  await readFile(join(directory, "release.json"), "utf8"),
);
assert.equal(release.appId, "app_shed");
assert.equal(
  release.artifact.provenance.sourceRevision,
  parseSourceRevision(expectedRevision),
  "Install the exact immutable Shed capture released by its owner",
);

const tourtois = Schema.decodeUnknownSync(Schema.fromJsonString(releaseSchema))(
  await readFile(join(resolve(tourtoisDirectory), "release.json"), "utf8"),
);
assert.equal(tourtois.appId, "app_tourtois");
assert.equal(
  tourtois.artifact.provenance.sourceRevision,
  parseSourceRevision(tourtoisRevision),
  "Install the exact immutable Tourtois capture released by its owner",
);

const fixturePath = process.env.OYSTER_PROOF_ENV_FILE;
assert.ok(
  fixturePath,
  "OYSTER_PROOF_ENV_FILE must name the released private fixture",
);
assert.equal((await stat(fixturePath)).mode & 0o777, 0o600);
const fixture = z
  .object({
    COMPUTER_PROOF_PORT: z.coerce.number().int().min(1).max(65535),
    COMPUTER_VM_ORIGIN: z.url(),
    COMPUTER_VM_DEFAULT_HOST: z.string().min(1),
    COMPUTER_VM_HOSTS: z.string().min(1),
    COMPUTER_VM_SIGNING_KEY: z.string().min(1),
  })
  .safeParse(parseEnv(await readFile(fixturePath, "utf8")));
assert.ok(fixture.success, "Fixture configuration is invalid");
const { COMPUTER_PROOF_PORT: port, ...computerVars } = fixture.data;
const root = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const runtime = process.env.CELLD_PLATFORM_CELLD ? "celld" : "workerd";
await mkdir(`${root}.botanical`, { recursive: true });
const work = await mkdtemp(`${root}.botanical/shed-terminal-${runtime}-`);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repository,
  encoding: "utf8",
}).trim();
const key = randomBytes(24).toString("hex");
const origin = `http://127.0.0.1:${port}`;
// The standalone worker's own tenancy admits only an HTTPS origin with no
// path/credentials (packages/oyster/src/standalone/tenancy.ts's composeTenancy,
// packages/tenancy/src/registry-record.ts's checkedOrigin) — a bare
// http://127.0.0.1 origin throws "Tenant origin must be HTTPS...".
// --local-upstream/--upstream-protocol make wrangler's local dev server
// declare that exact origin to the Worker while still listening on plain
// loopback HTTP, the same sentinel convention every other native/browser
// proof of this standalone worker already uses (edit-in-inkcap-live,
// tourtois-home, landed-push, workflows, agents-sandbox).
//
// Opus-PT's reviewed fix for the Ports tray additionally calls for
// OYSTER_PREVIEW_ORIGIN (packages/oyster/src/standalone/preview.ts's
// previewOrigins; packages/oyster/src/standalone/computer.ts:625-626 returns
// port_previews_not_configured without it) and dropping --local-upstream
// for --local-protocol https, since --local-upstream rewrites every
// request's Host to the same single value and the preview popup can never
// reach a second, distinct tunnel origin through it. Tried exactly that
// (OYSTER_PREVIEW_ORIGIN=https://127.0.0.1:<port> alongside
// OYSTER_ORIGIN=https://localhost:<port>, --local-protocol https,
// NODE_TLS_REJECT_UNAUTHORIZED=0 for this script's own Node-side fetches,
// ignoreHTTPSErrors on the browser context) and it broke something more
// fundamental: the scratch vmd fixture's own --worker callback is a fixed
// plain-HTTP URL set at vmd's own launch (http://127.0.0.1:<this port>,
// from s5-vm-fixture.sh), and workerd's now-HTTPS-only local listener
// refuses that plaintext callback outright — confirmed directly in
// workerd's own log: "error accepting tls connection ... OpenSSL error;
// message = error:1000009c:SSL routines:OPENSSL_internal:HTTP_REQUEST".
// Every Computer-backed call then retried twice at 30s and failed (the
// same two-attempts-at-30s shape Sonnet-SG found for Workspace push).
// Fixing that needs vmd restarted with a matching https callback — not
// something to do unilaterally to a VM shared with Sonnet-SG's S9 work
// mid-session ("keep the VM up until S9 is green"). Reverted to the
// known-good --local-upstream transport for now; OYSTER_PREVIEW_ORIGIN
// stays set (harmless, satisfies half the fix) but the Ports tray itself
// is not expected to pass until this is resolved — see the READY/STATUS
// report for the exact finding and the open question.
const tenantHost = "oyster.test";
const previewHost = "oyster-preview.test";
const vars = {
  ...computerVars,
  OYSTER_OWNER_KEY: key,
  OYSTER_ORIGIN: `https://${tenantHost}`,
  OYSTER_PREVIEW_ORIGIN: `https://${previewHost}`,
  OYSTER_HOME_INSTALLATION: "tourtois",
};
const worker = spawn(
  `${repository}node_modules/.bin/wrangler`,
  [
    "dev",
    "--config",
    `${root}wrangler.celld.jsonc`,
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    `${work}/state`,
    "--local-upstream",
    tenantHost,
    "--upstream-protocol",
    "https",
    ...Object.entries(vars).flatMap(([name, value]) => [
      "--var",
      `${name}:${value}`,
    ]),
  ],
  // Wrangler may report --var values; captured, not inherited, and only
  // written out redacted (below) so secrets never reach this process's own
  // stdout.
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: process.env },
);
let workerOutput = "";
worker.stdout.on("data", (chunk) => {
  workerOutput += chunk;
});
worker.stderr.on("data", (chunk) => {
  workerOutput += chunk;
});
let startupFailed = false;
const stopped = new Promise((resolve) => {
  worker.once("exit", resolve);
  worker.once("error", () => {
    startupFailed = true;
    resolve();
  });
});
let browser;
const screenshots = [];
const viewports = [];
const redact = (text) =>
  Object.values(vars).reduce(
    (message, value) => message.replaceAll(value, "<redacted>"),
    String(text),
  );
try {
  for (let attempt = 0; ; attempt += 1) {
    const ready = await globalThis
      .fetch(`${origin}/login`, {
        signal: globalThis.AbortSignal.timeout(1000),
      })
      .then(
        (response) => response.ok,
        () => false,
      );
    if (ready) break;
    if (attempt >= 120 || worker.exitCode !== null || startupFailed)
      throw new Error(
        "Standalone Oyster did not start; terminal proof did not run",
      );
    await delay(500);
  }
  const home = await installRelease({
    directory: resolve(tourtoisDirectory),
    url: origin,
    key,
    installationId: "tourtois",
  });
  assert.equal(home.status, 201, "The unchanged Tourtois Release installs");
  const installed = await installRelease({
    directory,
    url: origin,
    key,
    installationId: "shed",
  });
  assert.equal(installed.status, 201, "The unchanged Shed Release installs");

  const command = await globalThis.fetch(
    `${origin}/apps/shed/methods/runCommand`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "printf standalone-shed-terminal",
        timeoutMs: 10000,
      }),
    },
  );
  assert.equal(
    command.status,
    200,
    "The unchanged Shed backend runs a native command",
  );
  const result = await command.json();
  assert.deepEqual(result, {
    stdout: "standalone-shed-terminal",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  });

  const directoryResponse = await globalThis.fetch(
    `${origin}/api/workbench/directory`,
    {
      headers: { Authorization: `Bearer ${key}` },
    },
  );
  assert.equal(directoryResponse.status, 200);
  const { apps } = workbenchDirectorySchema.parse(
    await directoryResponse.json(),
  );
  const installedShed = apps.filter((app) => app.installationId === "shed");
  assert.equal(installedShed.length, 1);
  const [shedApp] = installedShed;
  assert.equal(shedApp.appId, release.appId);
  assert.equal(shedApp.releaseId, release.releaseId);
  assert.equal(shedApp.availability, "available");
  assert.ok(shedApp.roles.includes("terminal"));
  assert.equal(shedApp.displayName, "Shed");

  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      reducedMotion: "reduce",
    });
    page.setDefaultTimeout(30_000);
    const terminalCloseKey = `terminal-close-${randomBytes(8).toString("hex")}`;
    // Navigation discards both Playwright and CDP socket-close notifications.
    // Persist the shared owner's actual native close call across that navigation.
    await page.addInitScript((key) => {
      const close = globalThis.WebSocket.prototype.close;
      globalThis.WebSocket.prototype.close = function (...args) {
        const result = close.apply(this, args);
        const url = new globalThis.URL(this.url);
        if (
          url.pathname === "/computer/terminal" &&
          url.searchParams.has("session")
        )
          globalThis.sessionStorage.setItem(key, this.url);
        return result;
      };
    }, terminalCloseKey);
    const received = [];
    const sent = [];
    const diagnostics = {
      errors: [],
      sockets: [],
      requests: [],
      handshake: [],
    };
    page.on("pageerror", (error) =>
      diagnostics.errors.push(redact(error.message)),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        diagnostics.errors.push(redact(message.text()));
    });
    page.on("requestfailed", (request) => {
      diagnostics.requests.push({
        path: new URL(request.url()).pathname,
        error: redact(request.failure()?.errorText ?? "Request failed"),
      });
    });
    await page.exposeFunction("recordAppHandshake", (type) => {
      if (type === "fungi.app.ready" || type === "fungi.app.connect")
        diagnostics.handshake.push(type);
    });
    await page.addInitScript(() => {
      globalThis.addEventListener("message", (event) => {
        if (
          event.data?.type === "fungi.app.ready" ||
          event.data?.type === "fungi.app.connect"
        )
          void globalThis.recordAppHandshake(event.data.type);
      });
    });
    let terminalSocket;
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      if (!url.searchParams.has("session") || !url.searchParams.has("cols"))
        return;
      terminalSocket = socket;
      diagnostics.sockets.push({ path: url.pathname, event: "created" });
      socket.on("framereceived", ({ payload }) => received.push(payload));
      socket.on("framesent", ({ payload }) => sent.push(payload));
      socket.on("socketerror", (error) =>
        diagnostics.errors.push(redact(error)),
      );
      socket.on("close", () => {
        diagnostics.sockets.push({ path: url.pathname, event: "closed" });
      });
    });
    try {
      await page.goto(`${origin}/login`);
      await page.getByLabel("Owner key").fill(key);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.goto(origin);
      await expect(page).toHaveURL(`${origin}/apps/tourtois/`);
      const desktop = page.locator("#oyster-shell [data-tourtois-shell]");
      await expect(desktop).toBeVisible();
      const before = `before-tourtois-${width}.png`;
      await page.screenshot({ path: join(work, before), fullPage: true });
      screenshots.push(before);
      const [wasmResponse] = await Promise.all([
        page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.origin === origin &&
            url.pathname.startsWith("/ui/shed/") &&
            url.pathname.endsWith(".wasm") &&
            response.status() === 200
          );
        }),
        desktop.getByRole("button", { name: "Shed", exact: true }).click(),
      ]);
      assert.match(
        wasmResponse.headers()["content-type"],
        /^application\/wasm/,
      );
      const shed = page
        .locator('.tourtois-app-pane[aria-label="Shed"]')
        .frameLocator(".tourtois-pane-body iframe");
      await expect(shed.locator("#shed-root")).toBeVisible();
      await expect(
        desktop.getByText("Terminal open", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      assert.ok(
        terminalSocket,
        "Shed opened the existing Computer PTY transport",
      );
      const ready = received
        .filter((frame) => !Buffer.isBuffer(frame))
        .map((frame) => JSON.parse(frame))
        .find((frame) => frame.type === "ready");
      assert.ok(
        ready?.information?.computerName,
        "The PTY supplies terminal metadata",
      );
      assert.equal(
        ready.information.computerName,
        "workspace",
        "The VM Computer fixture's sole Computer is named workspace",
      );
      const nonce = randomBytes(8).toString("hex");
      // Shed is one Ghostty terminal whose light prompt is drawn on its
      // canvas; `full` escalates one typed line to the real PTY in place, and
      // every later command is typed into the same canvas. Typing goes to
      // Ghostty's hidden key-capture textarea, which a click on the canvas
      // focuses.
      const canvas = shed.locator(".terminal-host canvas");
      const typeLine = async (line) => {
        await canvas.click();
        await page.keyboard.type(line);
        await page.keyboard.press("Enter");
      };
      const receivedBytes = () =>
        Buffer.concat(received.filter((frame) => Buffer.isBuffer(frame)));
      const sentBytesLength = () =>
        sent.filter((frame) => Buffer.isBuffer(frame)).length;

      // Row 50: a light-routed command (no `full`) runs through Shed's own
      // runCommand App method, not the PTY. "Light mode" never requires the
      // PTY socket to be absent (ShellPanel keeps it mounted for the
      // banner/session facts); what must hold is that a light command's own
      // bytes never reach the PTY input — checked here, before any
      // escalation, while the light prompt is still the mounted surface.
      const runCommandCalls = [];
      page.on("request", (request) => {
        if (request.url() === `${origin}/apps/shed/methods/runCommand`)
          runCommandCalls.push(request.postDataJSON());
      });
      const beforeLightInput = sentBytesLength();
      await typeLine("pwd");
      await expect
        .poll(
          () => runCommandCalls.some((call) => call.command.endsWith("; pwd")),
          {
            message: "A light command calls Shed's runCommand method",
            timeout: 30_000,
          },
        )
        .toBe(true);
      assert.equal(
        sentBytesLength(),
        beforeLightInput,
        "A light-routed command never writes bytes to the PTY input",
      );

      const marker = `oyster-${nonce}-command`;
      await typeLine(`full printf 'oyster-%s-command\\n' '${nonce}'`);
      await expect
        .poll(() => receivedBytes().includes(marker), {
          message: "A real shell command returns through Shed's terminal",
          timeout: 30_000,
        })
        .toBe(true);
      const after = `after-shed-terminal-${width}.png`;
      await page.screenshot({ path: join(work, after), fullPage: true });
      screenshots.push(after);

      // Row 49: pwd/ls/git log -1 --oneline, typed straight into the now
      // visible real terminal (we are already escalated). Asserted on the
      // raw PTY byte stream this proof already observes over the
      // websocket — not a rendered grid: Ghostty's own cell buffer isn't
      // introspectable from this packed Release outside a Vite dev server
      // (unlike terminal-resize.browser.mjs's recording-ghostty trick).
      // ghostty-web's open() (dist/ghostty-web.js) gives its mount element
      // itself role="textbox" aria-label="Terminal input" (contenteditable,
      // for the real visible terminal region) AND appends a second, 1px
      // clipped <textarea> with the SAME role and label as its internal
      // key-capture target — so that accessible name is not unique and
      // getByRole(...) for it resolves ambiguously. Ghostty's own supported
      // input path is: click its <canvas> (the visible rendered region,
      // already styled by shed-pane.css's ".terminal-host canvas" rule),
      // which focuses the hidden textarea internally; type and press keys
      // against the page, never against the vendor's hidden input directly,
      // and never touch shed's product DOM to disambiguate it.
      const terminalRegion = shed.locator(".terminal-host canvas");
      /**
       * Type one line into the real terminal and wait for ITS OWN
       * split-marker output — proof the command actually completed, never
       * satisfied by the terminal's own echo of the typed line. The
       * negative control is explicit: once the terminal has echoed enough
       * bytes to show typing landed, the marker must still be absent,
       * before Enter is even pressed (a bare terminal echoes keystrokes
       * before a shell can act on them). No fixed delay anywhere in this
       * helper.
       *
       * CONFIRMED against a real bounded terminal: a long typed line (the
       * SETUP command below, chained and well over the row width) does NOT
       * echo back as one flat contiguous copy of `line` — bash's own
       * readline redraws past the viewport width with its own cursor
       * movement instead, so `sinceStart().includes(line)` can time out
       * forever even though the terminal is echoing correctly (observed
       * directly in a failed run's screenshot: a horizontally-scrolled tail
       * of the command, not line-wrapped, not the literal substring). The
       * echo check below only waits for AT LEAST as many new bytes as were
       * typed — proof that real echo happened — never for the exact text,
       * so it holds regardless of wrap/redraw width. The actual "this
       * command, not its echo" proof stays on the marker alone, which is
       * short enough to always render intact.
       */
      async function runFull(command, markerPrefix) {
        const start = receivedBytes().length;
        const sinceStart = () =>
          receivedBytes().subarray(start).toString("utf8");
        const markerNonce = randomBytes(8).toString("hex");
        const lineMarker = `${markerPrefix}-${markerNonce}`;
        const line = `${command}; printf '%s%s\\n' '${markerPrefix}-' '${markerNonce}'`;
        assert.ok(
          !line.includes(lineMarker),
          "the typed line itself never contains the concatenated marker",
        );
        await terminalRegion.click();
        await page.keyboard.type(line);
        await expect
          .poll(() => sinceStart().length >= line.length, {
            message: `The terminal echoes the typed line for: ${command}`,
            timeout: 10_000,
          })
          .toBe(true);
        assert.ok(
          !sinceStart().includes(lineMarker),
          "echoing the typed line alone never satisfies the split marker " +
            "(the negative control pr1-launch-smoke-apps.test.mjs also proves)",
        );
        await page.keyboard.press("Enter");
        await expect
          .poll(() => sinceStart().includes(lineMarker), {
            message: `The PTY completes: ${command}`,
            timeout: 30_000,
          })
          .toBe(true);
        return sinceStart();
      }
      const probeDir = `/workspace/e2e-shed-proof-${nonce}`;
      const knownFile = "known.txt";
      // The VM's own git auto-detects an invalid email from its hostname
      // ("fungi@computer.(none)") and refuses to commit without one
      // explicitly configured — the same thing a real first-time user
      // would hit, worked around here like any CI script would, with a
      // disposable local identity (git config without --global, scoped to
      // this probe repo alone).
      await runFull(
        `mkdir -p ${probeDir} && cd ${probeDir} && printf probe > ${knownFile} && git init -q && git config user.email proof@example.com && git config user.name "E2E proof" && git commit -q --allow-empty -m e2e-proof-commit`,
        "SETUP",
      );
      // pwd's own output comes only from $(pwd) command substitution,
      // evaluated at run time — the typed/echoed line never contains the
      // real path, so any occurrence in this command's own output slice
      // can only be the shell's real answer.
      const pwdOutput = await runFull(`printf '%s' "$(pwd)"`, "PWD");
      assert.ok(
        pwdOutput.includes(probeDir),
        "pwd's command-substitution output renders the real working directory",
      );
      const lsOutput = await runFull("ls", "LS");
      assert.ok(
        lsOutput.includes(knownFile),
        "ls's own output lists the known seeded file",
      );
      // --color=never: git auto-colorizes --oneline with ANSI SGR codes
      // when it detects a real PTY (confirmed: the hash and ref decoration
      // render in distinct colors against the live terminal), which breaks
      // a plain hash/subject regex on the raw byte stream.
      const logOutput = await runFull(
        "git log -1 --oneline --color=never",
        "LOG",
      );
      assert.match(
        logOutput,
        // `--oneline` decorates the first commit of a fresh repo with its
        // ref ("(HEAD -> master)") between the hash and the subject — real
        // git behavior, not optional here.
        /[0-9a-f]{7,}(?: \([^)]+\))? e2e-proof-commit/,
        "git log -1 --oneline renders a real commit hash and subject",
      );
      assert.ok(
        !logOutput.includes("�"),
        "no U+FFFD replacement character in the raw PTY byte stream",
      );
      const ptyShot = `terminal-pty-bytes-${width}.png`;
      await page.screenshot({ path: join(work, ptyShot), fullPage: true });
      screenshots.push(ptyShot);

      // Row 51: start a background server, expose its port, confirm the
      // preview affordance renders, then stop the process. The popup's own
      // content (fence asserts preview-popup.browser.mjs:340-456 already
      // cover: no opener, not an embedded iframe, shows the real served
      // page) is proven at the live demo, not here — see the comment
      // below the "Open preview" visibility check for why this fixture
      // itself cannot reach it. The Processes and Ports trays are
      // Tourtois window chrome, not Shed's own light/full prompt, so they
      // work the same escalated or not.
      // Port 8099, not 8080: 8080 is computerDaemonPort, computerd's own
      // reserved control-plane port (packages/computer-contract/src/
      // index.ts); starting a demo process there throws
      // ComputerPortReservedError, confirmed against the real VM.
      //
      // Not python3 -m http.server: packages/computer/Dockerfile only
      // installs python3 in its discarded intermediate "terminal" build
      // stage (to compile node-pty's native addon); the shipped final image
      // installs fuse3/libfuse2t64/ca-certificates/curl/git/tini and NOT
      // python3 — confirmed directly against the real VM (`find /` finds no
      // python3 anywhere, exit 127 "command not found"). node IS guaranteed
      // present (it's the image's own base), so a one-line node http server
      // replaces it, serving the same "Directory listing for /" heading
      // python's stdlib server would (this fixture no longer opens the
      // popup to check it, see below, but a real served page is still
      // what's actually running behind the exposed port).
      // The tray button's own accessible name now includes a running-count
      // badge (e.g. "Processes 1"), so this matches the leading word only.
      await desktop.getByRole("button", { name: /^Processes/ }).click();
      const startForm = shed.getByRole("form", { name: "Start a process" });
      await expect(startForm).toBeVisible();
      const processCommand =
        'node -e \'require("http").createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/html"});res.end("<h1>Directory listing for /</h1>")}).listen(8099)\'';
      await startForm
        .getByRole("textbox", { name: "Command" })
        .fill(processCommand);
      await startForm
        .getByRole("spinbutton", { name: "Port (optional)" })
        .fill("8099");
      await startForm
        .getByRole("button", { name: "Start", exact: true })
        .click();
      const processRow = shed.locator('[data-process-state="running"]');
      await expect(processRow).toContainText(processCommand, {
        timeout: 30_000,
      });
      // Same count-badge reason as Processes above ("Ports 1").
      await desktop.getByRole("button", { name: /^Ports/ }).click();
      const exposeForm = shed.getByRole("form", { name: "Expose a port" });
      await expect(exposeForm).toBeVisible();
      await exposeForm
        .getByRole("spinbutton", { name: "Port", exact: true })
        .fill("8099");
      await exposeForm
        .getByRole("button", { name: "Expose", exact: true })
        .click();
      const openPreview = shed.getByRole("button", {
        name: "Open preview of port 8099",
        exact: true,
      });
      await expect(openPreview).toBeVisible({ timeout: 30_000 });
      // Stop here, by CTO decision: this VM fixture's wrangler runs under
      // --local-upstream, which rewrites every request's Host to one fixed
      // value, so the popup itself can never reach a second, distinct
      // preview-tunnel origin through it (confirmed directly: the popup
      // opens but its own "Directory listing" heading never arrives,
      // because the popup's request never reaches the real backend). The
      // real fix (a distinct HTTPS preview origin) needs --local-protocol
      // https, which this VM fixture's vmd cannot yet speak back to
      // (tooling/celld-platform/computer-vm/vmd.mjs's proxyHandlers leaks
      // TLS socket listeners on its https branch — a separate, logged
      // bug). The live demo runs on Cloudflare containers with a real
      // certificate and a real preview origin, not this fixture, so its
      // own rehearsal is the popup's real end-to-end proof; this proof
      // asserts everything the fixture CAN reach for real: the process
      // starts, Ports lists it, expose succeeds, and the preview
      // affordance renders with the right port — then moves straight to
      // Stop.
      await desktop.getByRole("button", { name: /^Processes/ }).click();
      // A HoldButton: stopping a process is a held, not a single, click.
      await processRow
        .getByRole("button", {
          name: `Stop process ${processCommand}`,
          exact: true,
        })
        .click({ delay: 1000 });
      await expect(processRow).toHaveCount(0, { timeout: 30_000 });

      const beforeResize = sent.length;
      await page.setViewportSize({ width: width - 20, height: 800 });
      await expect
        .poll(
          () =>
            sent
              .slice(beforeResize)
              .filter((frame) => !Buffer.isBuffer(frame))
              .map((frame) => JSON.parse(frame))
              .some((frame) => frame.type === "resize"),
          {
            message: "Shed resizes the PTY using the existing resize frame",
            timeout: 10_000,
          },
        )
        .toBe(true);
      // A reconnect's earlier close cannot satisfy navigation disposal.
      await page.evaluate(
        (key) => globalThis.sessionStorage.removeItem(key),
        terminalCloseKey,
      );
      const terminalUrl = terminalSocket.url();
      await page.goto(`${origin}/login`);
      await expect
        .poll(
          () =>
            page.evaluate(
              (key) => globalThis.sessionStorage.getItem(key),
              terminalCloseKey,
            ),
          {
            message: "Leaving Tourtois closes the Shed terminal transport",
            timeout: 10_000,
          },
        )
        .toBe(terminalUrl);
      diagnostics.sockets.push({
        path: new URL(terminalUrl).pathname,
        event: "disposed-on-navigation",
      });
      viewports.push(width);
    } catch (cause) {
      await page.screenshot({
        path: join(work, `failure-${width}.png`),
        fullPage: true,
      });
      diagnostics.failure = redact(
        cause instanceof Error ? cause.message : "Proof failed",
      );
      diagnostics.parentError = await page
        .locator("body")
        .getAttribute("data-oyster-error");
      diagnostics.frames = await Promise.all(
        page.frames().map(async (frame) => ({
          path: new URL(frame.url(), origin).pathname,
          text: redact(
            await frame
              .locator("body")
              .innerText()
              .catch((cause) =>
                cause instanceof Error
                  ? `Frame unavailable: ${cause.message}`
                  : "Frame unavailable: non-Error failure",
              ),
          ),
        })),
      );
      const failureOptions = { cause: Redacted.make(cause) };
      throw new Error(
        `Shed ${runtime} proof failed at ${width}; private diagnostics: ${work}/diagnostics-${width}.json`,
        failureOptions,
      );
    } finally {
      await writeFile(
        join(work, `diagnostics-${width}.json`),
        JSON.stringify(diagnostics, null, 2),
        { mode: 0o600 },
      );
      await page.close();
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    if (
      !startupFailed &&
      worker.exitCode === null &&
      worker.signalCode === null
    )
      worker.kill("SIGTERM");
    await stopped;
    await writeFile(join(work, "worker.log"), redact(workerOutput), {
      mode: 0o600,
    });
  }
}
await writeFile(
  join(work, "receipt.json"),
  JSON.stringify(
    {
      passed: true,
      runtime,
      rootRevision: revision,
      sourceRevision: release.artifact.provenance.sourceRevision,
      tourtoisRevision: tourtois.artifact.provenance.sourceRevision,
      viewports,
      releaseId: release.releaseId,
      checks: [
        "backend-command",
        "terminal-metadata",
        "light-command-runCommand-not-pty",
        "full-pty-pwd-ls-gitlog-raw-bytes",
        "terminal-command",
        "process-start-expose-preview-stop",
        "resize",
        "close",
      ],
      screenshots,
    },
    null,
    2,
  ),
);
globalThis.console.log(
  `PASS unchanged Shed on ${runtime}: backend command, metadata, light runCommand vs full PTY, pwd/ls/git log against the raw PTY byte stream (not a rendered grid), process start/expose/preview/stop, resize, close; ${work}/receipt.json`,
);
