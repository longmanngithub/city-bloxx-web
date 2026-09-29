import { LibMedia } from "../libmedia/libmedia.js";
import { LibMidi, createUnlockingAudioContext } from "../libmidi/libmidi.js";
import { codeMap } from "./key.js";
import { EventQueue } from "./eventqueue.js";

// Native library bindings for CheerpJ
import canvasFontNatives from "../libjs/libcanvasfont.js";
import canvasGraphicsNatives from "../libjs/libcanvasgraphics.js";
import gles2Natives from "../libjs/libgles2.js";
import jsReferenceNatives from "../libjs/libjsreference.js";
import mediaBridgeNatives from "../libjs/libmediabridge.js";
import midiBridgeNatives from "../libjs/libmidibridge.js";

// Synthesizer for tactile Nokia keypad clicks
class KeySoundPlayer {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.ctx = new AudioCtx();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  playClick() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(800, t);
      osc.frequency.exponentialRampToValueAtTime(120, t + 0.015);

      gain.gain.setValueAtTime(0.09, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.015);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.onended = () => {
        try {
          osc.disconnect();
          gain.disconnect();
        } catch (_) {}
      };

      osc.start(t);
      osc.stop(t + 0.016);
    } catch (_) {}
  }
}

// Clean Keypad Controller: strictly 1 keydown on press, 1 keyup on release
class KeypadController {
  constructor(eventQueue, soundPlayer) {
    this.queue = eventQueue;
    this.sound = soundPlayer;
    this.activeKeys = new Map(); // keyStr -> { repeatTimer, repeatInterval }
  }

  press(keyStr) {
    const code = codeMap[keyStr];
    if (!code) return;

    // Cleanly release any prior state before pressing again
    if (this.activeKeys.has(keyStr)) {
      this.release(keyStr);
    }

    this.sound.init();
    this.sound.playClick();
    if (navigator.vibrate) {
      try { navigator.vibrate(12); } catch (_) {}
    }

    const symbol = keyStr.startsWith('Digit') ? keyStr.substring(5) : '\x00';

    // Send initial keydown
    this.queue.queueEvent({
      kind: 'keydown',
      args: [code, symbol, false, false]
    });

    // Key repeat for holding buttons down
    const repeatTimer = setTimeout(() => {
      const repeatInterval = setInterval(() => {
        if (this.activeKeys.has(keyStr)) {
          this.queue.queueEvent({
            kind: 'keydown',
            args: [code, symbol, false, false]
          });
        }
      }, 70);

      const state = this.activeKeys.get(keyStr);
      if (state) state.repeatInterval = repeatInterval;
    }, 380);

    this.activeKeys.set(keyStr, { repeatTimer, repeatInterval: null });
  }

  release(keyStr) {
    const code = codeMap[keyStr];
    if (!code) return;

    const state = this.activeKeys.get(keyStr);
    if (state) {
      clearTimeout(state.repeatTimer);
      if (state.repeatInterval) clearInterval(state.repeatInterval);
      this.activeKeys.delete(keyStr);
    }

    const symbol = keyStr.startsWith('Digit') ? keyStr.substring(5) : '\x00';

    // Send keyup
    this.queue.queueEvent({
      kind: 'keyup',
      args: [code, symbol, false, false]
    });
  }

  releaseAll() {
    for (const keyStr of Array.from(this.activeKeys.keys())) {
      this.release(keyStr);
    }
  }
}

const keySound = new KeySoundPlayer();
const evtQueue = new EventQueue();
const keypad = new KeypadController(evtQueue, keySound);
window.evtQueue = evtQueue;

const cheerpjWebRoot = '/app' + location.pathname.replace(/\/[^/]*$/, '');

let display = null;
let screenCtx = null;
let offscreenCanvas = null;
let offscreenCtx = null;
let frameDirty = false;
let renderLoopStarted = false;
let isGameRunning = false;
let globalLib = null;
let globalFreeJ2ME = null;

