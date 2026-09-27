// End-to-end test for device pairing.
//
// Uses two separate Chrome profiles, because two tabs in one profile share
// localStorage - that would make pairing look like it works when it does not.
// Flow: A creates a code, B joins with it, both reconnect, both must see each
// other, and the footer must report the paired code.
//
// Usage: node tools/pair-test.mjs [url]

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.argv[2] || "http://127.0.0.1:8787/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(250);
  }
  throw new Error("timed out waiting for " + label + " (last: " + JSON.stringify(last) + ")");
}

function connectCdp(wsUrl, label) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("cdp socket error"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.exceptionThrown") {
      console.log(`[${label}] page exception:`, msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  };
  return {
    opened,
    send(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params: params || {} }));
      });
    },
    async eval(expression) {
      const r = await this.send("Runtime.evaluate", { expression, returnByValue: true });
      if (r.exceptionDetails) throw new Error("page error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    close() { try { ws.close(); } catch (e) {} },
  };
}

async function launch(port, label) {
  const profile = mkdtempSync(join(tmpdir(), "aziz-pair-" + label + "-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });

  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch (e) {}
    await sleep(250);
  }
  const tab = await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })
  ).json();
  const cdp = connectCdp(tab.webSocketDebuggerUrl, label);
  await cdp.opened;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: TARGET });
  return { chrome, cdp };
}

const ready = `!!(document.querySelector("#peers .peer") || /Looking for/.test((document.querySelector("#peers .waiting") || {}).textContent || ""))`;
const peerCount = `document.querySelectorAll("#peers .peer").length`;
const footer = `document.getElementById("netlabel").textContent`;
const has = (id) => `!!document.getElementById("${id}")`;

async function click(cdp, id, label) {
  await waitFor(() => cdp.eval(has(id)), 20000, label + " to have #" + id);
  return cdp.eval(`(function(){document.getElementById("${id}").click();return 1;})()`);
}

async function main() {
  const a = await launch(9336, "A");
  const b = await launch(9337, "B");
  try {
    await waitFor(() => a.cdp.eval(ready), 20000, "device A connect");
    await waitFor(() => b.cdp.eval(ready), 20000, "device B connect");
    console.log("both devices connected, unpaired");

    // A creates a pairing code.
    await click(a.cdp, "pair", "device A");
    await click(a.cdp, "paircreate", "device A");
    const text = await a.cdp.eval(`document.getElementById("pairtext").textContent`);
    const code = (text.match(/[A-Z2-9]{8}/) || [])[0];
    if (!code) throw new Error("device A did not produce a pairing code: " + text);
    console.log("device A pairing code:", code);

    // B joins with that code.
    await click(b.cdp, "pair", "device B");
    await waitFor(() => b.cdp.eval(has("pairjoin")), 20000, "device B to have #pairjoin");
    await b.cdp.eval(`(function(){document.getElementById("paircode").value=${JSON.stringify(code)};document.getElementById("pairjoin").click();return 1;})()`);

    // A reconnects into the paired room.
    await sleep(1500);
    await click(a.cdp, "paircreate", "device A (reconnect)");

    const footA = await waitFor(() => a.cdp.eval(footer).then((t) => (t.indexOf("paired") === 0 ? t : "")), 20000, "device A paired footer");
    const footB = await waitFor(() => b.cdp.eval(footer).then((t) => (t.indexOf("paired") === 0 ? t : "")), 20000, "device B paired footer");
    console.log("footer A:", footA.trim(), "| footer B:", footB.trim());

    await waitFor(() => a.cdp.eval(peerCount).then((n) => n === 1), 20000, "device A to see device B in the paired room");
    await waitFor(() => b.cdp.eval(peerCount).then((n) => n === 1), 20000, "device B to see device A in the paired room");
    console.log("PASS: both devices discovered each other in the paired room");
  } finally {
    a.cdp.close();
    b.cdp.close();
    a.chrome.kill();
    b.chrome.kill();
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
});
