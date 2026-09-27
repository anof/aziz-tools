// End-to-end test for share.aziz.tools.
//
// Opens two separate Chrome tabs (two independent peers), drives the real UI
// in both, sends two files between them over WebRTC, then verifies the bytes
// that arrive by SHA-256. No test hooks in the app itself.
//
// Usage: node tools/e2e-share.mjs [url]      (default http://127.0.0.1:8787/)
//
// No npm dependencies: uses Node's built-in fetch, WebSocket and crypto.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.argv[2] || "http://127.0.0.1:8787/";
const PORT = 9333;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const FILES = [
  { name: "big.bin", size: 3 * 1024 * 1024 + 777, seed: 0 },
  { name: "small.txt", size: 4096, seed: 7 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bytesFor(size, seed) {
  const a = Buffer.alloc(size);
  for (let i = 0; i < size; i++) a[i] = (i + seed) % 251;
  return a;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

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

async function waitForChrome() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error("Chrome did not start on port " + PORT);
}

async function newTab(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return r.json();
}

function connectCdp(wsUrl, label) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = (e) => reject(new Error("cdp socket error"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === "Runtime.exceptionThrown") {
      console.log(`[${label}] page exception:`, msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      console.log(`[${label}] console.${msg.params.type}:`, text);
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
    async eval(expression, awaitPromise) {
      const r = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: !!awaitPromise,
      });
      if (r.exceptionDetails) {
        throw new Error("page error: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },
    close() {
      try { ws.close(); } catch (e) {}
    },
  };
}

const injected = JSON.stringify(
  FILES.map((f) => ({ name: f.name, seed: f.seed, size: f.size }))
);

const injectScript = `
(function () {
  var spec = ${injected};
  var input = document.getElementById("file");
  var peers = document.querySelectorAll("#peers .peer");
  if (!peers.length) return "no peer";
  /* Tap the device first (this clears the input, as it does for a real user),
     then hand the app the chosen files. */
  peers[0].click();
  var dt = new DataTransfer();
  for (var i = 0; i < spec.length; i++) {
    var f = spec[i];
    var a = new Uint8Array(f.size);
    for (var j = 0; j < a.length; j++) a[j] = (j + f.seed) % 251;
    dt.items.add(new File([a], f.name, { type: "application/octet-stream" }));
  }
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "sent " + spec.length + " files";
})()
`;

const readSaves = `
(async function () {
  var links = document.querySelectorAll(".save");
  var out = [];
  for (var i = 0; i < links.length; i++) {
    var buf = await (await fetch(links[i].href)).arrayBuffer();
    var digest = await crypto.subtle.digest("SHA-256", buf);
    var hex = "";
    var view = new Uint8Array(digest);
    for (var j = 0; j < view.length; j++) hex += ("0" + view[j].toString(16)).slice(-2);
    out.push({ name: links[i].getAttribute("download"), size: buf.byteLength, sha: hex });
  }
  return JSON.stringify(out);
})()
`;

// Injected before the app loads. Wraps RTCPeerConnection so the test can see
// connection/ICE/data-channel state without the app exposing any test hooks.
const INSTRUMENT = `
(function () {
  function describe(pc) {
    var dc = pc.__dc;
    return dc ? ("dc " + dc.readyState + " buffered=" + dc.bufferedAmount) : "no dc";
  }
  var Orig = window.RTCPeerConnection;
  function Wrapped() {
    var pc = new Orig((arguments.length ? arguments[0] : undefined));
    window.__pcs = window.__pcs || [];
    window.__pcs.push(pc);
    pc.addEventListener("iceconnectionstatechange", function () {
      console.log("ice:", pc.iceConnectionState, describe(pc));
    });
    pc.addEventListener("connectionstatechange", function () {
      console.log("conn:", pc.connectionState, describe(pc));
    });
    pc.addEventListener("datachannel", function (e) {
      console.log("event: datachannel");
      watch(e.channel);
    });
    var createDc = pc.createDataChannel.bind(pc);
    pc.createDataChannel = function () {
      var dc = createDc.apply(null, arguments);
      console.log("event: createDataChannel");
      watch(dc);
      return dc;
    };
    function watch(dc) {
      pc.__dc = dc;
      dc.addEventListener("open", function () { console.log("dc: open"); });
      dc.addEventListener("close", function () { console.log("dc: close"); });
      dc.addEventListener("error", function () { console.log("dc: error"); });
      dc.addEventListener("message", function (ev) {
        var d = ev.data;
        if (typeof d === "string") console.log("dc: msg text", d.slice(0, 60));
        else console.log("dc: msg binary", d.byteLength);
      });
    }
    return pc;
  }
  Wrapped.prototype = Orig.prototype;
  window.RTCPeerConnection = Wrapped;
})()
`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "aziz-share-e2e-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=CalculateNativeWinOcclusion",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--window-size=1000,800",
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let a, b;
  try {
    await waitForChrome();

    const tabA = await newTab("about:blank");
    const tabB = await newTab("about:blank");
    a = connectCdp(tabA.webSocketDebuggerUrl, "A");
    b = connectCdp(tabB.webSocketDebuggerUrl, "B");
    await Promise.all([a.opened, b.opened]);
    await Promise.all([
      a.send("Runtime.enable"),
      b.send("Runtime.enable"),
      a.send("Page.enable"),
      b.send("Page.enable"),
    ]);
    await Promise.all([
      a.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT }),
      b.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT }),
    ]);
    await Promise.all([a.send("Page.navigate", { url: TARGET }), b.send("Page.navigate", { url: TARGET })]);

    console.log("target:", TARGET);

    // Each page must be past "Connecting..." - either it shows the waiting
    // hint (no peers yet) or it already lists the other tab.
    const ready = `!!(document.querySelector("#peers .peer") || document.querySelector("#peers .waiting"))`;
    await waitFor(() => a.eval(ready), 20000, "tab A websocket connect");
    await waitFor(() => b.eval(ready), 20000, "tab B websocket connect");
    console.log("signaling: both tabs connected to /ws");

    // Name each device.
    await a.eval(`(function(){var n=document.getElementById("name");n.value="Test A";n.dispatchEvent(new Event("change"));return n.value;})()`);
    await b.eval(`(function(){var n=document.getElementById("name");n.value="Test B";n.dispatchEvent(new Event("change"));return n.value;})()`);

    const peerSeen = await waitFor(
      () => a.eval(`(function(){var p=document.querySelector("#peers .peer .pname");return p&&p.textContent==="Test B"?"Test B":"";})()`),
      15000,
      "tab A to discover tab B"
    );
    console.log("discovery: tab A sees ->", peerSeen);

    await waitFor(
      () => b.eval(`(function(){var p=document.querySelector("#peers .peer .pname");return p&&p.textContent==="Test A"?"Test A":"";})()`),
      15000,
      "tab B to discover tab A"
    );

    // Send.
    await a.send("Page.bringToFront");   // background tabs get timer-throttled
    const startedAt = Date.now();
    const injectedResult = await a.eval(injectScript);
    console.log("send: ", injectedResult);

    await waitFor(
      () => b.eval(`document.querySelectorAll(".save").length === ${FILES.length}`),
      90000,
      "tab B to receive " + FILES.length + " files"
    );
    const elapsedMs = Date.now() - startedAt;

    const received = JSON.parse(await b.eval(readSaves, true));
    const senderStats = await a.eval(`(function(){var s=document.querySelectorAll("#transfers .stat");var o=[];for(var i=0;i<s.length;i++)o.push(s[i].textContent);return JSON.stringify(o);})()`);
    const receiverStats = await b.eval(`(function(){var s=document.querySelectorAll("#transfers .stat");var o=[];for(var i=0;i<s.length;i++)o.push(s[i].textContent);return JSON.stringify(o);})()`);

    console.log("");
    console.log("sender progress:  ", JSON.parse(senderStats).join(" | "));
    console.log("receiver progress:", JSON.parse(receiverStats).join(" | "));
    console.log("wall clock:        " + elapsedMs + " ms for " + FILES.reduce((n, f) => n + f.size, 0) + " bytes");
    console.log("");

    let failures = 0;
    for (let i = 0; i < FILES.length; i++) {
      const expected = bytesFor(FILES[i].size, FILES[i].seed);
      const want = { name: FILES[i].name, size: expected.length, sha: sha256(expected) };
      const got = received[i];
      const nameOk = got && got.name === want.name;
      const sizeOk = got && got.size === want.size;
      const shaOk = got && got.sha === want.sha;
      if (!(nameOk && sizeOk && shaOk)) failures++;
      console.log(
        (nameOk && sizeOk && shaOk ? "PASS  " : "FAIL  ") +
          want.name.padEnd(12) +
          " size " + (got ? got.size : "-") + "/" + want.size +
          "  sha256 " + (shaOk ? "match" : "MISMATCH " + (got ? got.sha : "-"))
      );
    }

    // Visual proof: screenshot the receiving page.
    const shot = await b.send("Page.captureScreenshot", { format: "png" });
    const out = "/tmp/aziz-share-received.png";
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("");
    console.log("receiver screenshot:", out);
    console.log(failures === 0 ? "RESULT: PASS" : "RESULT: FAIL (" + failures + ")");
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    if (a) a.close();
    if (b) b.close();
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("RESULT: FAIL -", e.message);
  process.exitCode = 1;
});