function startRenderLoop() {
  function renderFrame() {
    if (frameDirty && offscreenCanvas && screenCtx && display && display.style.display !== 'none' && document.visibilityState !== 'hidden') {
      screenCtx.drawImage(offscreenCanvas, 0, 0);
      frameDirty = false;
    }
    requestAnimationFrame(renderFrame);
  }
  requestAnimationFrame(renderFrame);
}

// Power-optimized Clock in Nokia Status Bar
function updateNokiaClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const clockEl = document.getElementById('status-time');
  if (clockEl) {
    const formatted = `${hours}:${minutes}`;
    if (clockEl.textContent !== formatted) {
      clockEl.textContent = formatted;
    }
  }
}

let clockTimer = null;
function scheduleClockUpdate() {
  updateNokiaClock();
  if (clockTimer) clearTimeout(clockTimer);
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 20;
  clockTimer = setTimeout(scheduleClockUpdate, Math.max(1000, msToNextMinute));
}
scheduleClockUpdate();

// Suspend audio processing and timers when tab is hidden / device is locked
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (window.libmidi && window.libmidi.context && window.libmidi.context.state === 'running') {
      window.libmidi.context.suspend().catch(() => {});
    }
    if (keySound && keySound.ctx && keySound.ctx.state === 'running') {
      keySound.ctx.suspend().catch(() => {});
    }
  } else {
    if (window.libmidi && window.libmidi.context && window.libmidi.context.state === 'suspended') {
      window.libmidi.context.resume().catch(() => {});
    }
    if (keySound && keySound.ctx && keySound.ctx.state === 'suspended') {
      keySound.ctx.resume().catch(() => {});
    }
    scheduleClockUpdate();
  }
});

