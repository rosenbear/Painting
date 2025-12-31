// main.js
(() => {

  // iPad Safari: prevent native pinch/zoom gestures from stealing events
document.addEventListener("gesturestart", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gesturechange", (e) => e.preventDefault(), { passive: false });
document.addEventListener("gestureend", (e) => e.preventDefault(), { passive: false });

  // ======== CONFIG ========
  // Pick a fixed iPad Pro-ish landscape canvas size. Change here if desired.
  const MAIN_W = 2732;
  const MAIN_H = 2048;

  const STAMP_SIZE = 512;

  // Undo limits
  const UNDO_DEFAULT_LIMIT = 200;
  const UNDO_HARD_CAP = 500;

  // Zoom range (configurable)
  const ZOOM_MIN = 0.20;
  const ZOOM_MAX = 4.00;

  // Stamp spacing in % of current dab diameter
  const SPACING_MIN = 0.05;
  const SPACING_MAX = 1.00;

  // Brush size (in main-canvas pixels, before zoom)
  const SIZE_MIN = 6;
  const SIZE_MAX = 220;

  // Pressure mapping (raw feel; no heavy smoothing)
  const PRESSURE_FLOOR = 0.12; // avoids disappearing marks at very low pressure

  // Stamp window fixed pen
  const STAMP_PEN_SIZE = 10; // px in 512 buffer space
  const STAMP_PEN_OPACITY = 1.0;

  // Rotation smoothing (angle only; does not blur pixels)
  const ANGLE_SMOOTHING = 0.35; // 0 = none, 1 = very smooth

  // ======== DOM ========
  const view = document.getElementById("view");
  const viewCtx = view.getContext("2d", { alpha: false, desynchronized: true });

  const colorInput = document.getElementById("color");
  const modeBtn = document.getElementById("modeBtn");
  const pSizeBtn = document.getElementById("pSizeBtn");
  const pOpBtn = document.getElementById("pOpBtn");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const exportBtn = document.getElementById("exportBtn");

  const layersStrip = document.getElementById("layersStrip");
  const mergeBtn = document.getElementById("mergeBtn");

  const stampWindow = document.getElementById("stampWindow");
  const stampHandle = document.getElementById("stampHandle");
  const stampClear = document.getElementById("stampClear");
  const stampCanvas = document.getElementById("stampCanvas");
  const stampCtx = stampCanvas.getContext("2d", { alpha: true, desynchronized: true });

  const sizeSliderEl = document.getElementById("sizeSlider");
  const spaceSliderEl = document.getElementById("spaceSlider");
  const sizeValEl = document.getElementById("sizeVal");
  const spaceValEl = document.getElementById("spaceVal");

  // ======== STATE ========
  // View transform for pan/zoom
  const viewState = {
    scale: 1.0,
    offsetX: 0,
    offsetY: 0,
  };

  // Tool state
  const tool = {
    color: colorInput.value,
    isEraser: false,
    pressureToSize: true,
    pressureToOpacity: false,
    baseSize: 36,
    baseOpacity: 1.0,
    spacingPct: 0.22, // % of dab diameter
  };

  // Stamp state
  const stampState = {
    tinted: document.createElement("canvas"),
    tintedCtx: null,
    dirty: true,
    // window position
    x: 14,
    y: null, // set on first layout
    dragging: false,
    dragOffX: 0,
    dragOffY: 0,
  };
  stampState.tinted.width = STAMP_SIZE;
  stampState.tinted.height = STAMP_SIZE;
  stampState.tintedCtx = stampState.tinted.getContext("2d", { alpha: true, desynchronized: true });

  // Layers (5 fixed)
  const LAYER_COUNT = 5;
  const layers = Array.from({ length: LAYER_COUNT }, (_, i) => {
    const c = document.createElement("canvas");
    c.width = MAIN_W;
    c.height = MAIN_H;
    const ctx = c.getContext("2d", { alpha: true, desynchronized: true });
    ctx.imageSmoothingEnabled = false;
    return { id: i, canvas: c, ctx };
  });

  let activeLayer = 4; // top by default (index 4)

  // History commands (global)
  // Commands:
  //  - { type:'stroke', layerId, params, points:[...]}
  //  - { type:'mergeDown', fromLayerId, toLayerId }
  const history = {
    undo: [],
    redo: [],
    limit: UNDO_DEFAULT_LIMIT,
  };

  // Pointer drawing state (main)
  const drawState = {
    active: false,
    pointerId: null,
    points: [],
    lastDabX: null,
    lastDabY: null,
    lastAngle: 0,
    lastX: null,
    lastY: null,
  };

  // Stamp window pen state
  const stampPen = {
    active: false,
    pointerId: null,
    lastX: null,
    lastY: null,
  };

  // Two-finger pan/zoom (touch only)
  const touchState = {
    p1: null,
    p2: null,
    startDist: 0,
    startScale: 1,
    startCenter: null,
    startOffsetX: 0,
    startOffsetY: 0,
  };

  // ======== HELPERS ========
  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function getCanvasRect() {
    return view.getBoundingClientRect();
  }

  function screenToCanvas(clientX, clientY) {
    const r = getCanvasRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const cx = (sx - viewState.offsetX) / viewState.scale;
    const cy = (sy - viewState.offsetY) / viewState.scale;
    return { x: cx, y: cy };
  }

  function isPenEvent(e) {
    return e.pointerType === "pen";
  }

  function isTouchEvent(e) {
    return e.pointerType === "touch";
  }

  function withinStampWindow(clientX, clientY) {
    const rect = stampWindow.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function withinStampHandle(clientX, clientY) {
    const rect = stampHandle.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function withinStampCanvas(clientX, clientY) {
    const rect = stampCanvas.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  function stampScreenToStamp(clientX, clientY) {
    const rect = stampCanvas.getBoundingClientRect();
    const sx = (clientX - rect.left) / rect.width;
    const sy = (clientY - rect.top) / rect.height;
    return { x: sx * STAMP_SIZE, y: sy * STAMP_SIZE };
  }

  function markStampDirty() {
    stampState.dirty = true;
  }

  function rebuildTintedStamp() {
    // Alpha-mask tinted by tool.color; background remains transparent.
    const ctx = stampState.tintedCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, STAMP_SIZE, STAMP_SIZE);

    // Fill with color
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = tool.color;
    ctx.fillRect(0, 0, STAMP_SIZE, STAMP_SIZE);

    // Keep only where stamp has alpha
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(stampCanvas, 0, 0);

    ctx.globalCompositeOperation = "source-over";
    stampState.dirty = false;
  }

  function pushHistory(cmd) {
    history.undo.push(cmd);
    if (history.undo.length > UNDO_HARD_CAP) {
      history.undo.splice(0, history.undo.length - UNDO_HARD_CAP);
    }
    history.redo.length = 0;
    // If limit is smaller than stored, trimming is OK:
    if (history.undo.length > history.limit) {
      history.undo.splice(0, history.undo.length - history.limit);
    }
  }

  function clearAllLayers() {
    for (const L of layers) {
      L.ctx.setTransform(1, 0, 0, 1, 0, 0);
      L.ctx.clearRect(0, 0, MAIN_W, MAIN_H);
    }
  }

  function replayAll() {
    clearAllLayers();
    for (const cmd of history.undo) {
      if (cmd.type === "stroke") {
        replayStroke(cmd);
      } else if (cmd.type === "mergeDown") {
        applyMergeDown(cmd.fromLayerId, cmd.toLayerId);
      }
    }
  }

  function replayStroke(cmd) {
    const L = layers[cmd.layerId];
    const params = cmd.params;
    // Ensure tinted stamp is up to date for that color if needed
    // (Simplification: we rebuild tinted stamp for current tool.color only.
    // For correct per-stroke color replay, we generate a temporary tinted canvas.)
    if (!params.isEraser) {
      const temp = document.createElement("canvas");
      temp.width = STAMP_SIZE;
      temp.height = STAMP_SIZE;
      const tctx = temp.getContext("2d", { alpha: true, desynchronized: true });
      tctx.clearRect(0, 0, STAMP_SIZE, STAMP_SIZE);
      tctx.globalCompositeOperation = "source-over";
      tctx.fillStyle = params.color;
      tctx.fillRect(0, 0, STAMP_SIZE, STAMP_SIZE);
      tctx.globalCompositeOperation = "destination-in";
      tctx.drawImage(stampCanvas, 0, 0);
      tctx.globalCompositeOperation = "source-over";

      stampAlongPoints(L.ctx, cmd.points, params, temp);
    } else {
      // Eraser uses stamp alpha directly
      stampAlongPoints(L.ctx, cmd.points, params, stampCanvas);
    }
  }

  function applyMergeDown(fromLayerId, toLayerId) {
    if (toLayerId < 0 || toLayerId >= LAYER_COUNT) return;
    if (fromLayerId < 0 || fromLayerId >= LAYER_COUNT) return;
    if (toLayerId === fromLayerId) return;

    const fromL = layers[fromLayerId];
    const toL = layers[toLayerId];

    // Composite from → to
    toL.ctx.save();
    toL.ctx.globalCompositeOperation = "source-over";
    toL.ctx.globalAlpha = 1;
    toL.ctx.drawImage(fromL.canvas, 0, 0);
    toL.ctx.restore();

    // Clear from layer
    fromL.ctx.setTransform(1, 0, 0, 1, 0, 0);
    fromL.ctx.clearRect(0, 0, MAIN_W, MAIN_H);
  }

  function stampAlongPoints(layerCtx, points, params, stampSourceCanvas) {
    if (!points || points.length < 2) return;

    layerCtx.save();
    layerCtx.imageSmoothingEnabled = false;

    const baseSize = params.baseSize;
    const spacingPct = params.spacingPct;

    let lastDab = null;
    let lastAngle = 0;

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const segLen = Math.hypot(dx, dy);
      if (segLen < 0.0001) continue;

      const angle = stabilizedAngle(lastAngle, params, a, b);

      let tStart = 0;
      if (lastDab) {
        // continue from lastDab within segment projection
      } else {
        lastDab = { x: a.x, y: a.y };
      }

      // Determine effective size/opacity at endpoints; we’ll linearly blend.
      const pA = effectivePressure(a.pressure ?? 1);
      const pB = effectivePressure(b.pressure ?? 1);

      const sizeA = computeDabSize(baseSize, pA, params.pressureToSize);
      const sizeB = computeDabSize(baseSize, pB, params.pressureToSize);

      const opA = computeDabOpacity(params.baseOpacity, pA, params.pressureToOpacity);
      const opB = computeDabOpacity(params.baseOpacity, pB, params.pressureToOpacity);

      // Step along segment placing dabs based on local size
      // Use midpoint size for spacing estimate (keeps it stable).
      const sizeMid = (sizeA + sizeB) * 0.5;
      const spacing = Math.max(1, sizeMid * spacingPct);

      // Place dabs from lastDab towards b
      let distFromLast = Math.hypot(b.x - lastDab.x, b.y - lastDab.y);

      // If lastDab isn't on the segment (first segment), reset
      if (!isFinite(distFromLast)) {
        lastDab = { x: a.x, y: a.y };
        distFromLast = Math.hypot(b.x - lastDab.x, b.y - lastDab.y);
      }

      // March along the segment in param space
      // We’ll use a running cursor from lastDab, stepping by spacing.
      const ux = dx / segLen;
      const uy = dy / segLen;

      // Establish cursor at lastDab projected onto current segment start
      // Simpler: if lastDab is far from 'a', snap to 'a'
      if (Math.hypot(lastDab.x - a.x, lastDab.y - a.y) > spacing * 3) {
        lastDab = { x: a.x, y: a.y };
      }

      let cursorX = lastDab.x;
      let cursorY = lastDab.y;

      let remaining = Math.hypot(b.x - cursorX, b.y - cursorY);

      while (remaining >= spacing) {
        cursorX += ux * spacing;
        cursorY += uy * spacing;

        const t = segLen > 0 ? clamp(Math.hypot(cursorX - a.x, cursorY - a.y) / segLen, 0, 1) : 0;
        const sizeNow = lerp(sizeA, sizeB, t);
        const opNow = lerp(opA, opB, t);

        drawDab(layerCtx, stampSourceCanvas, cursorX, cursorY, sizeNow, opNow, angle, params.isEraser);

        lastDab.x = cursorX;
        lastDab.y = cursorY;

        remaining = Math.hypot(b.x - cursorX, b.y - cursorY);
        lastAngle = angle;
      }
    }

    layerCtx.restore();
  }

  function effectivePressure(p) {
    if (!isFinite(p)) return 1;
    return clamp(Math.max(p, PRESSURE_FLOOR), 0, 1);
  }

  function computeDabSize(baseSize, pressure, enabled) {
    if (!enabled) return baseSize;
    // raw feel: map pressure directly into a reasonable range
    // pressure 0..1 -> 0.25..1.0 multiplier
    const mult = lerp(0.25, 1.0, pressure);
    return baseSize * mult;
  }

  function computeDabOpacity(baseOpacity, pressure, enabled) {
    if (!enabled) return baseOpacity;
    // pressure 0..1 -> 0.15..1.0 multiplier
    const mult = lerp(0.15, 1.0, pressure);
    return baseOpacity * mult;
  }

  function stabilizedAngle(prevAngle, params, a, b) {
    // Prefer tilt if available, else stroke direction.
    // Tilt angle: use azimuthAngle if present (Safari may not provide), else derive from tiltX/tiltY if available.
    let target = null;

    // PointerEvents standard fields sometimes present: azimuthAngle, altitudeAngle (not guaranteed)
    if (isFinite(b.azimuthAngle)) {
      target = b.azimuthAngle;
    } else if (isFinite(b.tiltX) && isFinite(b.tiltY)) {
      // tiltX/tiltY are degrees; convert to a direction-ish angle
      // This is heuristic; it gives a stable "lean direction".
      target = Math.atan2(b.tiltY, b.tiltX);
    }

    if (target == null) {
      target = Math.atan2(b.y - a.y, b.x - a.x);
    }

    // Smooth angle without wrap jumps
    const diff = wrapAngle(target - prevAngle);
    return prevAngle + diff * (1 - ANGLE_SMOOTHING);
  }

  function wrapAngle(rad) {
    while (rad > Math.PI) rad -= Math.PI * 2;
    while (rad < -Math.PI) rad += Math.PI * 2;
    return rad;
  }

  function drawDab(ctx, stampSrc, x, y, size, opacity, angle, isEraser) {
    const half = size * 0.5;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    ctx.globalAlpha = clamp(opacity, 0, 1);

    if (isEraser) {
      ctx.globalCompositeOperation = "destination-out";
      // Use alpha from stampSrc (stampCanvas). If stampSrc is tinted, still fine: alpha is what matters.
      ctx.drawImage(stampSrc, -half, -half, size, size);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(stampSrc, -half, -half, size, size);
    }

    ctx.restore();
  }

  // ======== UI: LAYERS ========
  function buildLayerUI() {
    layersStrip.innerHTML = "";
    for (let i = 0; i < LAYER_COUNT; i++) {
      const btn = document.createElement("button");
      btn.className = "layerBtn" + (i === activeLayer ? " active" : "");
      btn.textContent = String(i + 1);
      btn.addEventListener("pointerdown", (e) => {
        // allow pencil to click UI
        e.preventDefault();
        activeLayer = i;
        updateLayerUI();
      });
      layersStrip.appendChild(btn);
    }
  }

  function updateLayerUI() {
    const buttons = layersStrip.querySelectorAll(".layerBtn");
    buttons.forEach((b, idx) => {
      b.classList.toggle("active", idx === activeLayer);
    });
  }

  mergeBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // Merge active layer down into below. If active is 0 (bottom), do nothing.
    if (activeLayer <= 0) return;
    const fromId = activeLayer;
    const toId = activeLayer - 1;

    // Apply now and record as command (replayable)
    applyMergeDown(fromId, toId);
    pushHistory({ type: "mergeDown", fromLayerId: fromId, toLayerId: toId });

    // After merge: bottom stays; top clears; active layer remains the same slot (per your description)
    // Keep activeLayer as fromId (now cleared) so you can continue drawing “on top” immediately.
    updateLayerUI();
  });

  // ======== UI: TOOL BUTTONS ========
  colorInput.addEventListener("input", () => {
    tool.color = colorInput.value;
    markStampDirty(); // tinted stamp color depends on main color
  });

  modeBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    tool.isEraser = !tool.isEraser;
    modeBtn.textContent = tool.isEraser ? "Eraser" : "Brush";
    modeBtn.setAttribute("aria-pressed", tool.isEraser ? "true" : "false");
  });

  pSizeBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    tool.pressureToSize = !tool.pressureToSize;
    pSizeBtn.setAttribute("aria-pressed", tool.pressureToSize ? "true" : "false");
  });

  pOpBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    tool.pressureToOpacity = !tool.pressureToOpacity;
    pOpBtn.setAttribute("aria-pressed", tool.pressureToOpacity ? "true" : "false");
  });

  undoBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    undo();
  });

  redoBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    redo();
  });

  exportBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    exportPNG();
  });

  function undo() {
    if (history.undo.length === 0) return;
    const cmd = history.undo.pop();
    history.redo.push(cmd);
    replayAll();
  }

  function redo() {
    if (history.redo.length === 0) return;
    const cmd = history.redo.pop();
    history.undo.push(cmd);
    replayAll();
  }

  // ======== UI: VERTICAL SLIDERS ========
  function makeVSlider(rootEl, { get, set, min, max, format }) {
    const track = rootEl.querySelector(".vslider-track");
    const fill = rootEl.querySelector(".vslider-fill");
    const knob = rootEl.querySelector(".vslider-knob");

    let dragging = false;
    let dragId = null;

    function updateUI() {
      const v = clamp(get(), min, max);
      const t = (v - min) / (max - min);
      const pct = clamp(t, 0, 1);

      fill.style.height = `${pct * 100}%`;
      knob.style.bottom = `${pct * 100}%`;

      return v;
    }

    function setFromClientY(clientY, precision = false) {
      const rect = track.getBoundingClientRect();
      const y = clamp(clientY, rect.top, rect.bottom);
      let pct = 1 - (y - rect.top) / rect.height; // top=1
      pct = clamp(pct, 0, 1);

      let v = min + pct * (max - min);

      // Precision mode: quantize smaller steps
      if (precision) {
        const steps = 200; // finer control
        v = min + Math.round(((v - min) / (max - min)) * steps) * ((max - min) / steps);
      }

      set(clamp(v, min, max));
      updateUI();
    }

    rootEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      dragging = true;
      dragId = e.pointerId;
      rootEl.setPointerCapture(dragId);
      setFromClientY(e.clientY, e.shiftKey);
    });

    rootEl.addEventListener("pointermove", (e) => {
      if (!dragging || e.pointerId !== dragId) return;
      e.preventDefault();
      setFromClientY(e.clientY, e.shiftKey);
    });

    rootEl.addEventListener("pointerup", (e) => {
      if (e.pointerId !== dragId) return;
      dragging = false;
      dragId = null;
    });

    rootEl.addEventListener("pointercancel", () => {
      dragging = false;
      dragId = null;
    });

    updateUI();
    return { updateUI };
  }

  const sizeSlider = makeVSlider(sizeSliderEl, {
    get: () => tool.baseSize,
    set: (v) => (tool.baseSize = v),
    min: SIZE_MIN,
    max: SIZE_MAX,
    format: (v) => `${Math.round(v)}px`,
  });

  const spaceSlider = makeVSlider(spaceSliderEl, {
    get: () => tool.spacingPct,
    set: (v) => (tool.spacingPct = v),
    min: SPACING_MIN,
    max: SPACING_MAX,
    format: (v) => `${Math.round(v * 100)}%`,
  });

  function updateSliderLabels() {
    sizeValEl.textContent = `${Math.round(tool.baseSize)}px`;
    spaceValEl.textContent = `${Math.round(tool.spacingPct * 100)}%`;
  }

  // ======== STAMP WINDOW ========
  function layoutStampWindow() {
    // Place near bottom-left by default if y not set
    if (stampState.y == null) {
      stampState.y = window.innerHeight - stampWindow.offsetHeight - 14;
    }
    stampWindow.style.left = `${stampState.x}px`;
    stampWindow.style.top = `${stampState.y}px`;
  }

  // Stamp handle: pencil drag only
  stampHandle.addEventListener("pointerdown", (e) => {
    if (!isPenEvent(e)) return;
    e.preventDefault();
    stampState.dragging = true;
    const rect = stampWindow.getBoundingClientRect();
    stampState.dragOffX = e.clientX - rect.left;
    stampState.dragOffY = e.clientY - rect.top;
    stampHandle.setPointerCapture(e.pointerId);
  });

  stampHandle.addEventListener("pointermove", (e) => {
    if (!stampState.dragging) return;
    if (!isPenEvent(e)) return;
    e.preventDefault();
    stampState.x = e.clientX - stampState.dragOffX;
    stampState.y = e.clientY - stampState.dragOffY;
    layoutStampWindow();
  });

  stampHandle.addEventListener("pointerup", (e) => {
    if (!isPenEvent(e)) return;
    stampState.dragging = false;
  });

  stampHandle.addEventListener("pointercancel", () => {
    stampState.dragging = false;
  });

  stampClear.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stampCtx.setTransform(1, 0, 0, 1, 0, 0);
    stampCtx.clearRect(0, 0, STAMP_SIZE, STAMP_SIZE);
    markStampDirty();
  });

  // Draw inside stamp window: pencil only
  stampCanvas.addEventListener("pointerdown", (e) => {
    if (!isPenEvent(e)) return;
    // Avoid conflicts: only draw when not on handle
    if (!withinStampCanvas(e.clientX, e.clientY)) return;
    e.preventDefault();

    stampPen.active = true;
    stampPen.pointerId = e.pointerId;
    stampCanvas.setPointerCapture(e.pointerId);

    const p = stampScreenToStamp(e.clientX, e.clientY);
    stampPen.lastX = p.x;
    stampPen.lastY = p.y;

    drawStampPoint(p.x, p.y, p.x, p.y);
    markStampDirty();
  });

  stampCanvas.addEventListener("pointermove", (e) => {
    if (!stampPen.active || e.pointerId !== stampPen.pointerId) return;
    if (!isPenEvent(e)) return;
    e.preventDefault();

    const p = stampScreenToStamp(e.clientX, e.clientY);
    drawStampPoint(stampPen.lastX, stampPen.lastY, p.x, p.y);
    stampPen.lastX = p.x;
    stampPen.lastY = p.y;
    markStampDirty();
  });

  stampCanvas.addEventListener("pointerup", (e) => {
    if (e.pointerId !== stampPen.pointerId) return;
    stampPen.active = false;
    stampPen.pointerId = null;
  });

  stampCanvas.addEventListener("pointercancel", () => {
    stampPen.active = false;
    stampPen.pointerId = null;
  });

  function drawStampPoint(x0, y0, x1, y1) {
    stampCtx.save();
    stampCtx.globalCompositeOperation = "source-over";
    stampCtx.globalAlpha = STAMP_PEN_OPACITY;
    stampCtx.strokeStyle = "#000";
    stampCtx.lineWidth = STAMP_PEN_SIZE;
    stampCtx.lineCap = "round";
    stampCtx.lineJoin = "round";

    stampCtx.beginPath();
    stampCtx.moveTo(x0, y0);
    stampCtx.lineTo(x1, y1);
    stampCtx.stroke();

    stampCtx.restore();
  }

  // ======== MAIN CANVAS POINTER EVENTS ========
  view.addEventListener("pointerdown", (e) => {
    // Stamp window captures pencil input within it; ignore for main drawing.
    if (withinStampWindow(e.clientX, e.clientY)) return;

    if (isPenEvent(e)) {
      e.preventDefault();
      startStroke(e);
      return;
    }

    if (isTouchEvent(e)) {
      e.preventDefault();
      handleTouchStart(e);
      return;
    }
  });

  view.addEventListener("pointermove", (e) => {
    if (isPenEvent(e)) {
      if (!drawState.active || e.pointerId !== drawState.pointerId) return;
      e.preventDefault();
      extendStroke(e);
      return;
    }

    if (isTouchEvent(e)) {
      e.preventDefault();
      handleTouchMove(e);
      return;
    }
  });

  view.addEventListener("pointerup", (e) => {
    if (isPenEvent(e)) {
      if (e.pointerId !== drawState.pointerId) return;
      e.preventDefault();
      endStroke(e);
      return;
    }
    if (isTouchEvent(e)) {
      e.preventDefault();
      handleTouchEnd(e);
      return;
    }
  });

  view.addEventListener("pointercancel", (e) => {
    if (isPenEvent(e)) {
      if (e.pointerId !== drawState.pointerId) return;
      endStroke(e);
    }
    if (isTouchEvent(e)) {
      handleTouchEnd(e);
    }
  });

  function startStroke(e) {
    // Make sure tinted stamp is current if brushing
    if (!tool.isEraser) {
      if (stampState.dirty) rebuildTintedStamp();
    }

    drawState.active = true;
    drawState.pointerId = e.pointerId;
    view.setPointerCapture(e.pointerId);

    drawState.points = [];
    drawState.lastDabX = null;
    drawState.lastDabY = null;

    const c = screenToCanvas(e.clientX, e.clientY);
    drawState.lastX = c.x;
    drawState.lastY = c.y;
    drawState.lastAngle = 0;

    // Record first point
    drawState.points.push(extractPointSample(e, c.x, c.y));

    // Place an initial dab immediately for responsiveness
    const p = drawState.points[0];
    const pressure = effectivePressure(p.pressure ?? 1);
    const size = computeDabSize(tool.baseSize, pressure, tool.pressureToSize);
    const op = computeDabOpacity(tool.baseOpacity, pressure, tool.pressureToOpacity);
    const angle = stabilizedAngle(drawState.lastAngle, tool, p, p);

    const ctx = layers[activeLayer].ctx;
    const src = tool.isEraser ? stampCanvas : stampState.tinted;
    drawDab(ctx, src, c.x, c.y, size, op, angle, tool.isEraser);

    drawState.lastDabX = c.x;
    drawState.lastDabY = c.y;
    drawState.lastAngle = angle;
  }

  function extendStroke(e) {
    // If stamp became dirty mid-stroke (color change), keep using current snapshot for stroke.
    const c = screenToCanvas(e.clientX, e.clientY);

    const sample = extractPointSample(e, c.x, c.y);
    const prev = drawState.points[drawState.points.length - 1];
    drawState.points.push(sample);

    // Stamp along segment incrementally (low latency)
    const ctx = layers[activeLayer].ctx;

    const baseSize = tool.baseSize;
    const spacing = Math.max(1, baseSize * tool.spacingPct);

    const pressureA = effectivePressure(prev.pressure ?? 1);
    const pressureB = effectivePressure(sample.pressure ?? 1);

    const sizeA = computeDabSize(baseSize, pressureA, tool.pressureToSize);
    const sizeB = computeDabSize(baseSize, pressureB, tool.pressureToSize);
    const sizeMid = (sizeA + sizeB) * 0.5;
    const localSpacing = Math.max(1, sizeMid * tool.spacingPct);

    const opA = computeDabOpacity(tool.baseOpacity, pressureA, tool.pressureToOpacity);
    const opB = computeDabOpacity(tool.baseOpacity, pressureB, tool.pressureToOpacity);

    const dx = sample.x - prev.x;
    const dy = sample.y - prev.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 0.0001) return;

    const ux = dx / segLen;
    const uy = dy / segLen;

    const angle = stabilizedAngle(drawState.lastAngle, tool, prev, sample);
    drawState.lastAngle = angle;

    // Cursor begins at last dab position; if none, snap to prev point
    if (drawState.lastDabX == null) {
      drawState.lastDabX = prev.x;
      drawState.lastDabY = prev.y;
    }

    let cx = drawState.lastDabX;
    let cy = drawState.lastDabY;

    // If last dab is far away (e.g. after transform jump), resync
    if (Math.hypot(cx - prev.x, cy - prev.y) > localSpacing * 3) {
      cx = prev.x;
      cy = prev.y;
    }

    let remaining = Math.hypot(sample.x - cx, sample.y - cy);
    const src = tool.isEraser ? stampCanvas : (stampState.dirty ? (rebuildTintedStamp(), stampState.tinted) : stampState.tinted);

    while (remaining >= localSpacing) {
      cx += ux * localSpacing;
      cy += uy * localSpacing;

      const t = clamp(Math.hypot(cx - prev.x, cy - prev.y) / segLen, 0, 1);
      const sizeNow = lerp(sizeA, sizeB, t);
      const opNow = lerp(opA, opB, t);

      drawDab(ctx, src, cx, cy, sizeNow, opNow, angle, tool.isEraser);

      drawState.lastDabX = cx;
      drawState.lastDabY = cy;

      remaining = Math.hypot(sample.x - cx, sample.y - cy);
    }
  }

  function endStroke(e) {
    // Finalize history command
    if (!drawState.active) return;
    drawState.active = false;

    const cmd = {
      type: "stroke",
      layerId: activeLayer,
      params: {
        color: tool.color,
        isEraser: tool.isEraser,
        baseSize: tool.baseSize,
        baseOpacity: tool.baseOpacity,
        spacingPct: tool.spacingPct,
        pressureToSize: tool.pressureToSize,
        pressureToOpacity: tool.pressureToOpacity,
      },
      points: drawState.points,
    };
    pushHistory(cmd);

    drawState.pointerId = null;
    drawState.points = [];
    drawState.lastDabX = null;
    drawState.lastDabY = null;
  }

  function extractPointSample(e, x, y) {
    // Standard pointer fields: pressure, tiltX, tiltY may exist; azimuthAngle sometimes.
    return {
      x,
      y,
      pressure: isFinite(e.pressure) ? e.pressure : 1,
      tiltX: isFinite(e.tiltX) ? e.tiltX : undefined,
      tiltY: isFinite(e.tiltY) ? e.tiltY : undefined,
      azimuthAngle: isFinite(e.azimuthAngle) ? e.azimuthAngle : undefined,
    };
  }

  // ======== TOUCH PAN/ZOOM (2-finger only) ========
  function handleTouchStart(e) {
    // Keep up to two touches
    if (!touchState.p1) {
      touchState.p1 = { id: e.pointerId, x: e.clientX, y: e.clientY };
      view.setPointerCapture(e.pointerId);
      return;
    }
    if (!touchState.p2) {
      touchState.p2 = { id: e.pointerId, x: e.clientX, y: e.clientY };
      view.setPointerCapture(e.pointerId);
      beginPinch();
    }
  }

  function handleTouchMove(e) {
    if (touchState.p1 && e.pointerId === touchState.p1.id) {
      touchState.p1.x = e.clientX;
      touchState.p1.y = e.clientY;
    } else if (touchState.p2 && e.pointerId === touchState.p2.id) {
      touchState.p2.x = e.clientX;
      touchState.p2.y = e.clientY;
    } else {
      return;
    }

    if (touchState.p1 && touchState.p2) {
      updatePinch();
    }
  }

  function handleTouchEnd(e) {
    if (touchState.p1 && e.pointerId === touchState.p1.id) {
      touchState.p1 = touchState.p2;
      touchState.p2 = null;
      return;
    }
    if (touchState.p2 && e.pointerId === touchState.p2.id) {
      touchState.p2 = null;
      return;
    }
  }

  function beginPinch() {
    const { p1, p2 } = touchState;
    if (!p1 || !p2) return;

    touchState.startDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    touchState.startScale = viewState.scale;
    touchState.startCenter = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
    touchState.startOffsetX = viewState.offsetX;
    touchState.startOffsetY = viewState.offsetY;
  }

  function updatePinch() {
    const { p1, p2 } = touchState;
    if (!p1 || !p2) return;

    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (touchState.startDist <= 0) return;

    const scale = clamp(touchState.startScale * (dist / touchState.startDist), ZOOM_MIN, ZOOM_MAX);

    // Keep the pinch center stable in screen space
    const rect = getCanvasRect();
    const center = { x: (p1.x + p2.x) * 0.5 - rect.left, y: (p1.y + p2.y) * 0.5 - rect.top };
    const startCenter = {
      x: touchState.startCenter.x - rect.left,
      y: touchState.startCenter.y - rect.top,
    };

    const sx = startCenter.x;
    const sy = startCenter.y;

    // Compute canvas point under startCenter
    const cX = (sx - touchState.startOffsetX) / touchState.startScale;
    const cY = (sy - touchState.startOffsetY) / touchState.startScale;

    // New offset so that canvas point stays under the current center
    viewState.scale = scale;
    viewState.offsetX = center.x - cX * scale;
    viewState.offsetY = center.y - cY * scale;

    // Also allow two-finger pan naturally as center moves
  }

  // ======== EXPORT PNG ========
  function exportPNG() {
    // Flatten visible layers (all layers) onto a temp canvas and download.
    const out = document.createElement("canvas");
    out.width = MAIN_W;
    out.height = MAIN_H;
    const ctx = out.getContext("2d", { alpha: false, desynchronized: true });

    // Background white
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, MAIN_W, MAIN_H);

    for (let i = 0; i < LAYER_COUNT; i++) {
      ctx.drawImage(layers[i].canvas, 0, 0);
    }

    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "painting.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }, "image/png");
  }

  // ======== RENDER LOOP ========
  function resizeViewCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = view.getBoundingClientRect();
    view.width = Math.floor(rect.width * dpr);
    view.height = Math.floor(rect.height * dpr);
    viewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    viewCtx.imageSmoothingEnabled = false;

    // Initialize view transform to center the main canvas
    // (do once unless user already panned/zoomed)
    if (!resizeViewCanvas._initialized) {
      resizeViewCanvas._initialized = true;
      viewState.scale = 0.6; // initial view
      const cx = rect.width * 0.5;
      const cy = rect.height * 0.5;
      viewState.offsetX = cx - (MAIN_W * viewState.scale) * 0.5;
      viewState.offsetY = cy - (MAIN_H * viewState.scale) * 0.5;
    }
  }

  function render() {
    updateSliderLabels();
    sizeSlider.updateUI();
    spaceSlider.updateUI();

    const rect = view.getBoundingClientRect();
    viewCtx.setTransform(1, 0, 0, 1, 0, 0);
    viewCtx.clearRect(0, 0, rect.width, rect.height);

    // Background
    viewCtx.fillStyle = "#111";
    viewCtx.fillRect(0, 0, rect.width, rect.height);

    // Apply view transform
    viewCtx.save();
    viewCtx.translate(viewState.offsetX, viewState.offsetY);
    viewCtx.scale(viewState.scale, viewState.scale);

    // Canvas background (white)
    viewCtx.fillStyle = "#ffffff";
    viewCtx.fillRect(0, 0, MAIN_W, MAIN_H);

    // Composite layers
    viewCtx.imageSmoothingEnabled = false;
    for (let i = 0; i < LAYER_COUNT; i++) {
      viewCtx.drawImage(layers[i].canvas, 0, 0);
    }

    // Border
    viewCtx.strokeStyle = "rgba(0,0,0,0.25)";
    viewCtx.lineWidth = 4 / viewState.scale;
    viewCtx.strokeRect(0, 0, MAIN_W, MAIN_H);

    viewCtx.restore();

    requestAnimationFrame(render);
  }

  // ======== INIT ========
  function init() {
    // Stamp canvas starts transparent; leave as-is.

    // Build layers UI
    buildLayerUI();

    // Initialize pressed states
    modeBtn.setAttribute("aria-pressed", "false");
    pSizeBtn.setAttribute("aria-pressed", "true");
    pOpBtn.setAttribute("aria-pressed", "false");

    // Stamp window initial position
    layoutStampWindow();

    // Size view and start render loop
    resizeViewCanvas();
    window.addEventListener("resize", () => {
      resizeViewCanvas();
      layoutStampWindow();
    });

    render();
  }

  init();
})();

