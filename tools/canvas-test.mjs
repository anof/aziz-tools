// End-to-end test for canvas.aziz.tools (the Next.js infinite-canvas project).
//
// Emulates a phone for touch (draw, pinch past 10x, pan, mid-stroke takeover,
// touch eraser, sessions) and then a desktop for mouse drawing and wheel zoom.
//
// Usage: node tools/canvas-test.mjs [url]

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET = process.argv[2] || "http://127.0.0.1:8790/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9340;
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
    await sleep(150);
  }
  throw new Error("timed out waiting for " + label + " (last: " + JSON.stringify(last) + ")");
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), "aziz-infinite-canvas-"));
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

    const mobile = () => cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    const desktop = () => cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1200, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    const enableTouch = () => cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    const disableTouch = () => cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    const navigate = async () => {
      await cdp.send("Page.navigate", { url: TARGET });
      await sleep(1400);
    };

    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p) => ({
        x: p.x, y: p.y, id: p.id, radiusX: 2, radiusY: 2, force: 1,
      })),
    });

    const pathCount = () => cdp.eval(`document.querySelectorAll('main svg polyline').length`);
    const sessionText = () => cdp.eval(`(document.querySelector('[data-testid="session-name"]') || {}).textContent || ""`);
    const sessionName = async () => (await sessionText()).split(" · ")[0];
    const transform = async () => {
      const attr = await cdp.eval(`(document.querySelector('main svg g') || {}).getAttribute ? document.querySelector('main svg g').getAttribute('transform') : ""`);
      const m = /translate\(\s*([-\d.e+]+)[,\s]+([-\d.e+]+)\s*\)\s*scale\(\s*([-\d.e+]+)\s*\)/i.exec(attr || "");
      return m ? { x: +m[1], y: +m[2], s: +m[3] } : { x: 0, y: 0, s: 1 };
    };
    const savedSessions = () => cdp.eval(`JSON.parse(localStorage.getItem("infinite-canvas-saves") || "[]")`);

    async function drawTouch(points) {
      const id = ++touchId;
      await touch("touchStart", [{ id, x: points[0].x, y: points[0].y }]);
      for (let i = 1; i < points.length; i++) {
        await touch("touchMove", [{ id, x: points[i].x, y: points[i].y }]);
        await sleep(8);
      }
      await touch("touchEnd", []);
      await sleep(120);
    }

    async function twoFinger(a1, b1, a2, b2, steps = 7) {
      const id1 = ++touchId;
      const id2 = ++touchId;
      await touch("touchStart", [{ id: id1, x: a1.x, y: a1.y }, { id: id2, x: b1.x, y: b1.y }]);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await touch("touchMove", [
          { id: id1, x: a1.x + (a2.x - a1.x) * t, y: a1.y + (a2.y - a1.y) * t },
          { id: id2, x: b1.x + (b2.x - b1.x) * t, y: b1.y + (b2.y - b1.y) * t },
        ]);
        await sleep(12);
      }
      await touch("touchEnd", []);
      await sleep(120);
    }

    async function rectOf(selector) {
      return cdp.eval(`(function(){
        var el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }

    async function rectOfText(selector, text) {
      return cdp.eval(`(function(){
        var els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
        var el = els.find(function (e) { return e.textContent.indexOf(${JSON.stringify(text)}) >= 0; });
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
    }

    async function clickAt(point) {
      if (!point) throw new Error("element not found");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await sleep(300);
    }

    async function openMenu() {
      await clickAt(await rectOf('[data-testid="session-menu"]'));
      await waitFor(() => cdp.eval(`!!document.querySelector('[role="menu"]')`), 5000, "sessions menu");
    }

    async function closeMenu() {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
      await sleep(250);
    }

    async function createDrawing() {
      await openMenu();
      const item = await rectOfText('[role="menuitem"]', "New Drawing");
      await clickAt(item);
      await sleep(400);
    }

    // ---------- touch / mobile ----------
    await mobile();
    await enableTouch();
    await navigate();

    check(
      (await cdp.eval(`getComputedStyle(document.querySelector('main')).touchAction`)) === "none",
      "canvas disables browser scroll/zoom",
    );
    check(
      !(await cdp.eval(`!!document.querySelector('[data-testid="trackpad-mode"]')`)),
      "trackpad mode is removed",
    );

    // Rename the first session so tests can find it unambiguously.
    const firstName = await sessionName();
    await openMenu();
    await clickAt(await rectOf(`button[aria-label="Rename ${firstName}"]`));
    await waitFor(() => cdp.eval(`!!document.querySelector('[role="menu"] input')`), 5000, "rename input");
    await cdp.eval(`(function(){
      var input = document.querySelector('[role="menu"] input');
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Session A');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
      return input.value;
    })()`);
    await waitFor(async () => (await sessionName()) === "Session A", 5000, "rename session");
    await closeMenu();
    check((await sessionName()) === "Session A", "session rename works");

    // Draw with one finger.
    await drawTouch([
      { x: 60, y: 300 }, { x: 100, y: 320 }, { x: 150, y: 360 },
      { x: 210, y: 330 }, { x: 270, y: 320 }, { x: 320, y: 360 },
    ]);
    check((await pathCount()) === 1, "one finger draws", "lines=" + (await pathCount()));

    // Pinch repeatedly: the source had no upper limit; verify past 10x.
    for (let i = 0; i < 4; i++) {
      await twoFinger({ x: 110, y: 430 }, { x: 280, y: 430 }, { x: 25, y: 430 }, { x: 365, y: 430 });
    }
    const zoomed = await transform();
    check(zoomed.s > 10, "pinch zooms past 10x (unbounded)", zoomed.s.toFixed(2) + "x");
    check((await sessionText()).includes("×"), "zoom level is visible in the session chip", await sessionText());
    check((await pathCount()) === 1, "pinching does not add strokes");

    // Two-finger pan.
    const beforePan = await transform();
    await twoFinger({ x: 140, y: 560 }, { x: 250, y: 560 }, { x: 210, y: 600 }, { x: 320, y: 600 });
    const afterPan = await transform();
    check(Math.abs(afterPan.x - beforePan.x) > 20, "two fingers pan the infinite canvas", beforePan.x.toFixed(0) + " -> " + afterPan.x.toFixed(0));

    // Zoom far out as well: no lower stop at 0.1x.
    for (let i = 0; i < 4; i++) {
      await twoFinger({ x: 25, y: 430 }, { x: 365, y: 430 }, { x: 155, y: 430 }, { x: 235, y: 430 });
    }
    const zoomedOut = await transform();
    check(zoomedOut.s < 0.1, "pinch zooms out below 0.1x (unbounded)", zoomedOut.s.toFixed(4) + "x");

    // A second finger mid-stroke takes over and cancels the accidental stroke.
    const countBeforeMid = await pathCount();
    const idA = ++touchId;
    const idB = ++touchId;
    await touch("touchStart", [{ id: idA, x: 150, y: 500 }]);
    await touch("touchMove", [{ id: idA, x: 180, y: 510 }]);
    await touch("touchMove", [{ id: idA, x: 210, y: 520 }]);
    const midCount = await pathCount();
    const midScale = (await transform()).s;
    await touch("touchStart", [{ id: idA, x: 210, y: 520 }, { id: idB, x: 310, y: 520 }]);
    await touch("touchMove", [{ id: idA, x: 180, y: 520 }, { id: idB, x: 340, y: 520 }]);
    await touch("touchEnd", []);
    await sleep(150);
    check(midCount === countBeforeMid + 1, "first finger starts a stroke before second arrives");
    check((await pathCount()) === countBeforeMid, "mid-stroke second finger removes the partial stroke");
    check((await transform()).s > midScale, "mid-stroke second finger engages pinch");

    // New session: fresh transform, then touch eraser.
    await createDrawing();
    check((await pathCount()) === 0, "new drawing starts empty");
    await drawTouch([
      { x: 70, y: 400 }, { x: 120, y: 400 }, { x: 180, y: 400 },
      { x: 240, y: 400 }, { x: 310, y: 400 },
    ]);
    check((await pathCount()) === 1, "drawing in the new session");
    await clickAt(await rectOf('[data-testid="eraser"]'));
    const eraserOn = await cdp.eval(`document.querySelector('[data-testid="eraser"]').getAttribute('aria-label') === 'Disable eraser'`);
    const idE = ++touchId;
    await touch("touchStart", [{ id: idE, x: 190, y: 400 }]);
    await touch("touchEnd", []);
    await sleep(150);
    check(eraserOn, "eraser toggles on");
    check((await pathCount()) === 0, "one finger erases a line", "lines=" + (await pathCount()));
    await clickAt(await rectOf('[data-testid="eraser"]'));

    // Switch back to Session A.
    await openMenu();
    await clickAt(await rectOfText('[role="menuitem"]', "Session A"));
    await waitFor(async () => (await sessionName()) === "Session A", 5000, "switch back to Session A");
    check((await pathCount()) === 1, "switching sessions restores its lines");

    // Reload persistence.
    await cdp.send("Page.reload");
    await sleep(1500);
    check((await sessionName()) === "Session A", "active session survives reload");
    check((await pathCount()) === 1, "lines survive reload");

    // Save-on-switch: draw, immediately create another session, switch back.
    await drawTouch([{ x: 80, y: 620 }, { x: 140, y: 630 }, { x: 220, y: 650 }]);
    await createDrawing();
    await openMenu();
    await clickAt(await rectOfText('[role="menuitem"]', "Session A"));
    await waitFor(async () => (await sessionName()) === "Session A", 5000, "switch back after quick save");
    check((await pathCount()) === 2, "last stroke is saved when switching immediately", "lines=" + (await pathCount()));

    // Delete the other session.
    const sessionsBeforeDelete = await savedSessions();
    const other = sessionsBeforeDelete.find((s) => s.name !== "Session A");
    if (other) {
      await openMenu();
      await clickAt(await rectOf(`button[aria-label="Delete ${other.name}"]`));
      await waitFor(() => cdp.eval(`!!document.querySelector('[role="alertdialog"]')`), 5000, "delete dialog");
      await clickAt(await rectOfText('[role="alertdialog"] button', "Delete"));
      await sleep(400);
      const remaining = await savedSessions();
      check(!remaining.some((s) => s.id === other.id), "delete removes a saved session");
    } else {
      check(false, "found a second session to delete");
    }

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync("/tmp/canvas-next-mobile.png", Buffer.from(shot.data, "base64"));
    check((await cdp.eval(`window.scrollY === 0 && document.documentElement.scrollTop === 0`)), "page never scrolls");

    // ---------- mouse / desktop ----------
    await disableTouch();
    await desktop();
    await cdp.send("Page.reload");
    await sleep(1400);

    const beforeMouseDraw = await pathCount();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 220, y: 260, button: "left", clickCount: 1 });
    for (const p of [{ x: 260, y: 280 }, { x: 320, y: 300 }, { x: 380, y: 260 }]) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 });
      await sleep(15);
    }
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 380, y: 260, button: "left", clickCount: 1 });
    await sleep(250);
    check((await pathCount()) === beforeMouseDraw + 1, "mouse drag draws");

    const beforeWheelZoom = (await transform()).s;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: -240, modifiers: 2,
    });
    await sleep(250);
    const afterWheelZoom = (await transform()).s;
    check(afterWheelZoom > beforeWheelZoom, "ctrl/cmd + wheel zooms in", beforeWheelZoom.toFixed(2) + "x -> " + afterWheelZoom.toFixed(2) + "x");
    check((await cdp.eval(`visualViewport ? visualViewport.scale : 1`)) === 1, "browser page zoom stays at 1");

    const beforeWheelPan = await transform();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 600, y: 400, deltaX: 40, deltaY: 90, modifiers: 0,
    });
    await sleep(250);
    const afterWheelPan = await transform();
    check(Math.abs(afterWheelPan.x - beforeWheelPan.x) > 5, "plain wheel pans the canvas");

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