// Wire all virtual buttons on Nokia 5310 XpressMusic
function setupKeypadEvents() {
  const buttons = document.querySelectorAll('[data-key]');

  buttons.forEach(btn => {
    const key = btn.dataset.key;
    if (!key) return;

    let pressStartTime = 0;
    let releaseTimer = null;

    const onPointerDown = (e) => {
      e.preventDefault();
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      pressStartTime = performance.now();
      btn.classList.add('active');
      keypad.press(key);
    };

    const onPointerUp = (e) => {
      e.preventDefault();
      if (!btn.classList.contains('active')) return;

      // Dispatched immediately to FreeJ2ME so repeated taps (e.g. key 5 to drop blocks) are instantaneous
      keypad.release(key);

      const elapsed = performance.now() - pressStartTime;
      const minDuration = 60; // visual feedback duration so depression and glow are visible
      const remaining = Math.max(0, minDuration - elapsed);

      releaseTimer = setTimeout(() => {
        btn.classList.remove('active');
        releaseTimer = null;
      }, remaining);
    };

    const onPointerLeave = (e) => {
      // Touch pointers should not trigger leave on minor finger roll; pointerup/cancel handles them
      if (e.pointerType === 'touch') return;
      onPointerUp(e);
    };

    btn.addEventListener('pointerdown', onPointerDown);
    btn.addEventListener('pointerup', onPointerUp);
    btn.addEventListener('pointercancel', onPointerUp);
    btn.addEventListener('pointerleave', onPointerLeave);
  });

  // Dedicated Music buttons on Left Red Flank
  const btnPrev = document.getElementById('music-prev');
  const btnPlay = document.getElementById('music-play');
  const btnNext = document.getElementById('music-next');

  [btnPrev, btnPlay, btnNext].filter(Boolean).forEach(btn => {
    let pressStartTime = 0;
    let releaseTimer = null;

    btn.addEventListener('pointerdown', (e) => {
      if (releaseTimer) clearTimeout(releaseTimer);
      pressStartTime = performance.now();
      btn.classList.add('active');
    });

    const onRelease = (e) => {
      if (!btn.classList.contains('active')) return;
      const elapsed = performance.now() - pressStartTime;
      const remaining = Math.max(0, 70 - elapsed);
      releaseTimer = setTimeout(() => {
        btn.classList.remove('active');
        releaseTimer = null;
      }, remaining);
    };

    const onLeave = (e) => {
      if (e.pointerType === 'touch') return;
      onRelease(e);
    };

    btn.addEventListener('pointerup', onRelease);
    btn.addEventListener('pointercancel', onRelease);
    btn.addEventListener('pointerleave', onLeave);
  });

  if (btnPlay) {
    btnPlay.addEventListener('click', (e) => {
      e.preventDefault();
      keySound.enabled = !keySound.enabled;
      keySound.playClick();
    });
  }

  if (btnPrev) {
    btnPrev.addEventListener('click', (e) => {
      e.preventDefault();
      keySound.playClick();
      location.reload();
    });
  }

  if (btnNext) {
    btnNext.addEventListener('click', (e) => {
      e.preventDefault();
      keySound.playClick();
    });
  }

  // Physical keyboard synchronization with virtual Nokia buttons
  const activePhysicalKeys = new Map();
  window.addEventListener('keydown', (e) => {
    if (activePhysicalKeys.has(e.code)) return;

    let mappedCode = e.code;
    if (e.code === 'KeyQ') mappedCode = 'F1';
    if (e.code === 'KeyW') mappedCode = 'F2';
    if (e.code === 'Numpad5') mappedCode = 'Digit5';
    if (e.code === 'NumpadEnter') mappedCode = 'Enter';
    if (e.code === 'Space') mappedCode = 'Enter';

    const btn = document.querySelector(`[data-key="${mappedCode}"]`) ||
                document.querySelector(`[data-key="${e.code}"]`);
    if (btn) btn.classList.add('active');

    activePhysicalKeys.set(e.code, { btn, mappedCode, pressStartTime: performance.now() });

    if (codeMap[mappedCode]) {
      keypad.press(mappedCode);
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    const item = activePhysicalKeys.get(e.code);
    if (!item) return;
    activePhysicalKeys.delete(e.code);

    const { btn, mappedCode, pressStartTime } = item;
    const elapsed = performance.now() - pressStartTime;
    const remaining = Math.max(0, 140 - elapsed);

    setTimeout(() => {
      if (btn) btn.classList.remove('active');
      if (codeMap[mappedCode]) {
        keypad.release(mappedCode);
      }
    }, remaining);

    e.preventDefault();
  });

  window.addEventListener('blur', () => keypad.releaseAll());
}

// Convert JS Object to Java HashMap
async function kvToJavaMap(lib, obj) {
  const HashMap = await lib.java.util.HashMap;
  const map = await new HashMap();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) {
      await map.put(String(k), String(v));
    }
  }
  return map;
}

