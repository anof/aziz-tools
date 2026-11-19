// Touch end-to-end test for canvas.aziz.tools.
//
// Emulates a phone with touch input and drives the real page:
//   one finger draws, two fingers pan/pinch, a second finger mid-stroke must
//   take over without committing a stroke, eraser removes strokes, clear empties.
//
// Usage: node tools/canvas-test.mjs [url]

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.argv[2] || "http://127.0.0.1:8790/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9339;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok, label, detail) {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (detail ? "  (" + detail + ")" : ""));
  if (!ok) failures++;
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

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "aziz-canvas-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  let touchId = 0;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break;
      } catch (e) {}
      await sleep(250);
    }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" })).json();
    cdp = connectCdp(tab.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Page.navigate", { url: TARGET });
    await sleep(1200);

    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p) => ({
        x: p.x, y: p.y, id: p.id, radiusX: 2, radiusY: 2, force: 1,
      })),
    });

    const pathCount = () => cdp.eval(`document.querySelectorAll("#strokes path").length`);
    const transform = async () => {
      const t = await cdp.eval(`document.getElementById("world").getAttribute("transform")`);
      const m = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)/.exec(t || "");
      return m ? { x: +m[1], y: +m[2], s: +m[3] } : null;
    };
    const activeD = () => cdp.eval(`document.getElementById("active").getAttribute("d") || ""`);

    async function drawStroke(pts) {
      const id = ++touchId;
      await touch("touchStart", [{ id, x: pts[0].x, y: pts[0].y }]);
      for (let i = 1; i < pts.length; i++) {
        await touch("touchMove", [{ id, x: pts[i].x, y: pts[i].y }]);
        await sleep(6);
      }
      await touch("touchEnd", []);
      await sleep(80);
    }

    async function twoFinger(a1, b1, a2, b2, steps) {
      const id1 = ++touchId;
      const id2 = ++touchId;
      await touch("touchStart", [{ id: id1, x: a1.x, y: a1.y }, { id: id2, x: b1.x, y: b1.y }]);
      for (let i = 1; i <= (steps || 6); i++) {
        const t = i / (steps || 6);
        await touch("touchMove", [
          { id: id1, x: a1.x + (a2.x - a1.x) * t, y: a1.y + (a2.y - a1.y) * t },
          { id: id2, x: b1.x + (b2.x - b1.x) * t, y: b1.y + (b2.y - b1.y) * t },
        ]);
        await sleep(12);
      }
      await touch("touchEnd", []);
      await sleep(80);
    }

    const touchAction = await cdp.eval(`getComputedStyle(document.getElementById("canvas")).touchAction`);
    check(touchAction === "none", "canvas disables browser scroll/zoom (touch-action: none)", touchAction);

    // 1. One finger draws.
    await drawStroke([
      { x: 70, y: 220 }, { x: 110, y: 240 }, { x: 150, y: 300 },
      { x: 190, y: 260 }, { x: 230, y: 240 }, { x: 270, y: 300 },
    ]);
    check((await pathCount()) === 1, "one finger creates one stroke", "paths=" + (await pathCount()));
    check((await activeD()) === "", "active stroke is cleared after lift");

    // 2. Two fingers spread: pinch zoom in, no new stroke.
    const beforePinch = await transform();
    await twoFinger({ x: 140, y: 430 }, { x: 250, y: 430 }, { x: 90, y: 430 }, { x: 300, y: 430 });
    const afterPinch = await transform();
    check(afterPinch.s > beforePinch.s * 1.3, "pinch zooms in", beforePinch.s.toFixed(2) + " -> " + afterPinch.s.toFixed(2));
    check((await pathCount()) === 1, "pinch does not add a stroke");

    // 3. Two fingers together: pan, scale unchanged.
    const beforePan = await transform();
    await twoFinger({ x: 130, y: 520 }, { x: 250, y: 520 }, { x: 190, y: 570 }, { x: 310, y: 570 });
    const afterPan = await transform();
    check(Math.abs(afterPan.x - beforePan.x) > 30, "two fingers pan the canvas", beforePan.x.toFixed(0) + " -> " + afterPan.x.toFixed(0));
    check(Math.abs(afterPan.s - beforePan.s) < 0.01, "pure pan keeps the zoom level");
    check((await pathCount()) === 1, "pan does not add a stroke");

    // 4. Second finger arriving mid-stroke must take over, not commit.
    const countBeforeMid = await pathCount();
    const idA = ++touchId;
    const idB = ++touchId;
    await touch("touchStart", [{ id: idA, x: 120, y: 340 }]);
    await touch("touchMove", [{ id: idA, x: 150, y: 350 }]);
    await touch("touchMove", [{ id: idA, x: 180, y: 360 }]);
    const midActive = await activeD();
    const scaleBeforeMid = (await transform()).s;
    await touch("touchStart", [{ id: idA, x: 180, y: 360 }, { id: idB, x: 300, y: 360 }]);
    await touch("touchMove", [{ id: idA, x: 150, y: 360 }, { id: idB, x: 330, y: 360 }]);
    await touch("touchEnd", []);
    await sleep(80);
    const scaleAfterMid = (await transform()).s;
    check(midActive.length > 0, "one finger starts a stroke before the second arrives");
    check((await pathCount()) === countBeforeMid, "mid-stroke second finger commits nothing");
    check((await activeD()) === "", "mid-stroke second finger clears the partial stroke");
    check(scaleAfterMid > scaleBeforeMid, "mid-stroke second finger engages pinch");

    // 5. Eraser removes a stroke.
    const idE = ++touchId;
    await touch("touchStart", [{ id: idE, x: 70, y: 220 }]);
    await touch("touchMove", [{ id: idE, x: 120, y: 235 }]);
    await touch("touchMove", [{ id: idE, x: 170, y: 290 }]);
    await touch("touchEnd", []);
    await sleep(80);
    const beforeErase = await pathCount();
    await cdp.eval(`document.getElementById("eraser").click()`);
    const eraserOn = await cdp.eval(`document.getElementById("eraser").classList.contains("active")`);
    const idF = ++touchId;
    await touch("touchStart", [{ id: idF, x: 120, y: 235 }]);
    await touch("touchEnd", []);
    await sleep(80);
    const afterErase = await pathCount();
    check(eraserOn, "eraser toggles on");
    check(afterErase < beforeErase, "one finger erases under the finger", beforeErase + " -> " + afterErase);
    await cdp.eval(`document.getElementById("eraser").click()`);

    // 6. Clear.
    await cdp.eval(`document.getElementById("clear").click()`);
    await sleep(60);
    check((await pathCount()) === 0, "clear removes every stroke");

    // 7. Draw an infinity symbol, then a gentle pinch, for a visual check.
    const loop = [];
    for (let i = 0; i <= 110; i++) {
      const t = (i / 110) * Math.PI * 2;
      loop.push({ x: 195 + 92 * Math.cos(t), y: 470 + 52 * Math.sin(2 * t) });
    }
    await drawStroke(loop);
    await twoFinger({ x: 150, y: 470 }, { x: 240, y: 470 }, { x: 135, y: 470 }, { x: 255, y: 470 });

    const scroll = JSON.parse(await cdp.eval(
      `JSON.stringify({y:window.scrollY, top:document.documentElement.scrollTop, inner:innerHeight, scale:getComputedStyle(document.documentElement).touchAction})`
    ));
    check(scroll.y === 0 && scroll.top === 0, "page never scrolls", JSON.stringify(scroll));

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync("/tmp/canvas-app.png", Buffer.from(shot.data, "base64"));
    console.log("screenshot: /tmp/canvas-app.png");

    console.log(failures ? "RESULT: FAIL (" + failures + ")" : "RESULT: PASS");
    process.exitCode = failures ? 1 : 0;
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
  }
}

main().catch((e) => {
  console.error("RESULT: FAIL -", e.message);
  process.exitCode = 1;
});
