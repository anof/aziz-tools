// End-to-end test for shade.aziz.tools.
//
// Drives the real UI in headless Chrome: searches two real addresses through
// Photon, picks the suggestions, waits for the verdict, and also exercises the
// "use my location" button with a simulated GPS fix.
//
// Usage: node tools/shade-test.mjs [url]

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.argv[2] || "http://localhost:4321/shade/public/index.html";
const FROM_ADDRESS = process.env.SHADE_FROM || "Union Station, Los Angeles";
const TO_ADDRESS = process.env.SHADE_TO || "Santa Monica Pier";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9338;
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

function connectCdp(wsUrl) {
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
      console.log("page exception:", msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
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

const typeInto = (id, text) => `
(function () {
  var el = document.getElementById(${JSON.stringify(id)});
  el.focus();
  el.value = ${JSON.stringify(text)};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
})()
`;

const clickFirstSuggestion = `
(function () {
  var li = document.querySelectorAll("#list li");
  if (!li.length) return "";
  var text = li[0].textContent;
  li[0].click();
  return text;
})()
`;

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "aziz-shade-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
      } catch (e) {}
      await sleep(250);
    }
    const tab = await (
      await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })
    ).json();
    cdp = connectCdp(tab.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setGeolocationOverride", { latitude: 34.0522, longitude: -118.2437, accuracy: 20 });
    await cdp.send("Browser.grantPermissions", { origin: new URL(TARGET).origin, permissions: ["geolocation"] });
    await cdp.send("Page.navigate", { url: TARGET });

    console.log("target:", TARGET);

    // Current location button -> fills the field with a reverse-geocoded label.
    await waitFor(() => cdp.eval(`!!document.getElementById("fromLoc")`), 15000, "page load");
    await cdp.eval(`document.getElementById("fromLoc").click()`);
    const located = await waitFor(
      () => cdp.eval(`document.getElementById("from").value`),
      20000,
      "current location to fill the From field"
    );
    console.log("location button ->", located);

    // Real address search through Photon.
    await cdp.eval(typeInto("from", FROM_ADDRESS));
    const fromPick = await waitFor(() => cdp.eval(clickFirstSuggestion), 20000, "From suggestions");
    console.log("from search  ->", fromPick);

    await cdp.eval(typeInto("to", TO_ADDRESS));
    const toPick = await waitFor(() => cdp.eval(clickFirstSuggestion), 20000, "To suggestions");
    console.log("to search    ->", toPick);

    const verdict = await waitFor(
      () => cdp.eval(`document.getElementById("side").textContent`).then((t) => (/Sit on the|Either side/.test(t) ? t : "")),
      25000,
      "verdict"
    );
    const why = await cdp.eval(`document.getElementById("why").textContent`);
    const facts = await cdp.eval(`document.getElementById("facts").textContent`);
    console.log("");
    console.log("verdict:", verdict.replace("no strong shade side", "").trim());
    console.log("why:    ", why);
    console.log("facts:  ", facts.replace(/\s+/g, " ").trim());

    // Saved trip: save, then reload and load it back.
    await cdp.eval(`document.getElementById("saveBtn").click()`);
    await cdp.eval(`document.getElementById("saveHome").click()`);
    const saved = await cdp.eval(`localStorage.getItem("shade.fav")`);
    const reloadOk = await cdp
      .send("Page.reload", {})
      .then(() => sleep(1500))
      .then(() => cdp.eval(`document.getElementById("from").value`));
    console.log("");
    console.log("saved trip:", saved ? "stored in localStorage" : "NOT SAVED");
    console.log("after reload, From field restored ->", reloadOk);

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const out = "/tmp/aziz-shade.png";
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("screenshot:", out);

    const failures = [];
    if (!/Sit on the (LEFT|RIGHT)|Either side/.test(verdict)) failures.push("no verdict");
    if (!/Bus heading/.test(facts)) failures.push("no heading in facts");
    if (!saved) failures.push("favorite not saved");
    if (!reloadOk) failures.push("trip not restored after reload");
    console.log(failures.length ? "RESULT: FAIL - " + failures.join(", ") : "RESULT: PASS");
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("RESULT: FAIL -", e.message);
  process.exitCode = 1;
});