// CheerpJ Core Initialization
async function initCheerpJ() {
  if (globalLib && globalFreeJ2ME) {
    return { lib: globalLib, FreeJ2ME: globalFreeJ2ME };
  }

  display = document.getElementById('display');
  screenCtx = display.getContext('2d', {
    alpha: false,
    desynchronized: true
  }) || display.getContext('2d');
  screenCtx.imageSmoothingEnabled = false;
  screenCtx.webkitImageSmoothingEnabled = false;
  screenCtx.mozImageSmoothingEnabled = false;

  offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = 240;
  offscreenCanvas.height = 320;
  offscreenCtx = offscreenCanvas.getContext('2d', {
    alpha: false,
    desynchronized: true
  }) || offscreenCanvas.getContext('2d');
  offscreenCtx.imageSmoothingEnabled = false;
  offscreenCtx.webkitImageSmoothingEnabled = false;
  offscreenCtx.mozImageSmoothingEnabled = false;

  try {
    const audioCtx = createUnlockingAudioContext();
    window.libmidi = new LibMidi(audioCtx);
    await window.libmidi.init();
    if (window.libmidi.midiPlayer) {
      window.libmidi.midiPlayer.addEventListener('end-of-media', e => {
        window.evtQueue?.queueEvent({ kind: 'player-eom', player: e.target });
      });
    }
  } catch (audioErr) {
    console.warn("MIDI audio initialization skipped/failed:", audioErr);
  }

  try {
    window.libmedia = new LibMedia();
  } catch (mediaErr) {
    console.warn("LibMedia initialization skipped/failed:", mediaErr);
  }

  await cheerpjInit({
    enableDebug: false,
    natives: {
      ...canvasFontNatives,
      ...canvasGraphicsNatives,
      ...gles2Natives,
      ...jsReferenceNatives,
      ...mediaBridgeNatives,
      ...midiBridgeNatives,

      async Java_pl_zb3_freej2me_bridge_shell_Shell_setTitle(lib, title) {
        document.title = `${title} - Nokia 5310 XpressMusic`;
        const carrierEl = document.getElementById('carrier-name');
        if (carrierEl) carrierEl.textContent = title;
      },
      async Java_pl_zb3_freej2me_bridge_shell_Shell_setIcon(lib, iconBytes) {},
      async Java_pl_zb3_freej2me_bridge_shell_Shell_getScreenCtx(lib) {
        return offscreenCtx;
      },
      async Java_pl_zb3_freej2me_bridge_shell_Shell_setCanvasSize(lib, width, height) {
        const w = width || 240;
        const h = height || 320;

        offscreenCanvas.width = w;
        offscreenCanvas.height = h;
        offscreenCtx.imageSmoothingEnabled = false;
        offscreenCtx.webkitImageSmoothingEnabled = false;
        offscreenCtx.mozImageSmoothingEnabled = false;

        screenCtx.canvas.width = w;
        screenCtx.canvas.height = h;
        screenCtx.imageSmoothingEnabled = false;
        screenCtx.webkitImageSmoothingEnabled = false;
        screenCtx.mozImageSmoothingEnabled = false;
        display.style.width = '100%';
        display.style.height = '100%';

        // Hide overlay, display game screen
        const overlay = document.getElementById('lcd-standby');
        if (overlay) overlay.style.display = 'none';
        display.style.display = 'block';

        if (!renderLoopStarted) {
          renderLoopStarted = true;
          startRenderLoop();
        }
      },
      async Java_pl_zb3_freej2me_bridge_graphics_CanvasGraphics_drawImage2(lib, ctx, source, sx, sy, dx, dy, width, height, flipY, withAlpha) {
        if (!withAlpha && ctx !== offscreenCtx) {
          const prevFill = ctx.fillStyle;
          ctx.fillStyle = 'black';
          ctx.fillRect(dx, dy, width, height);
          ctx.fillStyle = prevFill;
        }
        if (!flipY) {
          ctx.drawImage(source, sx, sy, width, height, dx, dy, width, height);
        } else {
          ctx.save();
          ctx.translate(dx, dy + height);
          ctx.scale(1, -1);
          ctx.drawImage(source, sx, sy, width, height, 0, 0, width, height);
          ctx.restore();
        }
        if (ctx === offscreenCtx) {
          frameDirty = true;
        }
      },
      async Java_pl_zb3_freej2me_bridge_shell_Shell_waitForAndDispatchEvents(lib, listener) {
        const KeyEvent = await lib.pl.zb3.freej2me.bridge.shell.KeyEvent;

        const evt = await evtQueue.waitForEvent();
        if (evt.kind === 'keydown') {
          await listener.keyPressed(await new KeyEvent(...evt.args));
        } else if (evt.kind === 'keyup') {
          await listener.keyReleased(await new KeyEvent(...evt.args));
        } else if (evt.kind === 'player-eom') {
          await listener.playerEOM(evt.player);
        } else if (evt.kind === 'player-video-frame') {
          await listener.playerVideoFrame(evt.player);
        }
      },
      async Java_pl_zb3_freej2me_bridge_shell_Shell_restart(lib) {
        location.reload();
      },
      async Java_pl_zb3_freej2me_bridge_shell_Shell_exit(lib) {
        location.reload();
      },
      async Java_pl_zb3_freej2me_bridge_shell_Shell_sthop(lib) {},
      async Java_pl_zb3_freej2me_bridge_shell_Shell_say(lib, sth) {
        console.log('[FreeJ2ME]', sth);
      },
      async Java_pl_zb3_freej2me_bridge_shell_Shell_sayObject(lib, label, obj) {
        console.log('[FreeJ2ME]', label, obj);
      }
    }
  });

  const lib = await cheerpjRunLibrary(cheerpjWebRoot + "/freej2me-web.jar");
  const FreeJ2ME = await lib.org.recompile.freej2me.FreeJ2ME;

  globalLib = lib;
  globalFreeJ2ME = FreeJ2ME;
  return { lib, FreeJ2ME };
}

