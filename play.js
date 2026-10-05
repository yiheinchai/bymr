/**
 * Backyard Monsters Refitted - browser / PWA shell.
 *
 * Hosts the game SWF in Ruffle, scales it to fit phones, bridges the chat socket to the
 * browser's WebSocket and registers the service worker. Query options:
 *   ?fps=1          show a frame-rate counter
 *   ?quality=high   Ruffle render quality (low, medium, high, best)
 *   ?interp=0       turn off frame interpolation (smooth 120Hz rendering)
 *   ?textcache=0    draw text glyph by glyph instead of through a bitmap cache
 *   ?autocache=0    turn off automatic caching of unchanging panels
 *   ?server=https://...  game server URL (defaults to this page's host)
 *   ?cdn=https://...     asset CDN URL (defaults to the game server)
 *   ?chat=wss://...      chat server URL (defaults to the host the game server names)
 *   ?renderer=webgl Ruffle renderer to prefer (webgpu, wgpu-webgl, webgl, canvas)
 *   ?logout=1       forget the saved session before starting
 */
(() => {
  "use strict";

  /** The area the game's UI is laid out around (GAME._SCREENINIT). */
  const DESIGN_WIDTH = 760;
  const DESIGN_HEIGHT = 670;

  const LANGUAGES = { en: "english", fr: "french", es: "spanish", pt: "portuguese" };

  const params = new URLSearchParams(location.search);
  /** Optional settings for a static deployment, set by a script before this one. */
  const site = window.BYMR_CONFIG || {};
  const viewport = document.getElementById("viewport");
  const stage = document.getElementById("stage");
  const boot = document.getElementById("boot");
  const bootText = document.getElementById("boot-text");
  const fpsBox = document.getElementById("fps");
  const rotate = document.getElementById("rotate");

  const isTouch = matchMedia("(pointer: coarse)").matches;
  const isStandalone = matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;

  /* ------------------------------------------------------------------ *
   * Scaling
   *
   * The game lays its UI out around a 760x670 area and stretches to fill whatever stage size
   * it gets. On a phone in landscape that is far too short, so the stage is given a larger
   * logical size and scaled down with a CSS transform until the design area fits.
   *
   * Ruffle sizes its canvas as CSS size x devicePixelRatio, which would render the scaled-down
   * stage at more pixels than the screen has. devicePixelRatio is reported multiplied by the
   * scale so the canvas matches the physical screen exactly.
   * ------------------------------------------------------------------ */

  const dprDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  const nativeDpr = () => (dprDescriptor && dprDescriptor.get ? dprDescriptor.get.call(window) : 1);
  let stageScale = 1;

  try {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      get: () => nativeDpr() * stageScale,
    });
  } catch {
    // Not overridable here: Ruffle renders at the CSS size instead, which is only less sharp.
  }

  function layout() {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;

    stageScale = Math.min(1, width / DESIGN_WIDTH, height / DESIGN_HEIGHT);
    stage.style.width = `${width / stageScale}px`;
    stage.style.height = `${height / stageScale}px`;
    stage.style.transform = stageScale === 1 ? "" : `scale(${stageScale})`;

    rotate.hidden = !isTouch || width >= height || rotateDismissed;
  }

  let rotateDismissed = false;
  document.getElementById("rotate-dismiss").addEventListener("click", () => {
    rotateDismissed = true;
    layout();
  });

  new ResizeObserver(layout).observe(viewport);
  addEventListener("orientationchange", () => setTimeout(layout, 250));
  layout();

  /* ------------------------------------------------------------------ *
   * Page functions the game calls through ExternalInterface
   * ------------------------------------------------------------------ */

  /** Analytics and Facebook hooks from the original web client. Nothing to do here. */
  const noop = () => undefined;
  window.cc = new Proxy({}, { get: () => noop });
  window.callFunc = noop;
  window.clientCallWithCallback = noop;
  window.setItem = noop;

  /* ------------------------------------------------------------------ *
   * Server error messages
   * ------------------------------------------------------------------ */

  const serverUrl = params.get("server") || site.serverUrl || `${location.origin}/`;
  const apiUrl = new URL("api/", serverUrl).href;

  /**
   * The game server answers a failed request (wrong password, account not verified, name
   * taken) with an error status and a JSON body whose `error` the client shows. Flash in a
   * browser, and Ruffle with it, empties URLLoader.data on an error status, so the client only
   * had "An error occurred during login on the server." URLLoaderApi.load() reads the body on
   * an error the same way it reads a success, so its form-encoded requests to the API get the
   * body with a 200. Requests sent as JSON keep their status.
   */
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (response.ok || !(input instanceof Request) || !input.url.startsWith(apiUrl)) return response;
    if ((input.headers.get("content-type") || "").includes("json")) return response;
    if (!(response.headers.get("content-type") || "").includes("json")) return response;
    const body = await response.text();
    return new Response(body, { status: 200, headers: response.headers });
  };

  /** Chat sockets, opened on behalf of com.monsters.chat.impl.ws.BrowserWebSocket. */
  const sockets = new Map();

  function chatUrl(host, port) {
    if (params.get("chat")) return params.get("chat");
    if (site.chatUrl) return site.chatUrl;
    // A wss:// relay to a chat server that only speaks ws:// (pwa/chat-relay).
    if (site.chatRelay) return `${site.chatRelay}?to=${encodeURIComponent(`${host}:${port}`)}`;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${host}:${port}/`;
  }

  window.bymrSocket = {
    open(id, host, port) {
      const emit = (type, data = "") => {
        // Called from browser events, so Ruffle is never mid-frame here.
        player.ruffle().callExternalInterface("bymrSocketEvent", id, type, String(data));
      };
      let socket;
      try {
        socket = new WebSocket(chatUrl(host, port));
      } catch (error) {
        setTimeout(() => {
          emit("error", error.message);
          emit("close");
        });
        return;
      }
      sockets.set(id, socket);
      socket.onopen = () => emit("open");
      socket.onmessage = (event) => {
        if (typeof event.data === "string") emit("message", event.data);
      };
      socket.onerror = () => emit("error", "connection error");
      socket.onclose = (event) => {
        sockets.delete(id);
        emit("close", event.reason);
      };
    },
    send(id, data) {
      const socket = sockets.get(id);
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close(id) {
      const socket = sockets.get(id);
      sockets.delete(id);
      if (socket) socket.close();
    },
  };

  /* ------------------------------------------------------------------ *
   * Ruffle
   * ------------------------------------------------------------------ */

  function language() {
    const saved = localStorage.getItem("bymr.language");
    if (saved) return saved;
    for (const tag of navigator.languages || [navigator.language || "en"]) {
      const match = LANGUAGES[tag.slice(0, 2).toLowerCase()];
      if (match) return match;
    }
    return "english";
  }

  if (params.get("logout")) {
    // Ruffle keeps SharedObjects in localStorage; the session lives in "bymr_data".
    for (const key of Object.keys(localStorage)) {
      if (key.endsWith("bymr_data")) localStorage.removeItem(key);
    }
  }

  const ruffle = window.RufflePlayer.newest();
  const player = ruffle.createPlayer();
  stage.appendChild(player);

  // Typing on a phone goes through a hidden text box that Ruffle focuses to raise the keyboard.
  // Ruffle hides it above the page, and iOS closes the keyboard straight away for a text box
  // off the screen. Keep it on the screen, still invisible, and at 16px so iOS doesn't zoom.
  const keyboardStyle = document.createElement("style");
  keyboardStyle.textContent = `#virtual-keyboard {
    position: fixed; top: 0; left: 0; width: 1px; height: 1px;
    opacity: 0; font-size: 16px; pointer-events: none;
  }`;
  player.shadowRoot.appendChild(keyboardStyle);

  const config = {
    autoplay: "on",
    unmuteOverlay: "hidden",
    splashScreen: false,
    letterbox: "off",
    contextMenu: "off",
    allowScriptAccess: true,
    openUrlMode: "allow",
    backgroundColor: "#1E2229",
    warnOnUnsupportedContent: false,
    showSwfDownload: false,
    // Without a GPU Ruffle explains how to turn hardware acceleration on, in a box that covers
    // the game and swallows the first tap. Players can't act on it, so don't show it.
    hardwareAccelerationWarning: false,
    // Ruffle drops to "low" on phones by default; keep anti-aliasing unless asked not to.
    quality: params.get("quality") || "medium",
    // Draw in-between frames at the display's refresh rate (needs the patched Ruffle build).
    frameInterpolation: params.get("interp") !== "0",
    // Draw each text field as one cached bitmap instead of one mesh per glyph (patched Ruffle).
    cacheTextAsBitmap: params.get("textcache") !== "0",
    // Draw interface panels that have stopped changing as single cached bitmaps (patched Ruffle).
    autoCache: params.get("autocache") !== "0",
    logLevel: params.get("log") || "error",
  };
  // Ruffle tries wgpu on WebGL first, then WebGPU. Its plain "webgl" renderer is cheaper per
  // draw but has no filters or bitmap caching, so it isn't used unless asked for.
  const FALLBACK_RENDERER = "wgpu-webgl";
  const renderer = params.get("renderer") || localStorage.getItem("bymr.renderer");
  if (renderer) config.preferredRenderer = renderer;

  // Some WebGPU implementations crash Ruffle outright; fall back once and remember it.
  player.addEventListener("panic", () => {
    if (renderer === FALLBACK_RENDERER || params.get("renderer")) return;
    localStorage.setItem("bymr.renderer", FALLBACK_RENDERER);
    location.reload();
  });

  player
    .ruffle()
    .load({
      ...config,
      url: "bymr.swf",
      parameters: {
        platform: "web",
        language: language(),
        // The game server and CDN default to the host serving this page. A static deployment
        // names them in window.BYMR_CONFIG instead (see pwa/README.md).
        serverUrl,
        cdnUrl: params.get("cdn") || params.get("server") || site.cdnUrl || `${location.origin}/`,
      },
    })
    .then(() => {
      boot.classList.add("done");
      setTimeout(() => boot.remove(), 400);
    })
    .catch((error) => {
      bootText.textContent = `Couldn't start the game: ${error.message || error}`;
    });

  function requestFullscreen() {
    const root = document.documentElement;
    if (!root.requestFullscreen) return;
    root
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock("landscape"))
      .catch(noop);
  }

  /** Takes the whole screen on first touch when running in a normal browser tab. */
  function enterFullscreen() {
    if (isStandalone || !isTouch || document.fullscreenElement) return;
    requestFullscreen();
  }
  addEventListener("pointerup", enterFullscreen, { once: true });

  /**
   * The game's own fullscreen button (WebPlatform.toggleFullscreen). Flash's fullscreen would
   * only enlarge the player element, outside the scaling above, so the whole page goes
   * fullscreen instead.
   */
  window.bymrFullscreen = {
    active: () => !!document.fullscreenElement,
    toggle: () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(noop);
      else requestFullscreen();
    },
  };

  /* ------------------------------------------------------------------ *
   * Frame-rate counter (?fps=1)
   * ------------------------------------------------------------------ */

  if (params.get("fps")) {
    fpsBox.hidden = false;
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    let windowStart = last;
    const tick = (now) => {
      frames++;
      worst = Math.max(worst, now - last);
      last = now;
      if (now - windowStart >= 1000) {
        const fps = (frames * 1000) / (now - windowStart);
        fpsBox.textContent = `${fps.toFixed(0)} fps  worst ${worst.toFixed(1)}ms`;
        window.__bymrFps = { fps, worst };
        frames = 0;
        worst = 0;
        windowStart = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------------ *
   * Offline support
   * ------------------------------------------------------------------ */

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(noop));
  }

  window.__bymr = { player, layout, get scale() { return stageScale; } };
})();