// Launch Game with explicit 240x320 Nokia Configuration
async function launchGame(jarBuffer, jadBuffer, appName = "citybloxx") {
  if (isGameRunning) return;
  isGameRunning = true;

  updateLcdStatus('Starting CheerpJ JVM...', true);

  const { lib, FreeJ2ME } = await initCheerpJ();

  updateLcdStatus('Configuring Nokia 240x320...', true);

  const launcherUtil = await lib.pl.zb3.freej2me.launcher.LauncherUtil;
  const MIDletLoader = await lib.org.recompile.mobile.MIDletLoader;
  const File = await lib.java.io.File;

  await launcherUtil.resetTmpDir();

  const tmpJarFile = await new File("/files/_tmp/game.jar");
  await launcherUtil.copyJar(new Int8Array(jarBuffer), tmpJarFile);

  const loader = await MIDletLoader.getMIDletLoader(tmpJarFile);

  // If JAD descriptor provided, parse and augment loader
  if (jadBuffer && jadBuffer.byteLength > 0) {
    try {
      await launcherUtil.augementLoaderWithJAD(loader, new Int8Array(jadBuffer));
    } catch (e) {
      console.warn("Could not augment with JAD:", e);
    }
  }

  await launcherUtil.ensureAppId(loader, appName);
  const appId = await loader.getAppId();

  // Performance & Thermal Configuration:
  // - On mobile devices: 30 FPS matches authentic Nokia 5310 Series 40 hardware pacing,
  //   prevents thermal throttling, and minimizes battery draw by giving the CPU core 33ms sleep intervals.
  // - On desktop: 60 FPS provides high-refresh smoothness.
  // - Supports manual URL query override: ?fps=30 or ?fps=60.
  const urlParams = new URLSearchParams(window.location.search);
  const fpsParam = urlParams.get('fps');
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
                   (navigator.maxTouchPoints && navigator.maxTouchPoints > 1);
  const targetFps = fpsParam ? String(parseInt(fpsParam, 10) || (isMobile ? 30 : 60)) : (isMobile ? "30" : "60");

  const nokiaSettings = {
    width: "240",
    height: "320",
    phone: "Nokia",
    sound: "on",
    rotate: "off",
    fps: targetFps,
    fontSize: "0",
    dgFormat: "4444",
    forceFullscreen: "off",
    queuedPaint: "off",
    textureDisableFilter: "off"
  };

  const jSettings = await kvToJavaMap(lib, nokiaSettings);

  // App properties from loader (including JAD / manifest)
  const appPropsMap = {};
  try {
    const es = await loader.properties.entrySet();
    const esi = await es.iterator();
    while (await esi.hasNext()) {
      const entry = await esi.next();
      appPropsMap[await entry.getKey()] = await entry.getValue();
    }
  } catch (_) {}

  const jAppProps = await kvToJavaMap(lib, appPropsMap);
  const jSysProps = await kvToJavaMap(lib, {});

  // Initialize app in CheerpJ VFS
  await launcherUtil.initApp(tmpJarFile, loader, jSettings, jAppProps, jSysProps);

  updateLcdStatus('Booting City Bloxx...', true);

  // Launch FreeJ2ME
  FreeJ2ME.main(['app', appId]).catch(err => {
    console.error("Game execution error:", err);
    updateLcdStatus('Error starting game.<br>Check console for details.', false);
    isGameRunning = false;
  });
}

function updateLcdStatus(msg, showSpinner = false) {
  const statusMsg = document.getElementById('status-message');
  const spinner = document.getElementById('lcd-spinner');
  if (statusMsg) statusMsg.innerHTML = msg;
  if (spinner) spinner.style.display = showSpinner ? 'block' : 'none';
}

// Resolve URL relative to the application's base directory
function resolveAppUrl(relativeUrl) {
  if (!relativeUrl) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(relativeUrl)) return relativeUrl;
  const cleanPath = relativeUrl.replace(/^\/+/, '');
  return new URL(cleanPath, window.location.href).href;
}

// Check for game files: supports Node.js dev backend, static GitHub Pages manifest, and direct fallback probing
async function checkServerForGame() {
  // Strategy 1: Dynamic Node.js server API
  try {
    const apiUrl = resolveAppUrl('api/game');
    const res = await fetch(apiUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data.found) return data;
    }
  } catch (_) {}

  // Strategy 2: Static manifest for GitHub Pages / static hosting
  try {
    const manifestUrl = resolveAppUrl('game/manifest.json');
    const res = await fetch(manifestUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data.found) {
        return {
          ...data,
          jarUrl: resolveAppUrl(data.jarUrl),
          jadUrl: data.jadUrl ? resolveAppUrl(data.jadUrl) : null
        };
      }
    }
  } catch (_) {}

  // Strategy 3: Direct probe for bundled JARs
  const candidateJars = [
    'game/City_Bloxx-51946.jar',
    'game/citybloxx.jar',
    'game/city-bloxx.jar'
  ];
  for (const relJar of candidateJars) {
    try {
      const jarUrl = resolveAppUrl(relJar);
      const probe = await fetch(jarUrl, { method: 'HEAD' });
      if (probe.ok) {
        return {
          found: true,
          jarName: relJar.split('/').pop(),
          jarUrl: jarUrl,
          jadUrl: null
        };
      }
    } catch (_) {}
  }

  return null;
}

// Auto-boot if game found on server or static host
async function checkAndAutoBoot() {
  updateLcdStatus('Checking for City Bloxx...', true);
  const gameInfo = await checkServerForGame();

  if (gameInfo && gameInfo.found) {
    updateLcdStatus(`Found <b>${gameInfo.jarName}</b><br>Loading game...`, true);

    try {
      const targetJarUrl = resolveAppUrl(gameInfo.jarUrl);
      const jarRes = await fetch(targetJarUrl);
      const jarBuffer = await jarRes.arrayBuffer();

      let jadBuffer = null;
      if (gameInfo.jadUrl) {
        try {
          const targetJadUrl = resolveAppUrl(gameInfo.jadUrl);
          const jadRes = await fetch(targetJadUrl);
          if (jadRes.ok) jadBuffer = await jadRes.arrayBuffer();
        } catch (_) {}
      }

      await launchGame(jarBuffer, jadBuffer, gameInfo.jarName);
    } catch (err) {
      console.error("Auto boot failed:", err);
      showMissingGameUi("Error loading game files.");
    }
  } else {
    showMissingGameUi();
  }
}

function showMissingGameUi(customMsg) {
  const defaultMsg = customMsg || 
    `<b>Game Card Missing</b><br>Please select or drag & drop a <code>.jar</code> game file.`;
  updateLcdStatus(defaultMsg, false);
  const actionBtn = document.getElementById('lcd-action-btn');
  if (actionBtn) actionBtn.style.display = 'inline-block';
}

// Handle local file selection through browser
async function handleUserFiles(fileList) {
  let jarFile = null;
  let jadFile = null;

  for (const file of fileList) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.jar')) jarFile = file;
    if (name.endsWith('.jad')) jadFile = file;
  }

  if (!jarFile) {
    alert("Please select at least one .jar game file!");
    return;
  }

  updateLcdStatus(`Loading ${jarFile.name}...`, true);
  const actionBtn = document.getElementById('lcd-action-btn');
  if (actionBtn) actionBtn.style.display = 'none';

  const jarBuffer = await jarFile.arrayBuffer();
  let jadBuffer = null;
  if (jadFile) {
    jadBuffer = await jadFile.arrayBuffer();
  }

  // Upload to server so it persists (if backend exists)
  try {
    const formData = new FormData();
    formData.append('jar', jarFile);
    if (jadFile) formData.append('jad', jadFile);
    fetch(resolveAppUrl('api/upload'), { method: 'POST', body: formData }).catch(() => {});
  } catch (_) {}

  await launchGame(jarBuffer, jadBuffer, jarFile.name);
}

// DOM Ready / App Initialization
function initApp() {
  setupKeypadEvents();

  // Hidden file input on LCD
  const fileInput = document.getElementById('hidden-file-input');
  const actionBtn = document.getElementById('lcd-action-btn');
  if (actionBtn && fileInput) {
    actionBtn.addEventListener('click', () => {
      fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleUserFiles(e.target.files);
      }
    });
  }

  // Drag and drop support on Nokia phone
  const phone = document.getElementById('nokia-phone');
  if (phone) {
    phone.addEventListener('dragover', (e) => {
      e.preventDefault();
      phone.classList.add('drag-over');
    });
    phone.addEventListener('dragleave', () => {
      phone.classList.remove('drag-over');
    });
    phone.addEventListener('drop', (e) => {
      e.preventDefault();
      phone.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files.length > 0) {
        handleUserFiles(e.dataTransfer.files);
      }
    });
  }

  // Start auto-boot check
  checkAndAutoBoot();

  // Disable browser zoom and accidental pinch/double-tap gestures on mobile
  preventBrowserZoom();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// Comprehensive mobile zoom prevention (pinch zoom, double-tap zoom, gesture zoom)
function preventBrowserZoom() {
  // 1. Disable iOS Safari gesture zoom (Pinch-to-zoom)
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  });

  // 2. Prevent multi-finger pinch touch gestures
  document.addEventListener('touchstart', (e) => {
    if (e.touches && e.touches.length > 1) {
      e.preventDefault();
    }
  }, { passive: false });

  // 3. Prevent iOS Safari double-tap to zoom across touchstart & touchend
  let lastTouchStartTime = 0;
  document.addEventListener('touchstart', (e) => {
    const now = performance.now();
    if (now - lastTouchStartTime <= 350) {
      if (!e.target.closest || (!e.target.closest('.phone-btn') && !e.target.closest('.music-btn'))) {
        e.preventDefault();
      }
    }
    lastTouchStartTime = now;
  }, { passive: false });

  let lastTouchEndTime = 0;
  document.addEventListener('touchend', (e) => {
    const now = performance.now();
    if (now - lastTouchEndTime <= 350) {
      e.preventDefault();
    }
    lastTouchEndTime = now;
  }, { passive: false });

  // 4. Prevent standard dblclick event
  document.addEventListener('dblclick', (e) => {
    e.preventDefault();
  }, { passive: false });

  // 5. Prevent Ctrl / Cmd + mouse wheel zoom
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
    }
  }, { passive: false });

  // 5. Prevent keyboard zoom shortcuts (Cmd/Ctrl + '+', '-', '0')
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
      e.preventDefault();
    }
  });

  // 6. Prevent contextual menus / callouts on long touch
  window.addEventListener('contextmenu', (e) => {
    if (e.pointerType === 'touch' || (e.target && e.target.closest && e.target.closest('.nokia-device'))) {
      e.preventDefault();
    }
  });
}

