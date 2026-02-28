// game.js — Contest-friendly raycast FPS (visual polish pass)
// Adds: textured floor/ceiling (perspective), fog shading, vignette+scanlines overlay,
// wall edge outlines, subtle screen shake. No assets, no libs.

(() => {
  // ----------------- Config -----------------
  const RW = 320, RH = 180;
  const FOV = Math.PI / 3;
  const PROJ = (RW / 2) / Math.tan(FOV / 2);
  const MAX_RAY_STEPS = 64;

  const TEX = 32, TEXN = TEX * TEX, SH = 32;
  const PLAYER_R = 0.22; // Keep player from hugging walls too closely.
  const ENEMY_R = 0.28;
  const BOSS_R = 0.55;
  const BOSS_HP = 48;
  const BOSS_BLIND_R = 11.2;
  const BOSS_BLIND_GAIN = 0.92;
  const BOSS_MIND_R = 6.5;
  const BOSS_JUMPSCARE_RANGE = 6.4;
  const BOSS_JUMPSCARE_CD = 4.6;
  const BOSS_JUMPSCARE_DUR = 0.58;
  const FIRE_R = 0.13;
  const FIRE_SPEED = 2.75;
  const FIRE_DMG = 16;
  const FIRE_TELEGRAPH = 0.32;
  const FIRE_TRAIL_LEN = 0.24;
  const BASE_ENEMIES = 8;
  const ENEMY_DETECT_R = 7.5;
  const FLOOR_COUNT = 3;
  const WEAPONS = [
    { name: "RIFLE", short: "RFL", cd: 0.18, flash: 0.10, recoilAdd: 0.12, recoilMax: 0.18, spread: 0.004, knock: 0.10, auto: false, snd: "rifle" },
    { name: "MACHINE", short: "MG", cd: 0.070, flash: 0.055, recoilAdd: 0.055, recoilMax: 0.24, spread: 0.018, knock: 0.07, auto: true, snd: "mg" },
  ];

  // Fog tint (used during shading bake)
  const FOG_R = 10, FOG_G = 14, FOG_B = 22;

  // ----------------- Canvas (scaled) -----------------
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;

  const buf = document.createElement("canvas");
  buf.width = RW; buf.height = RH;
  const g = buf.getContext("2d", { alpha: false });
  g.imageSmoothingEnabled = false;

  let scale = 1, ox = 0, oy = 0;

  function resize() {
    c.width = innerWidth;
    c.height = innerHeight;
    scale = Math.max(1, Math.floor(Math.min(c.width / RW, c.height / RH)));
    ox = (c.width - RW * scale) >> 1;
    oy = (c.height - RH * scale) >> 1;
  }

  function mountCanvas() {
    const b = document.body;
    if (!b) return false;
    b.style.margin = "0";
    b.style.overflow = "hidden";
    b.style.background = "#070A10";
    if (!c.parentNode) b.appendChild(c);
    c.style.imageRendering = "pixelated";
    resize();
    return true;
  }

  addEventListener("resize", resize);
  if (!mountCanvas()) addEventListener("DOMContentLoaded", mountCanvas, { once: true });

  // ----------------- Input -----------------
  const keys = Object.create(null);
  let fireMouse = 0;
  let fireKey = 0;
  let triggerHeld = 0;
  const refreshTrigger = () => { triggerHeld = (fireMouse || fireKey) ? 1 : 0; };

  addEventListener("keydown", (e) => {
    keys[e.key.toLowerCase()] = 1;

    if ((state === "intro" || state === "menu") && (e.key === " " || e.key === "Enter")) startGame();
    if (state === "dead" && (e.key === "r" || e.key === "R" || e.key === "x" || e.key === "X" || e.key === "Enter")) reset();
    if (state === "won" && (e.key === "r" || e.key === "R" || e.key === "x" || e.key === "X" || e.key === "Enter")) reset();
    if (!e.repeat && state === "play" && e.key === "1") setWeapon(0);
    if (!e.repeat && state === "play" && e.key === "2") setWeapon(1);
    if (e.key === "Escape") {
      if (document.pointerLockElement === c) document.exitPointerLock?.();
    }
  });
  addEventListener("keyup", e => {
    keys[e.key.toLowerCase()] = 0;
    if (e.key === " " || e.key === "Enter") {
      fireKey = 0;
      refreshTrigger();
    }
  });

  let locked = false;
  addEventListener("pointerlockchange", () => {
    locked = (document.pointerLockElement === c);
  });

  let mouseDX = 0;
  addEventListener("mousemove", (e) => {
    if (!locked) return;
    mouseDX += e.movementX || 0;
  });

  c.addEventListener("mousedown", () => {
    audio.userGesture();
    if (!locked) c.requestPointerLock?.().catch?.(() => { });
    if (state === "intro" || state === "menu") startGame();
    else if (state === "dead" || state === "won") reset();
    else {
      fireMouse = 1;
      refreshTrigger();
      shoot();
    }
  });
  addEventListener("mouseup", () => {
    fireMouse = 0;
    refreshTrigger();
  });
  addEventListener("blur", () => {
    fireMouse = 0;
    fireKey = 0;
    refreshTrigger();
  });

  addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      audio.userGesture();
      if (state === "play") {
        fireKey = 1;
        refreshTrigger();
        shoot();
      }
    }
  });

  // ----------------- Helpers -----------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rand = (a, b) => a + Math.random() * (b - a);
  const hypot = Math.hypot;

  const LE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;
  const pack = (r, gg, b) => (LE ? ((255 << 24) | (b << 16) | (gg << 8) | r) : ((r << 24) | (gg << 16) | (b << 8) | 255));

  function hash2(x, y, s) {
    let n = (x * 374761393 + y * 668265263 + s * 1442695041) | 0;
    n = (n ^ (n >>> 13)) | 0;
    n = Math.imul(n, 1274126177) | 0;
    return (n >>> 0);
  }

  // ----------------- Audio (procedural) -----------------
  const audio = (() => {
    let ctxA = null;
    let master = null;
    let musicBus1 = null;
    let musicBus2 = null;
    let fxDry = null;
    let fxRev = null;
    let fxCrush = null;
    let crushAmt = 0;
    let crushLastL = 0;
    let crushLastR = 0;
    let crushPhase = 0;
    let threatCd = 0;
    let stepCd = 0;
    let hurtUntil = 0;
    let musicUnlocked = false;
    let musicTrack = "none";
    let musicTimer = 0;
    let musicSeq = null;
    let musicSeq2 = null;
    let musicEvtI = 0;
    let musicEvtI2 = 0;
    let musicEvtTick = 0;
    let musicEvtTick2 = 0;
    let musicLoopStart = 0;
    let musicLoopStart2 = 0;
    let musicLoopDur = 0;
    let musicLoopDur2 = 0;
    const MUSIC_BPM = 120;
    const MUSIC_TPB = 96;
    const MUSIC_SPT = 60 / (MUSIC_BPM * MUSIC_TPB);
    const MUSIC_LOOK = 0.20;
    const MUSIC_SHIFT_NORM = 0;
    const MUSIC_SHIFT_FINAL = 0;
    const MUSIC_GAIN = 6.0;
    const LOOP_TICKS_NORM = 13680;
    const LOOP_TICKS_FINAL = 13728;
    const LOOP_TICKS_COMMON = LOOP_TICKS_NORM > LOOP_TICKS_FINAL ? LOOP_TICKS_NORM : LOOP_TICKS_FINAL;
    const SEQ_NORM = [0, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 144, 48, 34, 48, 48, 30, 144, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 96, 48, 32, 48, 48, 34, 192, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 144, 48, 34, 48, 48, 30, 144, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 96, 48, 32, 48, 48, 34, 192, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 144, 48, 34, 48, 48, 30, 144, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 96, 48, 32, 48, 48, 34, 192, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 144, 48, 39, 48, 48, 35, 144, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 96, 48, 37, 48, 48, 39, 192, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 144, 48, 39, 48, 48, 35, 144, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 96, 48, 37, 48, 48, 39, 192, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 144, 48, 34, 48, 48, 30, 144, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 96, 48, 32, 48, 48, 34, 192, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 144, 48, 34, 48, 48, 30, 144, 48, 35, 48, 48, 30, 48, 48, 38, 48, 48, 35, 48, 48, 42, 48, 48, 38, 48, 48, 35, 48, 48, 38, 48, 48, 37, 48, 48, 32, 96, 48, 32, 48, 48, 34, 192, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 144, 48, 39, 48, 48, 35, 144, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 96, 48, 37, 48, 48, 39, 192, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 144, 48, 39, 48, 48, 35, 144, 48, 40, 48, 48, 35, 48, 48, 43, 48, 48, 40, 48, 48, 47, 48, 48, 43, 48, 48, 40, 48, 48, 43, 48, 48, 42, 48, 48, 37, 96, 48, 37, 48, 48, 39];
    const SEQ_FINAL = [1536, 96, 59, 96, 96, 66, 192, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 288, 72, 66, 96, 96, 66, 96, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 192, 96, 59, 96, 96, 66, 192, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 288, 72, 66, 96, 96, 66, 96, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 192, 96, 64, 96, 96, 71, 192, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63, 288, 72, 71, 96, 96, 71, 96, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63, 192, 96, 64, 96, 96, 71, 192, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63, 288, 72, 71, 96, 96, 71, 96, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63, 192, 96, 59, 96, 96, 66, 192, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 288, 72, 66, 96, 96, 66, 96, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 192, 96, 59, 96, 96, 66, 192, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 288, 72, 66, 96, 96, 66, 96, 48, 64, 48, 48, 62, 48, 96, 61, 192, 96, 58, 192, 96, 64, 96, 96, 71, 192, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63, 288, 72, 71, 96, 96, 71, 96, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63, 192, 96, 64, 96, 96, 71, 192, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63, 288, 72, 71, 96, 96, 71, 96, 48, 69, 48, 48, 67, 48, 96, 66, 192, 96, 63];

    function makeIR(sec, decay) {
      if (!ctxA) return null;
      const len = Math.max(1, (ctxA.sampleRate * sec) | 0);
      const b = ctxA.createBuffer(2, len, ctxA.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = b.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          const t = i / len;
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
        }
      }
      return b;
    }

    function ensure() {
      if (ctxA) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctxA = new AC();
      master = ctxA.createGain();
      master.gain.value = 0.34;
      fxDry = ctxA.createGain();
      fxRev = ctxA.createGain();
      fxCrush = ctxA.createGain();
      fxDry.gain.value = 1;
      fxRev.gain.value = 0;
      fxCrush.gain.value = 0;

      const rev = ctxA.createConvolver();
      rev.buffer = makeIR(0.72, 2.8);
      rev.normalize = true;

      master.connect(fxDry);
      fxDry.connect(ctxA.destination);
      master.connect(rev);
      rev.connect(fxRev);
      fxRev.connect(ctxA.destination);

      if (ctxA.createScriptProcessor) {
        const crushNode = ctxA.createScriptProcessor(1024, 2, 2);
        crushNode.onaudioprocess = (ev) => {
          const iL = ev.inputBuffer.getChannelData(0);
          const iR = ev.inputBuffer.numberOfChannels > 1
            ? ev.inputBuffer.getChannelData(1)
            : iL;
          const oL = ev.outputBuffer.getChannelData(0);
          const oR = ev.outputBuffer.getChannelData(1);

          const a = clamp(crushAmt, 0, 1);
          const hold = 1 + ((a * 42) | 0);
          const bits = 11 - ((a * 9) | 0); // 11 -> 2 bits
          const q = 1 << Math.max(1, bits - 1);
          for (let i = 0; i < oL.length; i++) {
            if (crushPhase++ % hold === 0) {
              crushLastL = Math.round(iL[i] * q) / q;
              crushLastR = Math.round(iR[i] * q) / q;
            }
            oL[i] = crushLastL;
            oR[i] = crushLastR;
          }
        };
        master.connect(crushNode);
        crushNode.connect(fxCrush);
        fxCrush.connect(ctxA.destination);
      }

      musicBus1 = ctxA.createGain();
      musicBus2 = ctxA.createGain();
      const musicEq1 = ctxA.createBiquadFilter();
      musicEq1.type = "highshelf";
      musicEq1.frequency.value = 1500;
      musicEq1.gain.value = -16;
      musicBus1.connect(musicEq1);
      musicEq1.connect(master);
      musicBus2.connect(master);
    }

    function resume() {
      ensure();
      if (ctxA && ctxA.state === "suspended") ctxA.resume().catch(() => { });
    }

    function midiHz(m) {
      return 440 * Math.pow(2, (m - 69) / 12);
    }

    function stopMusicLoop() {
      if (musicTimer) {
        clearInterval(musicTimer);
        musicTimer = 0;
      }
      musicSeq = null;
      musicSeq2 = null;
      musicEvtI = 0;
      musicEvtI2 = 0;
      musicEvtTick = 0;
      musicEvtTick2 = 0;
    }

    function musicSchedule() {
      if (!ctxA || !master || !musicUnlocked || !musicSeq) return;
      const now = ctxA.currentTime;
      while ((musicLoopStart + musicLoopDur) <= now) {
        musicLoopStart += musicLoopDur;
        musicEvtI = 0;
        musicEvtTick = 0;
      }
      const look = now + MUSIC_LOOK;
      while (musicEvtI < musicSeq.length) {
        const dt = musicSeq[musicEvtI];
        const durTick = musicSeq[musicEvtI + 1];
        const note = musicSeq[musicEvtI + 2];
        const evTick = musicEvtTick + dt;
        const evTime = musicLoopStart + evTick * MUSIC_SPT;
        if (evTime > look) break;

        const delay = evTime - now;
        if (delay > -0.08) {
          const f = midiHz(note);
          const dur = durTick * MUSIC_SPT;
          tone(f, dur, 0.075 * MUSIC_GAIN, "square", Math.max(0, delay), true, musicBus1);
        }

        musicEvtTick = evTick;
        musicEvtI += 3;
      }

      if (!musicSeq2) return;
      while ((musicLoopStart2 + musicLoopDur2) <= now) {
        musicLoopStart2 += musicLoopDur2;
        musicEvtI2 = 0;
        musicEvtTick2 = 0;
      }
      while (musicEvtI2 < musicSeq2.length) {
        const dt = musicSeq2[musicEvtI2];
        const durTick = musicSeq2[musicEvtI2 + 1];
        const note = musicSeq2[musicEvtI2 + 2];
        const evTick = musicEvtTick2 + dt;
        const evTime = musicLoopStart2 + evTick * MUSIC_SPT;
        if (evTime > look) break;

        const delay = evTime - now;
        if (delay > -0.08) {
          const f = midiHz(note);
          const dur = durTick * MUSIC_SPT;
          tone(f, dur, 0.085 * MUSIC_GAIN, "triangle", Math.max(0, delay), true, musicBus2);
        }

        musicEvtTick2 = evTick;
        musicEvtI2 += 3;
      }
    }

    function startMusicLoop(track) {
      if (!musicUnlocked || track === "none") {
        stopMusicLoop();
        return;
      }
      const seqA = SEQ_NORM;
      const seqB = SEQ_FINAL;
      if (musicSeq === seqA && musicSeq2 === seqB && musicTimer) return;
      stopMusicLoop();
      musicSeq = seqA;
      musicSeq2 = seqB;
      const loopDur = LOOP_TICKS_COMMON * MUSIC_SPT;
      musicLoopDur = loopDur;
      musicLoopDur2 = loopDur;
      musicLoopStart = (ctxA ? ctxA.currentTime : 0) + 0.02;
      musicLoopStart2 = musicLoopStart;
      musicTimer = setInterval(musicSchedule, 50);
      musicSchedule();
    }

    function syncMusic() {
      if (!musicUnlocked || musicTrack === "none") {
        stopMusicLoop();
        return;
      }
      resume();
      startMusicLoop(musicTrack);
    }

    function tone(freq, dur, vol, type, delay, sustain, outNode) {
      if (!ctxA || !master) return;
      const t = ctxA.currentTime + (delay || 0);
      const o = ctxA.createOscillator();
      const gg = ctxA.createGain();
      const d = Math.max(0.006, dur || 0.06);
      const v = Math.max(0.0001, vol || 0.08);
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, t);
      gg.gain.setValueAtTime(v, t);
      if (sustain) {
        const rel = Math.min(0.02, Math.max(0.005, d * 0.18));
        const hold = t + d - rel;
        gg.gain.setValueAtTime(v, hold);
        gg.gain.exponentialRampToValueAtTime(0.0001, t + d);
      } else {
        gg.gain.exponentialRampToValueAtTime(0.0001, t + d);
      }
      o.connect(gg);
      gg.connect(outNode || master);
      o.start(t);
      o.stop(t + d + 0.002);
    }

    function threat(level, dt) {
      if (!ctxA || !master || level <= 0) {
        threatCd = 0;
        return;
      }
      threatCd -= dt;
      if (threatCd > 0) return;

      const t = clamp(level, 0, 1);
      threatCd = 0.78 - t * 0.60; // faster and more oppressive as enemies get closer
      const base = 58 + t * 88;
      const jitter = 0.96 + Math.random() * 0.10;

      // Low dissonant stack + sub rumble for a scarier approach cue.
      tone(base * jitter, 0.22, 0.11 + t * 0.11, "sawtooth");
      tone(base * 0.52 * (1.0 + Math.random() * 0.04), 0.28, 0.10 + t * 0.10, "triangle", 0.01);
      tone(base * 1.41 * (0.98 + Math.random() * 0.06), 0.16, 0.08 + t * 0.08, "sawtooth", 0.02);
      tone(base * 2.93, 0.07, 0.05 + t * 0.06, "square", 0.04);
    }

    function footstep(level, dt) {
      if (!ctxA || !master || level <= 0) {
        stepCd = 0;
        return;
      }
      stepCd -= dt;
      if (stepCd > 0) return;

      const t = clamp(level, 0, 1);
      stepCd = 0.36 - t * 0.18;
      const f = 82 + Math.random() * 26;
      tone(f, 0.06, 0.07 + t * 0.08, "triangle");
      tone(f * 1.8, 0.025, 0.03 + t * 0.035, "square", 0.01);
    }

    return {
      userGesture() {
        resume();
        musicUnlocked = true;
        syncMusic();
      },
      musicForFloor(idx) {
        musicTrack = idx >= FLOOR_COUNT - 1 ? "final" : "normal";
        syncMusic();
      },
      stopMusic() {
        musicTrack = "none";
        syncMusic();
      },
      shoot(kind) {
        if (kind === "mg") {
          tone(860 + Math.random() * 100, 0.020, 0.14, "square");
          tone(210 + Math.random() * 35, 0.050, 0.09, "sawtooth");
          tone(80 + Math.random() * 12, 0.060, 0.06, "triangle", 0.006);
          return;
        }
        tone(1120, 0.035, 0.18, "square");
        tone(230, 0.09, 0.12, "sawtooth");
        tone(95, 0.11, 0.08, "triangle", 0.01);
      },
      hit() { tone(560, 0.05, 0.11, "triangle"); },
      kill() { tone(640, 0.07, 0.13, "triangle"); tone(980, 0.08, 0.10, "triangle"); },
      hurt() {
        if (!ctxA) return;
        if (ctxA.currentTime < hurtUntil) return;
        hurtUntil = ctxA.currentTime + 0.09;
        tone(140, 0.09, 0.16, "sawtooth");
      },
      fireball(enraged) {
        const t = enraged ? 1 : 0;
        tone(180 + Math.random() * 24, 0.10, 0.11 + t * 0.05, "sawtooth");
        tone(420 + Math.random() * 50, 0.07, 0.08 + t * 0.04, "triangle", 0.015);
        tone(760 + Math.random() * 70, 0.05, 0.05 + t * 0.03, "square", 0.03);
      },
      jumpscare() {
        tone(62, 0.22, 0.18, "sawtooth");
        tone(118, 0.24, 0.14, "triangle", 0.01);
        tone(940, 0.06, 0.14, "square", 0.02);
      },
      pickup() { tone(900, 0.08, 0.10, "square"); tone(1220, 0.10, 0.08, "square"); },
      click() { tone(650, 0.06, 0.08, "square"); },
      bossFx(level) {
        if (!ctxA || !master || !fxDry || !fxRev || !fxCrush) return;
        const a = Math.pow(clamp(level, 0, 1), 0.65);
        crushAmt = a;
        const t = ctxA.currentTime;
        fxDry.gain.setTargetAtTime(1 - a * 0.62, t, 0.06);
        fxRev.gain.setTargetAtTime(a * 0.90, t, 0.07);
        fxCrush.gain.setTargetAtTime(a * 0.72, t, 0.05);
      },
      footstep,
      threat,
    };
  })();

  // ----------------- Maps -----------------
  const MAP_W = 25, MAP_H = 25;

  function generateMapLines() {
    const w = MAP_W, h = MAP_H;
    const cells = new Uint8Array(w * h);
    const id = (x, y) => y * w + x;
    const randWall = () => 1 + ((Math.random() * 3) | 0);

    // Fill with wall types
    for (let i = 0; i < cells.length; i++) cells[i] = randWall();

    // Layout: logical maze cells, each cell is 2x2 open, walls are 1 thick.
    // Map dimensions follow: size = cells*2 + (cells+1)*1 => 3*cells + 1.
    const step = 3; // 2 open + 1 wall
    const CW = ((w - 1) / step) | 0;
    const CH = ((h - 1) / step) | 0;

    function cellX(cx) { return 1 + cx * step; }
    function cellY(cy) { return 1 + cy * step; }

    function carve2x2(cx, cy) {
      const x0 = cellX(cx), y0 = cellY(cy);
      cells[id(x0, y0)] = 0; cells[id(x0 + 1, y0)] = 0;
      cells[id(x0, y0 + 1)] = 0; cells[id(x0 + 1, y0 + 1)] = 0;
    }

    function connect(cx, cy, nx, ny) {
      const x0 = cellX(cx), y0 = cellY(cy);
      if (nx === cx + 1) { // right
        const wx = x0 + 2;
        cells[id(wx, y0)] = 0; cells[id(wx, y0 + 1)] = 0;
      } else if (nx === cx - 1) { // left
        const wx = x0 - 1;
        cells[id(wx, y0)] = 0; cells[id(wx, y0 + 1)] = 0;
      } else if (ny === cy + 1) { // down
        const wy = y0 + 2;
        cells[id(x0, wy)] = 0; cells[id(x0 + 1, wy)] = 0;
      } else if (ny === cy - 1) { // up
        const wy = y0 - 1;
        cells[id(x0, wy)] = 0; cells[id(x0 + 1, wy)] = 0;
      }
    }

    // Carve all cells
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) carve2x2(cx, cy);

    // Perfect maze via DFS on logical cells
    const vis = new Uint8Array(CW * CH);
    const st = new Int16Array(CW * CH);
    let sp = 0;

    function push(v) { st[sp++] = v; }
    function pop() { return st[--sp]; }
    function top() { return st[sp - 1]; }

    vis[0] = 1; // start at (0,0) near spawn
    push(0);

    const nx = new Int8Array(4);
    const ny = new Int8Array(4);

    while (sp) {
      const cur = top();
      const cx = cur % CW;
      const cy = (cur / CW) | 0;

      let n = 0;
      if (cx > 0 && !vis[cur - 1]) { nx[n] = cx - 1; ny[n] = cy; n++; }
      if (cx + 1 < CW && !vis[cur + 1]) { nx[n] = cx + 1; ny[n] = cy; n++; }
      if (cy > 0 && !vis[cur - CW]) { nx[n] = cx; ny[n] = cy - 1; n++; }
      if (cy + 1 < CH && !vis[cur + CW]) { nx[n] = cx; ny[n] = cy + 1; n++; }

      if (!n) { pop(); continue; }

      const k = (Math.random() * n) | 0;
      const tcx = nx[k], tcy = ny[k];
      const nxt = tcy * CW + tcx;

      connect(cx, cy, tcx, tcy);
      vis[nxt] = 1;
      push(nxt);
    }

    // Add a few loops (fewer loops on higher floors => more maze-like and harder)
    let loops = 6 - floorIndex * 2; // 6,4,2
    if (loops < 2) loops = 2;

    for (let i = 0; i < loops; i++) {
      const cx = (Math.random() * CW) | 0;
      const cy = (Math.random() * CH) | 0;
      const dir = (Math.random() * 4) | 0;

      let tcx = cx, tcy = cy;
      if (dir === 0 && cx + 1 < CW) tcx = cx + 1;
      else if (dir === 1 && cx > 0) tcx = cx - 1;
      else if (dir === 2 && cy + 1 < CH) tcy = cy + 1;
      else if (dir === 3 && cy > 0) tcy = cy - 1;
      else continue;

      connect(cx, cy, tcx, tcy);
    }

    // Solid border walls
    for (let x = 0; x < w; x++) { cells[id(x, 0)] = randWall(); cells[id(x, h - 1)] = randWall(); }
    for (let y = 0; y < h; y++) { cells[id(0, y)] = randWall(); cells[id(w - 1, y)] = randWall(); }

    // Spawn pocket always clear
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) cells[id(x, y)] = 0;

    // Convert to string lines
    const lines = new Array(h);
    for (let y = 0; y < h; y++) {
      let row = "";
      for (let x = 0; x < w; x++) row += String(cells[id(x, y)]);
      lines[y] = row;
    }
    return lines;
  }


  let MW = 0, MH = 0, grid = null;
  let floorWallType = 1;

  function loadMap(lines) {
    MH = lines.length;
    MW = lines[0].length;
    grid = new Uint8Array(MW * MH);
    for (let y = 0; y < MH; y++) {
      const row = lines[y];
      for (let x = 0; x < MW; x++) {
        const v = row.charCodeAt(x) - 48;
        grid[y * MW + x] = v <= 0 ? 0 : floorWallType;
      }
    }
    widenCorridors();
  }

  // Much more conservative smoother (preserve maze separators).
  function widenCorridors() {
    // With the 2-wide maze generator, we don't need smoothing.
    // Leaving this empty preserves clean, readable corridors.
  }


  function cellAt(x, y) {
    const ix = x | 0, iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= MW || iy >= MH) return 1;
    return grid[iy * MW + ix];
  }
  function isWall(x, y) { return cellAt(x, y) !== 0; }

  function canStand(px, py, r = PLAYER_R) {
    const d = r * 0.70710678;
    return (
      !isWall(px + r, py) &&
      !isWall(px - r, py) &&
      !isWall(px, py + r) &&
      !isWall(px, py - r) &&
      !isWall(px + d, py + d) &&
      !isWall(px - d, py + d) &&
      !isWall(px + d, py - d) &&
      !isWall(px - d, py - d)
    );
  }
  function findSpawn() {
    if (canStand(1.5, 1.5, PLAYER_R)) return { x: 1.5, y: 1.5 };
    for (let y = 1; y < MH - 1; y++) {
      for (let x = 1; x < MW - 1; x++) {
        const px = x + 0.5, py = y + 0.5;
        if (cellAt(px, py) === 0 && canStand(px, py, PLAYER_R)) return { x: px, y: py };
      }
    }
    return { x: 1.5, y: 1.5 };
  }

  function moveCircle(body, moveX, moveY, r) {
    const dist = hypot(moveX, moveY);
    if (dist <= 0.000001) return false;

    const steps = Math.max(1, Math.ceil(dist / 0.07));
    const sx = moveX / steps;
    const sy = moveY / steps;
    let moved = false;

    for (let i = 0; i < steps; i++) {
      const nx = body.x + sx;
      const ny = body.y + sy;

      if (canStand(nx, ny, r)) {
        body.x = nx;
        body.y = ny;
        moved = true;
        continue;
      }

      let slid = false;
      if (canStand(body.x + sx, body.y, r)) {
        body.x += sx;
        slid = true;
      }
      if (canStand(body.x, body.y + sy, r)) {
        body.y += sy;
        slid = true;
      }
      if (slid) moved = true;
      else break;
    }
    return moved;
  }

  function nudgeOut(body, r) {
    if (canStand(body.x, body.y, r)) return;

    for (let step = 1; step <= 6; step++) {
      const d = step * 0.03;
      for (let i = 0; i < 8; i++) {
        const a = i * (Math.PI * 0.25);
        const nx = body.x + Math.cos(a) * d;
        const ny = body.y + Math.sin(a) * d;
        if (canStand(nx, ny, r)) {
          body.x = nx;
          body.y = ny;
          return;
        }
      }
    }
  }

  function cellOpen(ix, iy) {
    if (ix < 0 || iy < 0 || ix >= MW || iy >= MH) return false;
    return grid[iy * MW + ix] === 0;
  }

  function aStarNextStep(sx, sy, gx, gy) {
    if (!cellOpen(sx, sy) || !cellOpen(gx, gy)) return null;
    if (sx === gx && sy === gy) return { x: sx + 0.5, y: sy + 0.5 };

    const n = MW * MH;
    const start = sy * MW + sx;
    const goal = gy * MW + gx;

    const open = [];
    const inOpen = new Uint8Array(n);
    const closed = new Uint8Array(n);
    const came = new Int16Array(n);
    const gScore = new Int16Array(n);

    for (let i = 0; i < n; i++) {
      came[i] = -1;
      gScore[i] = 32767;
    }

    gScore[start] = 0;
    inOpen[start] = 1;
    open.push(start);

    while (open.length) {
      let best = 0;
      let bestId = open[0];
      let bestF = gScore[bestId] + Math.abs((bestId % MW) - gx) + Math.abs(((bestId / MW) | 0) - gy);
      for (let i = 1; i < open.length; i++) {
        const id = open[i];
        const f = gScore[id] + Math.abs((id % MW) - gx) + Math.abs(((id / MW) | 0) - gy);
        if (f < bestF) {
          bestF = f;
          best = i;
          bestId = id;
        }
      }

      const cur = bestId;
      open.splice(best, 1);
      inOpen[cur] = 0;
      if (cur === goal) break;
      closed[cur] = 1;

      const cx = cur % MW, cy = (cur / MW) | 0;
      const n0 = cur - 1;
      const n1 = cur + 1;
      const n2 = cur - MW;
      const n3 = cur + MW;

      if (cx > 0 && !closed[n0] && grid[n0] === 0) {
        const ng = gScore[cur] + 1;
        if (ng < gScore[n0]) {
          gScore[n0] = ng; came[n0] = cur;
          if (!inOpen[n0]) { inOpen[n0] = 1; open.push(n0); }
        }
      }
      if (cx + 1 < MW && !closed[n1] && grid[n1] === 0) {
        const ng = gScore[cur] + 1;
        if (ng < gScore[n1]) {
          gScore[n1] = ng; came[n1] = cur;
          if (!inOpen[n1]) { inOpen[n1] = 1; open.push(n1); }
        }
      }
      if (cy > 0 && !closed[n2] && grid[n2] === 0) {
        const ng = gScore[cur] + 1;
        if (ng < gScore[n2]) {
          gScore[n2] = ng; came[n2] = cur;
          if (!inOpen[n2]) { inOpen[n2] = 1; open.push(n2); }
        }
      }
      if (cy + 1 < MH && !closed[n3] && grid[n3] === 0) {
        const ng = gScore[cur] + 1;
        if (ng < gScore[n3]) {
          gScore[n3] = ng; came[n3] = cur;
          if (!inOpen[n3]) { inOpen[n3] = 1; open.push(n3); }
        }
      }
    }

    if (came[goal] === -1) return null;
    let step = goal;
    while (came[step] !== start && came[step] !== -1) step = came[step];
    if (came[step] === -1) return null;

    return { x: (step % MW) + 0.5, y: ((step / MW) | 0) + 0.5 };
  }

  // ----------------- Textures (procedural + shaded w/ fog tint) -----------------
  const wallTex = new Array(4); // wallTex[type] = Uint32Array(SH*TEXN)
  let floorTex = null;          // Uint32Array(SH*TEXN)
  let ceilTex = null;           // Uint32Array(SH*TEXN)

  function bakeShades(base, out, minF, fogMix) {
    for (let s = 0; s < SH; s++) {
      const f = minF + (1 - minF) * (s / (SH - 1)); // 0..1 brightness
      const inv = 1 - f;
      const off = s * TEXN;
      for (let i = 0; i < TEXN; i++) {
        const c = base[i];
        const rr = c & 255;
        const gg = (c >>> 8) & 255;
        const bb = (c >>> 16) & 255;

        const r2 = (rr * f + FOG_R * inv * fogMix) | 0;
        const g2 = (gg * f + FOG_G * inv * fogMix) | 0;
        const b2 = (bb * f + FOG_B * inv * fogMix) | 0;

        out[off + i] = pack(r2, g2, b2);
      }
    }
  }

  function genTextures() {
    for (let t = 1; t <= 3; t++) {
      const base = new Uint32Array(TEXN);

      for (let y = 0; y < TEX; y++) {
        for (let x = 0; x < TEX; x++) {
          let r = 0, gg = 0, b = 0;

          if (t === 1) {
            // BRICKS: consistent mortar + offset rows
            const row = y >> 2;                 // brick rows (height 4)
            const off = (row & 1) ? 4 : 0;      // offset every other row
            const mortar = ((y & 3) === 0) || (((x + off) & 7) === 0);

            if (mortar) { r = 22; gg = 26; b = 34; }
            else {
              r = 110; gg = 92; b = 138;
              // small bevel for depth
              if (((y & 3) === 1) || (((x + off) & 7) === 1)) { r += 8; gg += 6; b += 8; }
              if (((y & 3) === 3) || (((x + off) & 7) === 7)) { r -= 6; gg -= 5; b -= 6; }
            }
          } else if (t === 2) {
            // PANELS: large 16x16 plates + bolts
            const px = x & 15, py = y & 15;
            const seam = (px === 0) || (py === 0);
            const bolt = ((px === 2 || px === 13) && (py === 2 || py === 13));
            const stripe = (px === 7 || px === 8) && (py > 2 && py < 14);

            r = 44; gg = 78; b = 126;
            if (seam) { r = 70; gg = 112; b = 170; }
            if (stripe) { r += 8; gg += 14; b += 18; }
            if (bolt) { r = 210; gg = 210; b = 210; }
          } else {
            // STONE: 8x8 blocks + simple cracks
            const bx = x & 7, by = y & 7;
            const seam = (bx === 0) || (by === 0);
            const crack = ((x + y) % 11) === 0;

            r = 26; gg = 102; b = 32;
            if (seam) { r -= 10; gg -= 16; b -= 10; }
            if (crack && !seam) { r -= 6; gg -= 10; b -= 6; }
          }

          base[y * TEX + x] = pack(clamp(r, 0, 255), clamp(gg, 0, 255), clamp(b, 0, 255));
        }
      }

      const shaded = new Uint32Array(SH * TEXN);
      bakeShades(base, shaded, 0.20, 0.92);
      wallTex[t] = shaded;
    }

    // Floor (clean large tiles, less noise)
    const floorBase = new Uint32Array(TEXN);
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const tile = (((x >> 4) ^ (y >> 4)) & 1);
        const seam = ((x & 15) === 0) || ((y & 15) === 0);
        const seamHeavy = ((x & 31) === 0) || ((y & 31) === 0);
        const dirMark = ((x & 31) === 6);
        let r = tile ? 28 : 24;
        let gg = tile ? 34 : 30;
        let b = tile ? 52 : 46;

        if (seam) { r = (r * 0.64) | 0; gg = (gg * 0.64) | 0; b = (b * 0.70) | 0; }
        if (seamHeavy) { r += 6; gg += 8; b += 12; }
        if (dirMark) { gg += 8; b += 12; }

        floorBase[y * TEX + x] = pack(clamp(r, 0, 255), clamp(gg, 0, 255), clamp(b, 0, 255));
      }
    }
    floorTex = new Uint32Array(SH * TEXN);
    bakeShades(floorBase, floorTex, 0.12, 1.05);

    // Ceiling (clean panel grid)
    const ceilBase = new Uint32Array(TEXN);
    for (let y = 0; y < TEX; y++) {
      for (let x = 0; x < TEX; x++) {
        const panel = ((x & 15) === 0) || ((y & 15) === 0);
        const beam = ((x & 31) === 8) || ((y & 31) === 8);
        const vent = ((x & 7) === 0) && ((y & 7) === 0);
        let r = 16, gg = 20, b = 30;

        if (panel) { r += 18; gg += 18; b += 26; }
        if (beam) { r += 6; gg += 8; b += 10; }
        if (vent) { r -= 8; gg -= 8; b -= 10; }

        ceilBase[y * TEX + x] = pack(clamp(r, 0, 255), clamp(gg, 0, 255), clamp(b, 0, 255));
      }
    }
    ceilTex = new Uint32Array(SH * TEXN);
    bakeShades(ceilBase, ceilTex, 0.10, 1.10);
  }
  genTextures();

  // ----------------- Enemy sprite -----------------
  function makeEnemySprite(hurt) {
    const s = document.createElement("canvas");
    s.width = 48; s.height = 80;
    const cg = s.getContext("2d");
    cg.imageSmoothingEnabled = false;
    cg.clearRect(0, 0, s.width, s.height);

    const body = hurt ? "#f2f2f2" : "#b44545";
    const shadow = hurt ? "#d8d8d8" : "#6f2727";

    // Rectangular body.
    cg.fillStyle = shadow;
    cg.fillRect(4, 4, 40, 72);
    cg.fillStyle = body;
    cg.fillRect(6, 6, 36, 68);

    // outline
    cg.fillStyle = "rgba(0,0,0,0.35)";
    cg.fillRect(4, 4, 40, 1);
    cg.fillRect(4, 75, 40, 1);
    cg.fillRect(4, 4, 1, 72);
    cg.fillRect(43, 4, 1, 72);

    return s;
  }

  function makeEnemyPhotoSprite(photo, hurt) {
    const s = document.createElement("canvas");
    s.width = 48; s.height = 80;
    const cg = s.getContext("2d");
    cg.imageSmoothingEnabled = true;
    cg.clearRect(0, 0, s.width, s.height);

    // Rectangle frame + photo fill (cover fit so faces are not squashed).
    cg.fillStyle = "rgba(0,0,0,0.55)";
    cg.fillRect(2, 2, 44, 76);

    const sw = photo.naturalWidth || photo.width || 1;
    const sh = photo.naturalHeight || photo.height || 1;
    const dstW = 40, dstH = 72;
    const srcAspect = sw / sh;
    const dstAspect = dstW / dstH;
    let sx = 0, sy = 0, cw = sw, ch = sh;
    if (srcAspect > dstAspect) {
      cw = sh * dstAspect;
      sx = (sw - cw) * 0.5;
    } else {
      ch = sw / dstAspect;
      sy = (sh - ch) * 0.5;
    }
    cg.drawImage(photo, sx, sy, cw, ch, 4, 4, dstW, dstH);

    // Hurt flash while preserving face.
    if (hurt) {
      cg.fillStyle = "rgba(255,255,255,0.18)";
      cg.fillRect(4, 4, 40, 72);
    }

    // Outline for readability.
    cg.fillStyle = "rgba(0,0,0,0.35)";
    cg.fillRect(2, 2, 44, 1);
    cg.fillRect(2, 77, 44, 1);
    cg.fillRect(2, 2, 1, 76);
    cg.fillRect(45, 2, 1, 76);

    return s;
  }

  let enemyImg = makeEnemySprite(false);
  let enemyImgHurt = makeEnemySprite(true);
  let enemyImgReady = true;
  let bossImg = enemyImg;
  let bossImgHurt = enemyImgHurt;
  const crookVariants = [];
  const EMBED_BOSS = "data:image/webp;base64,UklGRrABAABXRUJQVlA4IKQBAACQCgCdASoiADoAPvFqqU4ppqQjMBVdUTAeCWYArk9okNUnsF4Z_IA8wc2hFMOOrtY_lpcynBy24Qk8uRKraM5AAfsY5Oz_Y0ra8iJWmchCwEBpVex3yexTNIPyy1AA_tdTp3Pbft4gUsO_aO9Jgx3B9iwPJznwrKchwh9ioWL8JUPWkPgiACGIHs3X9Q6QIWGTM1aGcCZR70G4drie8YeLAujZBUKq0V8QyqKX1GFkPyGlIi_1UbTjKCA4s3xPG7gz1pzf-52UBY-W-HSk_w7ZVugrbVSb8NCkk5lWiMu_sE5K6ac8D3GfCZrfnI05VXfkmI8kExpqyM5mDx2oVX_xCJn-UzdifuLhxjYo_3hiSTP4GUgnytn_yDYZOxOMl7SYzgo1uaNVOLOwoXmnboigcb0TPb0AvBVMnhjQvURnNlI8oAn2CdkNLwyFzUJVWWTqBwq9TmcCY1ekS6132EPxx5C9y9sPHL9BwjfynIvNjmNSbyYtHiKKhXypbXN6zjN3JDYpYyC6L5HNyvbnqrZ3_5N53kq7Ukru6uBKzs9U9asAAAA=";
  const EMBED_CROOKS = [
    "data:image/webp;base64,UklGRnoCAABXRUJQVlA4IG4CAADwDQCdASoiADoAPvVkqU6qpSOiMrbZmVAeiWwAuzM0cZ_xA7N21zwGm77v_QQMicxyJIaWJl9XTB52_EZVcb8fD4YSXHbOKc-U7ftKnB3JUghtTxp52SMVawZv5wtTuNwPKCZk7RfLN2EqkE9Ns4StdUXn1Jq6CUAA_vHgwVrcflwgbPJUVr3lDcIUo43ljXe6Uw8hFmVIAYyU5Q1LEHBH6pdRa42HWdgiAiPwAhQGLYPpCphWnibHMkDZzQE0SZl9Ix_ROSuEs6Vs3Af082RmSDIYKhKHWK_iLSjTKpfaIsGAzHLMVF0_wkeFEfYHD49ng1Bv-zTmzReyE6_aBLVpVathyZUVRX6k77gxLSIgi5Ru_dSDSbj7p7oKkxPv3KaNIemUSHyTGLpbxc1xioK7-XZgrWm66e5E6z4_doJ0Wl5okJwchwvvF-EYp88rMXU50V8RWiEHs0W779uddCp10YLzl-Ll2Uwhhimty2TT7ozaCvYYzbctPhS6pv8uUKy02VI1c7pmnO85aVBN-WlTk2zjTSA9s1V-zjnRnUjMDIiAo5sKFelK0ZuWAudCOJgiaEikPHWNZa7uPF0z9oVu90Wv7aAtp00n3dVIhCLJYtQm6bxk4c98_LL56FbdK-zlmkuR97yQjN9NzP7w5yaN5x7J-p9_syfafWb5xuboVBMoo7RE2-nGw3LO4W1Yd4niHi7x6jKvVDCVDfo3JsMaocM8DR3a8nfOO7yAnOoIfoPOiSX83LSY-OYrKmt6zsAkjGFO-iXDieFSy1q_pbHPgEfSkpbWI7OiTMd2YRNs6aNhuqLSXakwCQgCgqAA",
    "data:image/webp;base64,UklGRkYCAABXRUJQVlA4IDoCAADQCwCdASoiADoAPvViqE6qpSOiMBqqqVAeiWwAv3GB1t6MlONmt2E43Y7eW_pwmkToH83MPjm5SG1STbUWL1i0AUOOezkxpm0Ne8AZi888YoYpzsGo0WW_jwsqfTBXCwn2VL_wSBQAAP7DTGeo4pIzeYAOs3UvCO33WynWYH8FJROOsA6tV9TZU1tJpVxnv-jD_-GHPv-TgJ5oXfyLdZaNr3ybRuXu4OlKwfh1MF7tpUArBp7yFQFBQuRueN8MNNsMLI0ZoJe76jMsPIQR-j5L_Eq9iS59Z85EMUIXT2n917jjiXzJknBou1Pv8g-LrX3Oqb6GcX9O5c8a37H-o3ELqzxkxvRwY6tfQkWPwLEm6GYmopMZ78RJK-ZEu1SG5YWowustHaH14V8MfpwCJO8BInYkNceZ5quOH_-V3MwKR6qQY55bV4WS7D7LL8slIb_jGIvbBgTVkuQ7H7YkgbSoYfYLbeeLDUr6H9Jy4OrNS992VHhjAU_pVRpf62QaR0U0RWNZ-SaoT3aDQHzHHHhrIjD5kLbpJxk6lGROAzUP27rOt--CHZCGIclCuyIKj0trHJOQJf8YHOpTWIXdU9UCoqG4pNb_7lSNoAgov2oL_zAJQBMcPnXbH8-aGMHIzYUblfwr6LyfWnElm2mB5t99dBZ9p_HB9kf8X5PUZBg0tF4O4bAOOixMFFFQZBNJyIqQrBCunf9I9Qe37s7o_fmofyYkQPOdPHUMffGo8oM6EghWqC69gVvzEAA=",
    "data:image/webp;base64,UklGRogCAABXRUJQVlA4IHwCAACQDACdASoiADoAPvFYqk4ppKQiMrtpmTAeCWwAnTLexWCJNXcM1thM2Dw2VTnQuvhB7kPWh4biL2VPMLXgCiiwUFAaVU7PEV7YP-N0jF_ui_YqAYAYpnXWNS6Wlha135nuUYo9_n5BHPuHVKbAAP1mSdhd4egYvKiBrpS27BWgR803u2q1yPkfeNzOVz8JbOYiEOpVE-_TRVoZGDNjXXT1mmM1mBxbFRDj5GiZd-6RzoJiiNUj0Ik_A7UGBWh-ZIY2_KC3smNohNymHySQb-PzaFWudmb0FAhKbWDtm1dj615awuIeyNeP1532Ci3IQn1aJO2-mtJ1_JE1yk9U2vbFZJkFFg5-edt4YOXcztQYWg4tIHZ_1B7JkGUucxXFBu9LmtOHy1uhVeqtWJUNGBGNlsUJYTW-nW8D_4pXZl5lH91vG-QZ4B04MM0U6gDSjdUsB3H57DpIVh_6lK46-j8FufOjceLLXA3QARrLbuE5Whtw9qVgPD-YVTmrhXGcmf4RVDoIf4RVM15KKqd97nL-M3Y5TE3sRVJORpme1WFt6qltkMN1ipKqqtvugtoc-hTWUHKskjN2XVh4_6zS9AnMxwWd0AM_1t1tcd0DOdfA3GpFwZH9vCL_yXPc3y0SXfsZPYV25yLhKh-NuZM41QHReEKofuMqaSnPFk5HpvfldD07yuo8Lza-Yg8e__t25X6y18Zkn83nVUlUAS4nJ-zqL-EfoHbc2pt8cDK_E3zS7r897BYYl7MJFeQHrq7DD8cthncllY22nYFRMQgnQDt9axqzHb8Y06g_fe-hi4WwFJRfXgvpoCQPl4ZzLd9qdXk6z9P2UHqf9U5pAAA",
    "data:image/webp;base64,UklGRmoCAABXRUJQVlA4IF4CAABwDACdASoiADoAPu1iqU4ppaQiLVme2TAdiWkAE565bs_jiBHh7h1WBNE8kn1ihDQUWqXesvl7VQaVsa5Ff7dprKAVwahJEduRtz5xKepzAmkj6KixReF4MnGJBTM3u4UvRrsvDOc0v0btIFAA_vm_p_nUNoWYgf-I4ns7yFxMe88kWASQvjPov7-QZYicwxZPKjWDk_oxG9kGJZtvHTg3eM8Zhsa0SrZX4Om6FmWloWe1s5u6Gi6h-2fx6T9QFVuTqI6vPZtRmXHvy0f1XvmErb7JNAPqGrd6RmuGRYbpAFuZMcS-tqHYDy6MBND0KOXgUALrr_BAJWJNSx-E28f5sR3SoBEEs1YJeNpcJ2YBSHX4_LPiJEMh7cUXX6GalngeTujizVHh-7bguPHQDyA3wP6PLDvOf9D0_J4PBhory_BFoWQEODlyJ_9yV8h92UppT2HjFicpM5Ab0WNAUwr5reXovPgVrgN-94YLPzz414r05Jb4OllDnFGSWr8L370VTH4_tn4YeGnzh7VpqxVfiJZghgNCSJSsuv_bUlp2VeqzP_fTnd_vGH8jr5xdz7W-Ll72exRsACt752AtPv2dKXY3nn3j5n1ZR5IxP1x89O1heIJ2XmUQRPz7NTo0BRfNsIlYm-90l0_e6Af3MefJboBlPv-SQ8QsgPriHGA5IhzY2a6Ua84ulH8iJrLYhYpRnkC0LSfqWUWb6XBL8eD1FapI261ZjYfQOZeuRtIR-LmXeq6EKJRkZXdX7ress--YtR3PwKK-QVroULO5d14XvbzjemneQmv_u4MIAAA",
    "data:image/webp;base64,UklGRsgAAABXRUJQVlA4ILwAAADQBgCdASoiADoAPuVkpk4pJiOiMr27MSAciWcAzjhItUQX9az2m6NaowwUusjVAQA27_ZiRpqaE7ksKKUPjKAAhoN9mYk4Qs3BWanZiY7eCqr-_TASmHrzFZNORYoTt26tzqt5xj5hBZHFFfJHJgUNlUeBZYQ2vDWdHIV0Lda4Pg96HErqdbNWM7D9u1av0OhUbRR1m1a6RzCeLuWZeLzAwvv1j0Iffvqa1i6n5SlYWnCYzNR2eLy-LsIAAA==",
    "data:image/webp;base64,UklGRiwCAABXRUJQVlA4ICACAABwDACdASoiADoAPuVkpE4pJiOsNVgMAYAciUAYoXZRnPP_MJPoARixQBs67r0KbwmK9aM9Q_txqz2b5vKRjawY7fYy8sVA3n0yV1d3il-_FJ3L5LWwNM21q3cdiv48UjDVnS2_4HRajlzmOgAA_tz48w2xd7twXHq3-X_EekHthxTmdAnNv3Gli3KBmOt0ekgCxiPbHJOSfIzmG7ZKQiiboPkmci609uWDdpiwA6gdxigi_XtoXOLiCJogCUtGynFOvE6UG1DrRbJA-f1S4Wdfzq5S64vK-VU2_EGJ_Ao1jlFXhN6KNE5NcHAgDIvUOfWcfkT4ZyUHrbHZSv9v_vEaBFs-icMBYeW_LFIji0sgNQln3lmC0XV3ddqaYUtvR-EpAA8zllSGbYX_3GE2vVkt6W97L1z65atT8K0ppc8RkREpbJ2RbemDuVJ7Ru9JJVjN57UfXGdfd-FFUjkFo2c65cMp7CAuTVSlsVLR4B_o5cl896Fs6mG1pWWlIoqDvkqqRpsXK7UUED-DxaCIZqtCgAyMUTgBJ1lydM6FLqdNjtT65pFC8WYPpEa45wce8W6TLzuDwWucTpfJ0RyivQXW3S-h-aXWu62N5f9bvCX0YKHaS59j8fZLsUNepU3A16hgTJ78yR9s1Vlsj_baPFn8UnTPxxgoyEg0XC6S6gvTKEb3hXGZpXG4IB9Zf4vKefLvr210Hz0V_DvM_QuqgAAA",
  ];
  const decodeEmbedUri = (uri) => uri.replaceAll("_", "/").replaceAll("-", "+");

  function loadLocalImage(paths, onLoad) {
    const img = new Image();
    let idx = 0;
    img.onload = () => onLoad(img);
    img.onerror = () => {
      idx++;
      if (idx < paths.length) img.src = paths[idx];
    };
    img.src = paths[0];
  }

  // Boss: embedded image first (contest-safe, no file dependency).
  loadLocalImage([decodeEmbedUri(EMBED_BOSS)], (img) => {
    bossImg = makeEnemyPhotoSprite(img, false);
    bossImgHurt = makeEnemyPhotoSprite(img, true);
  });

  // Regular enemies: embedded mini portraits.
  for (let i = 0; i < EMBED_CROOKS.length; i++) {
    loadLocalImage([decodeEmbedUri(EMBED_CROOKS[i])], (img) => {
      crookVariants.push({
        normal: makeEnemyPhotoSprite(img, false),
        hurt: makeEnemyPhotoSprite(img, true),
      });
      // Use the first loaded crook as global fallback.
      if (crookVariants.length === 1) {
        enemyImg = crookVariants[0].normal;
        enemyImgHurt = crookVariants[0].hurt;
      }
    });
  }

  // ----------------- Overlays (scanlines + vignette) -----------------
  const overlays = (() => {
    const scan = document.createElement("canvas");
    scan.width = RW; scan.height = RH;
    const sg = scan.getContext("2d");
    sg.clearRect(0, 0, RW, RH);
    sg.fillStyle = "rgba(255,255,255,0.04)";
    for (let y = 0; y < RH; y += 3) sg.fillRect(0, y, RW, 1);

    const vig = document.createElement("canvas");
    vig.width = RW; vig.height = RH;
    const vg = vig.getContext("2d");
    const id = vg.createImageData(RW, RH);
    const d = id.data;

    const cx = RW * 0.5, cy = RH * 0.5;
    const invX = 1 / cx, invY = 1 / cy;

    for (let y = 0; y < RH; y++) {
      for (let x = 0; x < RW; x++) {
        const dx = (x - cx) * invX;
        const dy = (y - cy) * invY;
        const dist = Math.sqrt(dx * dx + dy * dy); // 0..~1.4
        let a = (dist - 0.25) / 0.85;
        a = clamp(a, 0, 1);
        a = a * a; // curve
        const alpha = (a * 200) | 0;

        const i = (y * RW + x) * 4;
        d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = alpha;
      }
    }
    vg.putImageData(id, 0, 0);

    return { scan, vig };
  })();

  // ----------------- Rays (precompute angles) -----------------
  const rCos = new Float32Array(RW);
  const rSin = new Float32Array(RW);
  const colFocus = new Float32Array(RW); // subtle “spotlight” in center
  for (let x = 0; x < RW; x++) {
    const t = ((x + 0.5) / RW - 0.5) * 2;       // -1..1
    const da = t * (FOV / 2);
    rCos[x] = Math.cos(da);
    rSin[x] = Math.sin(da);
    const u = 1 - Math.abs(t);
    colFocus[x] = 0.75 + 0.25 * u;             // 0.75..1.0
  }

  // ----------------- Impact sparks (screen-space) -----------------
  const sparks = [];
  const impactLights = [];
  let lastHorizon = RH >> 1;
  let threatLevel = 0;

  function spawnSparks(sx, sy, kind, power) {
    const n = kind === "blood" ? 16 : 12;
    const sp = kind === "blood" ? 90 : 110;
    const col = kind === "blood" ? [255, 80, 80] : [255, 220, 140];
    const pow = power || 1;

    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = (sp * (0.35 + 0.65 * Math.random())) * pow;
      sparks.push({
        x: sx + (Math.random() - 0.5) * 2,
        y: sy + (Math.random() - 0.5) * 2,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - (kind === "blood" ? 25 : 45),
        life: 0,
        dur: (kind === "blood" ? 220 : 180) + Math.random() * 120,
        r: col[0], g: col[1], b: col[2],
        s: 2,
      });
    }
  }

  function updateSparks(dt) {
    if (!sparks.length) return;
    const grav = 240;
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.life += dt * 1000;
      p.vy += grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= (1 - 0.8 * dt);
      p.vy *= (1 - 0.25 * dt);
      if (p.life >= p.dur || p.x < -10 || p.x > RW + 10 || p.y < -10 || p.y > RH + 10) sparks.splice(i, 1);
    }
  }

  function drawSparks() {
    if (!sparks.length) return;
    for (let i = 0; i < sparks.length; i++) {
      const p = sparks[i];
      const a = 1 - (p.life / p.dur);
      const alpha = clamp(a, 0, 1) * 0.85;
      g.fillStyle = `rgba(${p.r},${p.g},${p.b},${alpha})`;
      g.fillRect(p.x | 0, p.y | 0, p.s, p.s);
    }
  }

  function spawnImpactLight(sx, sy, kind) {
    const enemy = kind === "enemy";
    impactLights.push({
      x: sx,
      y: sy,
      life: 0,
      dur: enemy ? 140 : 95,
      r: enemy ? 255 : 255,
      g: enemy ? 86 : 215,
      b: enemy ? 86 : 145,
      rad: enemy ? 22 : 16,
    });
  }

  function updateImpactLights(dt) {
    if (!impactLights.length) return;
    for (let i = impactLights.length - 1; i >= 0; i--) {
      const l = impactLights[i];
      l.life += dt * 1000;
      if (l.life >= l.dur) impactLights.splice(i, 1);
    }
  }

  function drawImpactLights() {
    if (!impactLights.length) return;
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < impactLights.length; i++) {
      const l = impactLights[i];
      const t = 1 - l.life / l.dur;
      const a = clamp(t, 0, 1);
      const rad = l.rad * (0.65 + 0.55 * (1 - t));

      g.fillStyle = `rgba(${l.r},${l.g},${l.b},${0.18 * a})`;
      g.fillRect((l.x - rad) | 0, (l.y - rad) | 0, (rad * 2) | 0, (rad * 2) | 0);
      g.fillStyle = `rgba(255,255,255,${0.26 * a})`;
      g.fillRect((l.x - 3) | 0, (l.y - 3) | 0, 6, 6);
    }
    g.globalCompositeOperation = "source-over";
  }

  // ----------------- Game state -----------------
  let state = "menu";
  const player = { x: 1.5, y: 1.5, a: 0, hp: 100, bob: 0, recoil: 0, hurt: 0, dizzy: 0, blind: 0 };
  let kills = 0, wave = 1;
  let runClock = 0;
  let finalStartClock = -1;
  let finalScore = 0;
  const LEADER_KEY = "cave_snake_leaderboard_v1";
  const LEADER_MAX = 5;
  let leaderboard = [];
  let killsGoal = 10;
  let floorIndex = 0;
  let goalUnlocked = false;
  let machineUnlocked = false;
  let note = "", noteT = 0;

  const enemies = [];
  let med = { x: 0, y: 0, t: 0 };
  let mgPickup = { x: 0, y: 0, t: 0, active: false };
  let exitGate = { x: 0, y: 0, open: false, pulse: 0 };
  let stairs = { x: 0, y: 0, active: false, pulse: 0 };
  let boss = { x: 0, y: 0, ax: 0, ay: 0, hp: 0, max: 0, alive: false, hurt: 0, t: 0, cast: 0, volley: 1 };
  const fireballs = [];
  let jumpscareT = 0;
  let jumpscareCd = 0;

  let shootCd = 0;
  let flash = 0;
  let hitMark = 0;
  let shake = 0;
  let weaponIndex = 0;

  function setWeapon(i) {
    if (!machineUnlocked && i > 0) {
      setNote("MACHINE GUN IS ON FLOOR 2", 1.3);
      return;
    }
    const next = clamp(i | 0, 0, WEAPONS.length - 1);
    if (weaponIndex === next) return;
    weaponIndex = next;
    audio.click();
    setNote(`${WEAPONS[weaponIndex].name} READY`, 1.2);
  }

  function startGame() {
    if (state !== "menu" && state !== "intro") return;
    audio.click();
    reset();
    state = "play";
  }

  function setNote(text, sec) {
    note = text || "";
    noteT = sec || 0;
  }

  function formatTime(sec) {
    const t = Math.max(0, isFinite(sec) ? sec : 0);
    const m = (t / 60) | 0;
    const s = t - m * 60;
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(2);
  }

  function loadLeaderboard() {
    leaderboard.length = 0;
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (let i = 0; i < arr.length; i++) {
        const v = +arr[i];
        if (isFinite(v) && v > 0 && v < 36000) leaderboard.push(v);
      }
      leaderboard.sort((a, b) => a - b);
      if (leaderboard.length > LEADER_MAX) leaderboard.length = LEADER_MAX;
    } catch (_) { }
  }

  function saveLeaderboard() {
    try {
      localStorage.setItem(LEADER_KEY, JSON.stringify(leaderboard.slice(0, LEADER_MAX)));
    } catch (_) { }
  }

  function pushLeaderboard(sec) {
    const v = +sec;
    if (!isFinite(v) || v <= 0) return;
    leaderboard.push(v);
    leaderboard.sort((a, b) => a - b);
    if (leaderboard.length > LEADER_MAX) leaderboard.length = LEADER_MAX;
    saveLeaderboard();
  }

  loadLeaderboard();

  function findExit(px, py) {
    const sx = px | 0, sy = py | 0;
    const n = MW * MH;
    const seen = new Uint8Array(n);
    const qx = new Int16Array(n);
    const qy = new Int16Array(n);
    let qh = 0, qt = 0;

    if (cellAt(sx + 0.5, sy + 0.5) !== 0) return { x: 1.5, y: 1.5 };
    seen[sy * MW + sx] = 1;
    qx[qt] = sx; qy[qt] = sy; qt++;

    let bestX = sx, bestY = sy, bestD = -1;

    while (qh < qt) {
      const x = qx[qh], y = qy[qh]; qh++;
      const cx = x + 0.5, cy = y + 0.5;

      if (canStand(cx, cy, PLAYER_R)) {
        const dx = cx - px, dy = cy - py;
        const d2 = dx * dx + dy * dy;
        if (d2 > bestD) {
          bestD = d2;
          bestX = x;
          bestY = y;
        }
      }

      if (x > 0) {
        const i = y * MW + (x - 1);
        if (!seen[i] && grid[i] === 0) { seen[i] = 1; qx[qt] = x - 1; qy[qt] = y; qt++; }
      }
      if (x + 1 < MW) {
        const i = y * MW + (x + 1);
        if (!seen[i] && grid[i] === 0) { seen[i] = 1; qx[qt] = x + 1; qy[qt] = y; qt++; }
      }
      if (y > 0) {
        const i = (y - 1) * MW + x;
        if (!seen[i] && grid[i] === 0) { seen[i] = 1; qx[qt] = x; qy[qt] = y - 1; qt++; }
      }
      if (y + 1 < MH) {
        const i = (y + 1) * MW + x;
        if (!seen[i] && grid[i] === 0) { seen[i] = 1; qx[qt] = x; qy[qt] = y + 1; qt++; }
      }
    }

    return { x: bestX + 0.5, y: bestY + 0.5 };
  }

  function carveBossRoom(cx, cy) {
    const ix = cx | 0, iy = cy | 0;
    const t = floorWallType || 1;

    // 7x7 room.
    for (let y = iy - 3; y <= iy + 3; y++) {
      if (y <= 1 || y >= MH - 2) continue;
      for (let x = ix - 3; x <= ix + 3; x++) {
        if (x <= 1 || x >= MW - 2) continue;
        grid[y * MW + x] = 0;
      }
    }

    // Four dodge pillars.
    const pillars = [
      [ix - 2, iy - 2],
      [ix + 2, iy - 2],
      [ix - 2, iy + 2],
      [ix + 2, iy + 2],
    ];
    for (let i = 0; i < pillars.length; i++) {
      const x = pillars[i][0], y = pillars[i][1];
      if (x > 1 && x < MW - 2 && y > 1 && y < MH - 2) grid[y * MW + x] = t;
    }

    if (ix > 0 && ix < MW && iy > 0 && iy < MH) grid[iy * MW + ix] = 0;
  }

  function spawnBoss(x, y) {
    boss.alive = true;
    boss.ax = x; boss.ay = y;
    boss.x = x; boss.y = y;
    boss.max = BOSS_HP;
    boss.hp = BOSS_HP;
    boss.hurt = 0;
    boss.t = 0;
    boss.cast = 0;
    boss.volley = 1;
    boss.spr = bossImg;
    boss.sprHurt = bossImgHurt;
    jumpscareT = 0;
    jumpscareCd = 0.9;
  }

  function throwFireball(angleOff) {
    const dx = player.x - boss.x, dy = player.y - boss.y;
    const d = hypot(dx, dy) || 1;
    const nx = dx / d, ny = dy / d;

    const c = Math.cos(angleOff), s = Math.sin(angleOff);
    const vx = nx * c - ny * s;
    const vy = nx * s + ny * c;

    const enraged = boss.hp <= boss.max * 0.5;
    const sp = FIRE_SPEED + (enraged ? 0.35 : 0);
    const launch = BOSS_R + 0.18;

    fireballs.push({
      x: boss.x + vx * launch,
      y: boss.y + vy * launch,
      vx: vx * sp,
      vy: vy * sp,
      life: 0,
      dur: 4.2,
      r: FIRE_R,
      dmg: FIRE_DMG,
      sx: RW >> 1,
      sy: lastHorizon,
    });
  }

  function tryBossTeleportBehindPlayer() {
    if (!boss.alive) return false;
    const fx = Math.cos(player.a), fy = Math.sin(player.a);
    const rx = -fy, ry = fx;
    const base = BOSS_R + PLAYER_R + 0.40;
    const dists = [base + 0.28, base, Math.max(0.8, base - 0.22), base + 0.52];
    const offs = [0, 0.52, -0.52, 1.0, -1.0, 1.45, -1.45];
    const minD2 = (BOSS_R + PLAYER_R + 0.05) * (BOSS_R + PLAYER_R + 0.05);

    for (let di = 0; di < dists.length; di++) {
      const dist = dists[di];
      for (let oi = 0; oi < offs.length; oi++) {
        const off = offs[oi];
        const nx = player.x - fx * dist + rx * off;
        const ny = player.y - fy * dist + ry * off;
        const dx = nx - player.x, dy = ny - player.y;
        if (dx * dx + dy * dy < minD2) continue;
        if (!canStand(nx, ny, BOSS_R)) continue;
        boss.x = nx;
        boss.y = ny;
        boss.ax = boss.ax * 0.55 + nx * 0.45;
        boss.ay = boss.ay * 0.55 + ny * 0.45;
        return true;
      }
    }
    return false;
  }

  function canPlayerSeeBoss(dist, dx, dy) {
    if (dist <= 0.0001) return true;
    const rel = Math.abs(normAng(Math.atan2(dy, dx) - player.a));
    if (rel > FOV * 0.55) return false;
    const invD = 1 / dist;
    const ray = castFrom(player.x, player.y, dx * invD, dy * invD);
    return ray.d + 0.04 >= dist - BOSS_R;
  }

  function updateBoss(dt) {
    if (!boss.alive) return;
    boss.spr = bossImg;
    boss.sprHurt = bossImgHurt;
    if (fireballs.length) fireballs.length = 0;

    boss.t += dt;
    if (boss.hurt > 0) boss.hurt = Math.max(0, boss.hurt - dt);

    const dxp = player.x - boss.x, dyp = player.y - boss.y;
    const d = hypot(dxp, dyp) || 1;
    const px = dxp / d, py = dyp / d;

    const side = Math.sin(boss.t * 0.9) > 0 ? 1 : -1;
    const tx = boss.ax + (-py) * 0.85 * side;
    const ty = boss.ay + (px) * 0.85 * side;

    const mvx = tx - boss.x, mvy = ty - boss.y;
    const ml = hypot(mvx, mvy) || 1;
    moveCircle(boss, (mvx / ml) * 0.55 * dt, (mvy / ml) * 0.55 * dt, BOSS_R);
    nudgeOut(boss, BOSS_R);
    boss.cast = 0;

    // Proximity aura: wide-range blindness that ramps up through the fight.
    const bdX = boss.x - player.x;
    const bdY = boss.y - player.y;
    const bd = hypot(bdX, bdY);
    if (bd < BOSS_BLIND_R) {
      const distT = 1 - clamp(bd / BOSS_BLIND_R, 0, 1); // 0..1
      const rage = 1 - clamp(boss.hp / (boss.max || 1), 0, 1); // 0..1 as boss gets hurt
      const gain = dt * BOSS_BLIND_GAIN * (0.50 + 0.75 * distT) * (0.90 + 0.95 * rage);
      player.blind = Math.min(1, player.blind + gain);
      if (distT > 0.50) {
        const dz = dt * (0.16 + 0.18 * rage) * ((distT - 0.50) / 0.50);
        player.dizzy = Math.min(1, player.dizzy + dz);
      }
    }

    // Telepathic pressure (no HP damage): visual stress while inside aura.
    if (bd < BOSS_MIND_R) {
      const farT = clamp(bd / BOSS_MIND_R, 0, 1); // 0 near boss, 1 near edge of aura
      const rage = 1 - clamp(boss.hp / (boss.max || 1), 0, 1);
      const press = (0.25 + 1.05 * farT * farT) * (0.80 + 0.90 * rage);
      player.hurt = Math.min(0.35, player.hurt + dt * (0.05 + 0.08 * press));
      shake = Math.max(shake, 0.04 + 0.05 * farT);
    }

    // Jumpscare trigger: frequent enough to feel threatening when boss is near.
    jumpscareCd -= dt;
    if (jumpscareCd <= 0 && bd < BOSS_JUMPSCARE_RANGE && canPlayerSeeBoss(bd, bdX, bdY)) {
      const rage = 1 - clamp(boss.hp / (boss.max || 1), 0, 1);
      const nearT = 1 - clamp(bd / BOSS_JUMPSCARE_RANGE, 0, 1);
      jumpscareCd = BOSS_JUMPSCARE_CD * (0.72 - 0.30 * nearT) * (1 - 0.35 * rage);
      jumpscareT = BOSS_JUMPSCARE_DUR;
      const closeT = nearT * nearT;
      const dmg = 6 + 22 * closeT + 5 * nearT + 4 * rage;
      player.hp -= dmg;
      player.hurt = Math.min(0.55, player.hurt + 0.26 + 0.20 * nearT);
      player.dizzy = Math.min(1, player.dizzy + 0.46);
      player.blind = Math.min(1, player.blind + 0.30);
      shake = Math.max(shake, 0.30 + 0.16 * nearT);
      audio.hurt();
      audio.jumpscare();
    }
  }

  function updateFireballs(dt) {
    if (!fireballs.length) return;

    for (let i = fireballs.length - 1; i >= 0; i--) {
      const f = fireballs[i];
      f.life += dt;

      const steps = Math.max(1, Math.ceil(hypot(f.vx, f.vy) * dt / 0.08));
      const sdt = dt / steps;
      let remove = false;

      for (let s = 0; s < steps; s++) {
        const nx = f.x + f.vx * sdt;
        const ny = f.y + f.vy * sdt;

        if (!canStand(nx, ny, f.r)) {
          spawnSparks(f.sx || (RW >> 1), f.sy || lastHorizon, "wall", 0.9);
          spawnImpactLight(f.sx || (RW >> 1), f.sy || lastHorizon, "wall");
          remove = true;
          break;
        }

        f.x = nx;
        f.y = ny;

        const dx = f.x - player.x, dy = f.y - player.y;
        const rr = PLAYER_R + f.r;
        if (dx * dx + dy * dy >= rr * rr) continue;

        player.hp -= f.dmg;
        player.hurt = Math.min(0.35, player.hurt + 0.28);
        player.dizzy = Math.min(1, player.dizzy + 0.55);
        player.blind = Math.min(1, player.blind + 0.50);
        shake = Math.max(shake, 0.16);
        audio.hurt();

        spawnSparks(f.sx || (RW >> 1), f.sy || lastHorizon, "blood", 1.2);
        spawnImpactLight(f.sx || (RW >> 1), f.sy || lastHorizon, "enemy");
        remove = true;
        break;
      }

      if (remove || f.life >= f.dur) fireballs.splice(i, 1);
    }
  }

  function enterFloor(idx) {
    floorIndex = clamp(idx | 0, 0, FLOOR_COUNT - 1);
    audio.musicForFloor(floorIndex);
    floorWallType = 1 + (floorIndex % 3);
    loadMap(generateMapLines());
    fireballs.length = 0;
    boss.alive = false;
    jumpscareT = 0;
    jumpscareCd = 0;

    const sp = findSpawn();
    player.x = sp.x; player.y = sp.y; player.a = 0;
    player.bob = 0; player.recoil = 0; player.hurt = 0; player.dizzy = 0; player.blind = 0;

    // Pick a far reachable spot (guaranteed reachable)
    const far = findExit(player.x, player.y);

    // Reset objectives
    stairs.active = floorIndex < FLOOR_COUNT - 1;
    stairs.pulse = 0;
    exitGate.pulse = 0;

    if (stairs.active) {
      // Floors 1..(N-1): stairs exist, exit disabled
      stairs.x = far.x; stairs.y = far.y;
      exitGate.x = 0; exitGate.y = 0; exitGate.open = false;
      setNote(`FLOOR ${floorIndex + 1}/${FLOOR_COUNT} - FIND STAIRS`, 2.6);
    } else {
      // Top floor: exit exists, stairs disabled
      if (finalStartClock < 0) finalStartClock = runClock;
      stairs.x = 0; stairs.y = 0;
      exitGate.x = far.x; exitGate.y = far.y;
      exitGate.open = false;
      carveBossRoom(exitGate.x, exitGate.y);
      spawnBoss(exitGate.x, exitGate.y);
      setNote("FINAL FLOOR - DEFEAT THE BOSS", 2.8);
    }

    shootCd = 0;
    flash = 0;
    hitMark = 0;
    shake = 0;

    enemies.length = 0;
    const startEnemies = (floorIndex === FLOOR_COUNT - 1)
      ? 5
      : (BASE_ENEMIES + floorIndex * 2);
    for (let i = 0; i < startEnemies; i++) spawnEnemy();

    spawnMedkit();

    mgPickup.active = false;
    mgPickup.t = 0;
    mgPickup.x = 0;
    mgPickup.y = 0;
    if (!machineUnlocked && floorIndex === 1) {
      spawnMachineGunPickup(stairs.x || player.x, stairs.y || player.y);
      setNote("FLOOR 2 - MACHINE GUN OPTIONAL", 2.4);
    }

    if (!machineUnlocked) weaponIndex = 0;
  }

  function reset() {
    state = "play";
    player.hp = 100;

    kills = 0;
    wave = 1;
    runClock = 0;
    finalStartClock = -1;
    finalScore = 0;
    floorIndex = 0;
    goalUnlocked = false;
    machineUnlocked = false;
    weaponIndex = 0;
    killsGoal = 10;
    sparks.length = 0;
    impactLights.length = 0;
    fireballs.length = 0;
    boss.alive = false;
    jumpscareT = 0;
    jumpscareCd = 0;

    enterFloor(0);
  }

  function spawnMedkit() {
    for (let tries = 0; tries < 400; tries++) {
      const x = rand(1.5, MW - 1.5);
      const y = rand(1.5, MH - 1.5);
      if (isWall(x, y)) continue;
      const dx = x - player.x, dy = y - player.y;
      if (dx * dx + dy * dy < 5) continue;
      med.x = x; med.y = y; med.t = 0;
      return;
    }
    med.x = 0; med.y = 0;
  }

  function spawnMachineGunPickup(avoidX, avoidY) {
    mgPickup.active = false;
    mgPickup.t = 0;
    mgPickup.x = 0;
    mgPickup.y = 0;

    for (let tries = 0; tries < 500; tries++) {
      const x = rand(1.5, MW - 1.5);
      const y = rand(1.5, MH - 1.5);
      if (!canStand(x, y, PLAYER_R)) continue;

      const dpX = x - player.x, dpY = y - player.y;
      if (dpX * dpX + dpY * dpY < 12) continue;

      const daX = x - avoidX, daY = y - avoidY;
      if (daX * daX + daY * daY < 8) continue;

      mgPickup.x = x;
      mgPickup.y = y;
      mgPickup.active = true;
      return;
    }

    // Guaranteed fallback so progression cannot soft-lock.
    const fb = findExit(player.x, player.y);
    mgPickup.x = fb.x;
    mgPickup.y = fb.y;
    mgPickup.active = true;
  }

  function spawnEnemy() {
    for (let tries = 0; tries < 250; tries++) {
      const x = rand(1.5, MW - 1.5);
      const y = rand(1.5, MH - 1.5);
      if (!canStand(x, y, ENEMY_R)) continue;
      const dx = x - player.x, dy = y - player.y;
      if (dx * dx + dy * dy < 9) continue;
      const v = crookVariants.length ? crookVariants[(Math.random() * crookVariants.length) | 0] : null;

      const type = Math.random() < 0.25 + 0.02 * (wave - 1) ? 1 : 0; // 1=tank
      enemies.push({
        x, y,
        hp: type ? 4 : 2,
        type,
        t: rand(0, 10),
        hurt: 0,
        pathT: 0,
        pathGoal: -1,
        tx: x,
        ty: y,
        spr: v ? v.normal : enemyImg,
        sprHurt: v ? v.hurt : enemyImgHurt,
      });
      return;
    }
  }

  // ----------------- Raycast (DDA) -----------------
  function castFrom(px, py, dx, dy) {
    let mapX = px | 0;
    let mapY = py | 0;

    const invDx = dx !== 0 ? 1 / dx : 1e9;
    const invDy = dy !== 0 ? 1 / dy : 1e9;

    const deltaX = Math.abs(invDx);
    const deltaY = Math.abs(invDy);

    let stepX, stepY, sideX, sideY;

    if (dx < 0) { stepX = -1; sideX = (px - mapX) * deltaX; }
    else { stepX = 1; sideX = (mapX + 1 - px) * deltaX; }

    if (dy < 0) { stepY = -1; sideY = (py - mapY) * deltaY; }
    else { stepY = 1; sideY = (mapY + 1 - py) * deltaY; }

    let side = 0;
    for (let i = 0; i < MAX_RAY_STEPS; i++) {
      if (sideX < sideY) { sideX += deltaX; mapX += stepX; side = 0; }
      else { sideY += deltaY; mapY += stepY; side = 1; }

      if (mapX < 0 || mapY < 0 || mapX >= MW || mapY >= MH) break;

      const t = grid[mapY * MW + mapX];
      if (t) {
        const dist = side === 0
          ? (mapX - px + (1 - stepX) * 0.5) * invDx
          : (mapY - py + (1 - stepY) * 0.5) * invDy;

        const d = Math.max(0.0001, dist);

        const hx = px + d * dx;
        const hy = py + d * dy;
        let u = side === 0 ? (hy - (hy | 0)) : (hx - (hx | 0));
        if (u < 0) u += 1;

        return { d, side, u, t };
      }
    }
    return { d: 999, side: 0, u: 0, t: 1 };
  }

  // ----------------- Shooting (hitscan) -----------------
  function shoot() {
    if (state !== "play") return;
    if (shootCd > 0) return;

    const wpn = WEAPONS[weaponIndex];
    audio.userGesture();
    audio.shoot(wpn.snd);

    shootCd = wpn.cd;
    flash = wpn.flash;
    hitMark = 0;
    player.recoil = Math.min(wpn.recoilMax, player.recoil + wpn.recoilAdd);
    shake = Math.max(shake, 0.10);
    const sx = RW >> 1;
    const sy = lastHorizon;

    const ra = player.a + (Math.random() * 2 - 1) * wpn.spread + player.recoil * (wpn.auto ? 0.03 : 0.01);
    const rdx = Math.cos(ra), rdy = Math.sin(ra);

    const wallDist = castFrom(player.x, player.y, rdx, rdy).d;

    let bestI = -1;
    let bestD = 1e9;

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const fx = e.x - player.x, fy = e.y - player.y;
      const t = fx * rdx + fy * rdy;
      if (t <= 0) continue;

      const d2 = (fx * fx + fy * fy) - t * t;
      if (d2 > ENEMY_R * ENEMY_R) continue;

      const thc = Math.sqrt(Math.max(0, ENEMY_R * ENEMY_R - d2));
      const hitD = t - thc;
      if (hitD > 0 && hitD < bestD) {
        bestD = hitD;
        bestI = i;
      }
    }

    let hitBoss = false;
    let bossHitD = 1e9;

    if (boss.alive) {
      const fx = boss.x - player.x, fy = boss.y - player.y;
      const t = fx * rdx + fy * rdy;
      if (t > 0) {
        const d2 = (fx * fx + fy * fy) - t * t;
        if (d2 <= BOSS_R * BOSS_R) {
          const thc = Math.sqrt(Math.max(0, BOSS_R * BOSS_R - d2));
          bossHitD = t - thc;
          if (bossHitD > 0) hitBoss = true;
        }
      }
    }

    const bossWins = hitBoss && bossHitD < bestD;
    if ((bossWins ? bossHitD : bestD) < wallDist) {
      if (bossWins) {
        boss.hp -= 1;
        boss.hurt = 0.22;
        hitMark = 0.18;
        spawnSparks(sx + (Math.random() - 0.5) * 5, sy + (Math.random() - 0.5) * 5, "blood", 1.2);
        spawnImpactLight(sx, sy, "enemy");
        audio.hit();

        if (boss.hp <= 0) {
          boss.alive = false;
          exitGate.open = true;
          setNote("BOSS DOWN - EXIT OPEN", 3.0);
          audio.kill();
          shake = Math.max(shake, 0.18);
        } else {
          tryBossTeleportBehindPlayer();
          const rage = 1 - clamp(boss.hp / (boss.max || 1), 0, 1);
          if (floorIndex === FLOOR_COUNT - 1 && rage >= 0.38) {
            const reinfCap = 8 + ((rage * 24) | 0);
            let burst = 2 + ((rage * 7) | 0);
            if (rage > 0.7) burst += 2;
            while (burst-- > 0 && enemies.length < reinfCap) spawnEnemy();
            setNote("BOSS RAGE - CROOK SWARM!", 1.1);
          }
        }
      } else if (bestI >= 0) {
        const e = enemies[bestI];
        e.hp -= 1;
        e.hurt = 0.18;
        hitMark = 0.14;

        audio.hit();
        moveCircle(e, rdx * wpn.knock, rdy * wpn.knock, ENEMY_R);
        nudgeOut(e, ENEMY_R);
        spawnSparks(sx + (Math.random() - 0.5) * 4, sy + (Math.random() - 0.5) * 4, "blood", 1);
        spawnImpactLight(sx, sy, "enemy");

        if (e.hp <= 0) {
          enemies.splice(bestI, 1);
          kills++;
          hitMark = 0.22;
          audio.kill();
          shake = Math.max(shake, 0.12);

          if (!goalUnlocked && kills >= killsGoal) {
            goalUnlocked = true;
            if (floorIndex === FLOOR_COUNT - 1) {
              if (!boss.alive) {
                exitGate.open = true;
                setNote("EXIT OPEN - REACH THE PORTAL", 3.0);
              } else {
                setNote("BOSS GUARDS THE EXIT", 2.2);
              }
            } else {
              setNote(`GO TO FLOOR ${FLOOR_COUNT} - EXIT UNLOCKED`, 3.0);
            }
            audio.pickup();
          }

          const bossRage = (floorIndex === FLOOR_COUNT - 1 && boss.alive)
            ? (1 - clamp(boss.hp / (boss.max || 1), 0, 1))
            : 0;
          const spawnCap = (floorIndex === FLOOR_COUNT - 1)
            ? (boss.alive
              // Final floor pressure ramps hard as boss takes damage.
              ? (3 + ((bossRage * 18) | 0))
              : 2)
            : (BASE_ENEMIES + 3 + floorIndex * 3 + (wave >> 1));

          let spawnBurst = 2;
          if (floorIndex === FLOOR_COUNT - 1 && boss.alive) {
            spawnBurst += 1 + ((bossRage * 3) | 0); // 2..5 spawns as rage rises
            if (kills > 0 && (kills % 4) === 0) spawnBurst += 1 + ((bossRage * 2) | 0);
          }
          if (kills > 0 && (kills % 4) === 0) {
            wave++;
            spawnBurst++;
          } else if ((floorIndex !== FLOOR_COUNT - 1) && kills > 0 && (kills % 3) === 0) {
            spawnBurst++;
          }
          while (spawnBurst-- > 0 && enemies.length < spawnCap) spawnEnemy();
        }
      }
    } else {
      spawnSparks(sx + (Math.random() - 0.5) * 6, sy + (Math.random() - 0.5) * 6, "wall", 1);
    }
  }

  // ----------------- Movement + collision -----------------
  function movePlayer(dt) {
    const mouseTurn = 0.0026;
    const keyTurn = 2.4;

    player.a += mouseDX * mouseTurn;
    const turnL = (keys["arrowleft"] || keys["q"]) ? 1 : 0;
    const turnR = (keys["arrowright"] || keys["e"]) ? 1 : 0;
    player.a += (turnR - turnL) * keyTurn * dt;
    mouseDX = 0;

    if (player.a > Math.PI) player.a -= Math.PI * 2;
    if (player.a < -Math.PI) player.a += Math.PI * 2;

    const fwd = (keys["w"] || keys["arrowup"]) ? 1 : 0;
    const back = (keys["s"] || keys["arrowdown"]) ? 1 : 0;
    const left = keys["a"] ? 1 : 0;
    const right = keys["d"] ? 1 : 0;

    let vx = 0, vy = 0;
    const ca = Math.cos(player.a), sa = Math.sin(player.a);

    const speed = keys["shift"] ? 3.6 : 2.7;

    vx += (fwd - back) * ca;
    vy += (fwd - back) * sa;

    vx += (left - right) * sa;
    vy += (right - left) * ca;

    const len = hypot(vx, vy);
    let moving = false;
    if (len > 0) { vx /= len; vy /= len; moving = true; }

    const oldX = player.x, oldY = player.y;
    const moveX = vx * speed * dt;
    const moveY = vy * speed * dt;
    moveCircle(player, moveX, moveY, PLAYER_R);
    nudgeOut(player, PLAYER_R);

    const moved = hypot(player.x - oldX, player.y - oldY) > 0.0004;
    if (moving && moved) {
      const sprint = keys["shift"] ? 1 : 0.72;
      player.bob += dt * (keys["shift"] ? 10 : 7);
      audio.footstep(sprint, dt);
    } else {
      player.bob *= Math.max(0, 1 - dt * 10);
      audio.footstep(0, dt);
    }
  }

  // ----------------- Enemies + pickup -----------------
  function updateEnemies(dt) {
    // separation
    for (let i = 0; i < enemies.length; i++) {
      const a = enemies[i];
      for (let j = i + 1; j < enemies.length; j++) {
        const b = enemies[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        const min = (ENEMY_R * 2) * (ENEMY_R * 2);
        if (d2 > 0.0001 && d2 < min) {
          const d = Math.sqrt(d2);
          const push = (ENEMY_R * 2 - d) * 0.18;
          const nx = dx / d, ny = dy / d;
          moveCircle(a, -nx * push, -ny * push, ENEMY_R);
          moveCircle(b, nx * push, ny * push, ENEMY_R);
        }
      }
    }

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      e.t += dt;
      if (e.hurt > 0) e.hurt -= dt;

      const dx = player.x - e.x;
      const dy = player.y - e.y;
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2);

      // attack
      if (d < 0.72) {
        const dmg = (e.type ? 26 : 18) * dt;
        player.hp -= dmg;
        player.hurt = Math.min(0.35, player.hurt + dt * 1.4);
        shake = Math.max(shake, 0.14);
        audio.hurt();
        continue;
      }

      // Only pathfind once player is near enough to be detected.
      if (d2 > ENEMY_DETECT_R * ENEMY_DETECT_R) {
        e.pathGoal = -1;
        e.pathT = 0;
        e.tx = e.x;
        e.ty = e.y;
        continue;
      }

      // A* path step toward player (recomputed in short intervals or when target cell changes)
      const ex = e.x | 0, ey = e.y | 0;
      const pxc = player.x | 0, pyc = player.y | 0;
      const goalId = pyc * MW + pxc;
      e.pathT -= dt;

      const tdX = e.tx - e.x;
      const tdY = e.ty - e.y;
      const nearTarget = (tdX * tdX + tdY * tdY) < 0.06 * 0.06;
      if (e.pathT <= 0 || e.pathGoal !== goalId || nearTarget) {
        const step = aStarNextStep(ex, ey, pxc, pyc);
        if (step) { e.tx = step.x; e.ty = step.y; }
        else { e.tx = player.x; e.ty = player.y; }
        e.pathGoal = goalId;
        e.pathT = 0.18 + Math.random() * 0.06;
      }

      let vx = e.tx - e.x;
      let vy = e.ty - e.y;
      const vl = hypot(vx, vy) || 1;
      vx /= vl; vy /= vl;

      const wob = Math.sin(e.t * (e.type ? 2.2 : 3.7)) * (e.type ? 0.05 : 0.08);
      const c = Math.cos(wob), s = Math.sin(wob);
      const mvx = vx * c - vy * s;
      const mvy = vx * s + vy * c;

      const sp = (e.type ? 0.95 : 1.35) + 0.02 * (wave - 1);
      const moved = moveCircle(e, mvx * sp * dt, mvy * sp * dt, ENEMY_R);
      if (!moved) e.pathT = 0; // force fresh A* on next frame

      nudgeOut(e, ENEMY_R);
    }
  }

  function updatePickup(dt) {
    if (med.x !== 0) {
      med.t += dt;

      const dx = med.x - player.x, dy = med.y - player.y;
      if (dx * dx + dy * dy < 0.45 * 0.45) {
        player.hp = Math.min(100, player.hp + 45);
        audio.pickup();
        spawnMedkit();
      }
    }

    if (mgPickup.active) {
      mgPickup.t += dt;
      const dx = mgPickup.x - player.x, dy = mgPickup.y - player.y;
      if (dx * dx + dy * dy < 0.45 * 0.45) {
        mgPickup.active = false;
        machineUnlocked = true;
        setWeapon(1);
        setNote("MACHINE GUN ACQUIRED", 2.0);
        flash = Math.max(flash, 0.12);
        shake = Math.max(shake, 0.14);
        audio.pickup();
      }
    }
  }

  function updateExit(dt) {
    exitGate.pulse += dt;
    stairs.pulse += dt;

    // Stairs: go to next floor
    if (stairs.active) {
      const dx = stairs.x - player.x, dy = stairs.y - player.y;
      if (dx * dx + dy * dy < 0.52 * 0.52) {
        audio.pickup();
        shake = Math.max(shake, 0.12);
        enterFloor(floorIndex + 1);
        return;
      }
    }

    // Exit: only on top floor and only when open
    if (floorIndex === FLOOR_COUNT - 1 && exitGate.x !== 0) {
      if (exitGate.open) {
        const dx = exitGate.x - player.x, dy = exitGate.y - player.y;
        if (dx * dx + dy * dy < 0.52 * 0.52) {
          state = "won";
          audio.stopMusic();
          finalScore = finalStartClock >= 0 ? Math.max(0, runClock - finalStartClock) : runClock;
          pushLeaderboard(finalScore);
          setNote("YOU ESCAPED", 2.2);
          shake = Math.max(shake, 0.16);
          audio.pickup();
        }
      }
    }
  }

  // ----------------- Rendering (pixel framebuffer) -----------------
  const img = g.createImageData(RW, RH);
  const px = new Uint32Array(img.data.buffer);
  const zbuf = new Float32Array(RW);

  function normAng(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function wallShade(dist, side, colMul) {
    let s = (1 / (1 + dist * dist * 0.14)) * (SH - 1);
    if (side) s *= 0.72;
    s *= colMul;
    return clamp(s | 0, 0, SH - 1);
  }

  function floorShade(dist) {
    let s = (1 / (1 + dist * dist * 0.10)) * (SH - 1);
    return clamp(s | 0, 0, SH - 1);
  }

  function getObjective() {
    if (state !== "play") return null;

    if (boss.alive) {
      return { x: boss.x, y: boss.y, label: "BOSS", col: "rgba(255,80,80,0.95)" };
    }
    if (stairs.active) {
      return { x: stairs.x, y: stairs.y, label: "STAIRS", col: "rgba(255,205,90,0.95)" };
    }
    if (mgPickup.active) {
      return { x: mgPickup.x, y: mgPickup.y, label: "MACHINE GUN", col: "rgba(255,170,90,0.95)" };
    }
    if (exitGate.x !== 0) {
      return {
        x: exitGate.x,
        y: exitGate.y,
        label: exitGate.open ? "EXIT" : "EXIT (LOCKED)",
        col: exitGate.open ? "rgba(110,240,255,0.95)" : "rgba(180,80,80,0.95)",
      };
    }
    return null;
  }

  // Draw a big arrow at the top that slides left/right based on direction.
  // If objective is outside FOV, it clamps to the edge and points inward.
  function drawObjectiveArrow() {
    const o = getObjective();
    if (!o) return;

    const dx = o.x - player.x, dy = o.y - player.y;
    const rel = normAng(Math.atan2(dy, dx) - player.a);

    const edge = Math.abs(rel) > FOV * 0.45;
    const a = clamp(rel, -FOV * 0.45, FOV * 0.45);

    let ax = (RW / 2 + Math.tan(a) * PROJ) | 0;
    ax = clamp(ax, 14, RW - 14);

    const ay = 44;

    // arrow
    g.fillStyle = o.col;
    g.beginPath();
    if (edge) {
      if (rel < 0) { // left
        g.moveTo(10, ay);
        g.lineTo(22, ay - 7);
        g.lineTo(22, ay + 7);
      } else { // right
        g.moveTo(RW - 10, ay);
        g.lineTo(RW - 22, ay - 7);
        g.lineTo(RW - 22, ay + 7);
      }
    } else {
      g.moveTo(ax, ay - 8);
      g.lineTo(ax - 8, ay + 8);
      g.lineTo(ax + 8, ay + 8);
    }
    g.closePath();
    g.fill();
  }

  function drawEnemySprites(list, horizon) {
    if (!enemyImgReady || !list || list.length === 0) return;

    g.imageSmoothingEnabled = true;

    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const dist = it.dist;
      const size = it.size;
      const x0 = it.x0;

      const hh = clamp((size * 1.22) | 0, 6, (RH * 1.8) | 0);
      const yy = (horizon - (hh >> 1)) | 0;

      const shade = floorShade(dist);
      const vis = 0.25 + 0.75 * (shade / (SH - 1));
      g.globalAlpha = clamp(vis, 0.2, 1);

      const baseSpr = (it.e && it.e.spr) ? it.e.spr : enemyImg;
      const hurtSpr = (it.e && it.e.sprHurt) ? it.e.sprHurt : enemyImgHurt;
      const spr = (it.e && it.e.hurt > 0) ? hurtSpr : baseSpr;
      const sw = spr.width || 1;
      const sh = spr.height || 1;

      for (let xx = 0; xx < size; xx++) {
        const sx = x0 + xx;
        if (sx < 0 || sx >= RW) continue;
        if (dist >= zbuf[sx]) continue;

        const tx = clamp((xx * sw / size) | 0, 0, sw - 1);
        g.drawImage(spr, tx, 0, 1, sh, sx, yy, 1, hh);
      }
    }
    g.globalAlpha = 1;
    g.imageSmoothingEnabled = false;
  }

  function drawBossCastFX(horizon) {
    if (!boss.alive || boss.cast <= 0) return;

    const dx = boss.x - player.x, dy = boss.y - player.y;
    const dist = hypot(dx, dy);
    if (dist < 0.1) return;

    const ang = normAng(Math.atan2(dy, dx) - player.a);
    if (Math.abs(ang) > FOV * 0.75) return;

    const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
    if (sx < 0 || sx >= RW || dist >= zbuf[sx]) return;

    const charge = 1 - clamp(boss.cast / FIRE_TELEGRAPH, 0, 1);
    const rad = clamp(((PROJ / dist) * (1.1 + 0.8 * charge)) | 0, 7, 42);
    const cy = (horizon - ((PROJ / dist) * 0.45)) | 0;

    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < 3; i++) {
      const r = rad + i * 5;
      const a = (0.16 - i * 0.04) * (0.35 + 0.65 * charge);
      g.fillStyle = `rgba(255,80,60,${a})`;
      g.fillRect((sx - r) | 0, (cy - r) | 0, (r * 2) | 0, (r * 2) | 0);
    }
    g.globalCompositeOperation = "source-over";
  }

  function drawFireballs(horizon) {
    if (!fireballs.length) return;

    const order = fireballs.map((f, i) => {
      const dx = f.x - player.x, dy = f.y - player.y;
      return { i, d: dx * dx + dy * dy };
    }).sort((a, b) => b.d - a.d);

    g.globalCompositeOperation = "lighter";

    for (let k = 0; k < order.length; k++) {
      const f = fireballs[order[k].i];
      const dx = f.x - player.x, dy = f.y - player.y;
      const dist = hypot(dx, dy);
      if (dist < 0.15) continue;

      const ang = normAng(Math.atan2(dy, dx) - player.a);
      if (Math.abs(ang) > FOV * 0.80) continue;

      const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
      const size = clamp(((PROJ / dist) | 0), 4, 22);
      const x0 = (sx - (size >> 1)) | 0;
      const cy = (horizon - (size * 0.18)) | 0;

      f.sx = clamp(sx, 0, RW - 1);
      f.sy = clamp(cy, 0, RH - 1);

      const flick = 0.60 + 0.40 * Math.sin(f.life * 18 + k * 1.7);
      const a0 = 0.18 + 0.18 * flick;
      const a1 = 0.30 + 0.22 * flick;

      const tx = f.x - f.vx * FIRE_TRAIL_LEN;
      const ty = f.y - f.vy * FIRE_TRAIL_LEN;
      const tang = normAng(Math.atan2(ty - player.y, tx - player.x) - player.a);
      if (Math.abs(tang) < FOV * 0.85) {
        const tsx = (RW / 2 + Math.tan(tang) * PROJ) | 0;
        g.strokeStyle = `rgba(255,120,70,${0.14 + 0.18 * flick})`;
        g.beginPath();
        g.moveTo(tsx, cy);
        g.lineTo(sx, cy);
        g.stroke();
      }

      for (let xx = 0; xx < size; xx++) {
        const pxX = x0 + xx;
        if (pxX < 0 || pxX >= RW) continue;
        if (dist >= zbuf[pxX]) continue;

        const u = (xx / size) * 2 - 1;
        const cut = 1 - u * u;
        if (cut <= 0) continue;

        const hh = (size * (0.50 + 0.50 * cut)) | 0;
        const yy = (cy - (hh >> 1)) | 0;

        g.fillStyle = `rgba(255,95,45,${a0})`;
        g.fillRect(pxX, yy, 1, hh);

        g.fillStyle = `rgba(255,220,120,${a1})`;
        g.fillRect(pxX, yy + 1, 1, Math.max(1, hh - 2));
      }

      g.fillStyle = `rgba(255,255,255,${0.10 + 0.16 * flick})`;
      g.fillRect((sx - 1) | 0, (cy - 1) | 0, 3, 3);
    }

    g.globalCompositeOperation = "source-over";
  }

  function renderFloorCeil(horizon, a, torch) {
    // Classic floor-casting style with left/right rays
    const leftA = a - FOV * 0.5;
    const rightA = a + FOV * 0.5;

    const rayDirX0 = Math.cos(leftA), rayDirY0 = Math.sin(leftA);
    const rayDirX1 = Math.cos(rightA), rayDirY1 = Math.sin(rightA);

    const posZ = RH * 0.5;

    for (let y = 0; y < RH; y++) {
      const p = (y > horizon) ? (y - horizon) : (horizon - y);
      if (p < 0.001) {
        // fill with fog-ish center line
        const col = pack(FOG_R, FOG_G, FOG_B);
        const off = y * RW;
        for (let x = 0; x < RW; x++) px[off + x] = col;
        continue;
      }

      const rowDist = posZ / p;
      const shadeRow = floorShade(rowDist);

      const texArr = (y > horizon) ? floorTex : ceilTex;

      let fx = player.x + rowDist * rayDirX0;
      let fy = player.y + rowDist * rayDirY0;

      const stepX = rowDist * (rayDirX1 - rayDirX0) / RW;
      const stepY = rowDist * (rayDirY1 - rayDirY0) / RW;

      const off = y * RW;
      for (let x = 0; x < RW; x++) {
        // TEX is power-of-two => fast wrap with bitmask
        const tx = ((fx * TEX) | 0) & (TEX - 1);
        const ty = ((fy * TEX) | 0) & (TEX - 1);
        const focus = colFocus[x] * torch;          // center brighter, edges darker
        const s = clamp((shadeRow * focus) | 0, 0, SH - 1);
        const base = s * TEXN;
        px[off + x] = texArr[base + ty * TEX + tx];
        fx += stepX;
        fy += stepY;
      }
    }
  }

  function drawLeaderboardPanel(x, y, title) {
    const w = 112;
    const h = 72;
    g.fillStyle = "rgba(0,0,0,0.42)";
    g.fillRect(x - 4, y - 12, w, h);
    g.fillStyle = "#eaf4ff";
    g.font = "10px monospace";
    g.fillText(title, x, y - 2);
    g.fillStyle = "#b7d4f2";
    for (let i = 0; i < LEADER_MAX; i++) {
      const t = i < leaderboard.length ? formatTime(leaderboard[i]) : "--:--.--";
      g.fillText(`${i + 1}. ${t}`, x, y + 10 + i * 11);
    }
  }

  function drawIntroScreen() {
    g.fillStyle = "#070A10";
    g.fillRect(0, 0, RW, RH);

    g.fillStyle = "#eaf4ff";
    g.font = "20px monospace";
    g.fillText("CAVE RAY", (RW / 2 - 55) | 0, 42);

    g.fillStyle = "#b7d4f2";
    g.font = "12px monospace";
    g.fillText("SURVIVE 3 FLOORS, DEFEAT THE BOSS, ESCAPE.", 36, 66);

    g.fillStyle = "#9fc4ea";
    g.fillText("MOVE / TURN: STICK", 16, 92);
    g.fillText("SHOOT: BTN1      WEAPON: BTN2", 16, 108);
    g.fillText("FLOOR 2: PICK UP MACHINE GUN", 16, 124);
    g.fillText("FOLLOW THE TOP ARROW FOR OBJECTIVES", 16, 140);
    g.fillText("SCORE = FINAL FLOOR CLEAR TIME", 16, 156);

    drawLeaderboardPanel(202, 86, "LEADERBOARD");

    g.fillStyle = "#eaf4ff";
    g.fillText("PRESS BTN1 TO START", 90, 172);
  }

  function renderFrame() {
    if (state === "intro" || state === "menu") {
      drawIntroScreen();
      return;
    }

    const ca = Math.cos(player.a), sa = Math.sin(player.a);

    const bob = Math.sin(player.bob) * 1.35;
    const rec = -player.recoil * 8;
    const horizon = (RH >> 1) + bob + rec;
    lastHorizon = horizon | 0;
    const torch = 0.92 + 0.08 * Math.sin(performance.now() * 0.004);

    // 1) floor + ceiling (perspective textured)
    renderFloorCeil(horizon, player.a, torch);

    // 2) walls

    for (let x = 0; x < RW; x++) {
      const dx = ca * rCos[x] - sa * rSin[x];
      const dy = sa * rCos[x] + ca * rSin[x];

      const hit = castFrom(player.x, player.y, dx, dy);
      const dist = hit.d;
      zbuf[x] = dist;

      const h = clamp((PROJ / dist) | 0, 0, RH);
      const y0 = (horizon - (h >> 1)) | 0;
      const y1 = y0 + h;

      const focus = colFocus[x] * torch;
      const s = wallShade(dist, hit.side, focus);

      const tex = wallTex[hit.t] || wallTex[1];
      const baseHi = s * TEXN;
      const sLo = clamp(s - 3, 0, SH - 1);
      const baseLo = sLo * TEXN;
      const tx = clamp((hit.u * TEX) | 0, 0, TEX - 1);

      const yy0 = y0 < 0 ? 0 : y0;
      const yy1 = y1 > RH ? RH : y1;
      const hh = (yy1 - yy0) || 1;

      for (let y = yy0; y < yy1; y++) {
        const rel = (y - yy0) / hh;
        const base = (rel < 0.10 || rel > 0.84) ? baseLo : baseHi;   // top/bottom darker
        const ty = clamp((((y - y0) * TEX) / (h || 1)) | 0, 0, TEX - 1);
        px[y * RW + x] = tex[base + ty * TEX + tx];
      }

      // subtle edge outline at top/bottom of wall slice (readability)
      const edgeS = clamp(s - 4, 0, SH - 1);
      const edgeBase = edgeS * TEXN;
      if (yy0 >= 0 && yy0 < RH) px[yy0 * RW + x] = tex[edgeBase + 0 * TEX + tx];
      const yb = yy1 - 1;
      if (yb >= 0 && yb < RH) px[yb * RW + x] = tex[edgeBase + (TEX - 1) * TEX + tx];
    }

    // 3) enemies (far -> near)
    const enemySprites = [];
    const ord = enemies.map((e, i) => {
      const dx = e.x - player.x, dy = e.y - player.y;
      return { i, d: dx * dx + dy * dy };
    }).sort((a, b) => b.d - a.d);

    for (let k = 0; k < ord.length; k++) {
      const e = enemies[ord[k].i];
      const dx = e.x - player.x;
      const dy = e.y - player.y;
      const dist = hypot(dx, dy);

      const ang = normAng(Math.atan2(dy, dx) - player.a);
      if (Math.abs(ang) > FOV * 0.62) continue;

      const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
      const baseSize = (PROJ / dist) | 0;
      const size = clamp((e.type ? baseSize * 1.15 : baseSize), 6, (RH * 1.6) | 0);

      const x0 = (sx - (size >> 1)) | 0;
      if (enemyImgReady) {
        enemySprites.push({ e, dist, size, x0 });
        continue;
      }

      let br = e.type ? 200 : 165;
      let bg = e.type ? 70 : 50;
      let bb = e.type ? 60 : 55;

      if (e.hurt > 0) { br = 240; bg = 240; bb = 240; }

      // distance shading (reuse floorShade curve)
      const shade = floorShade(dist);
      const f = 0.22 + 0.78 * (shade / (SH - 1));
      br = (br * f + FOG_R * (1 - f) * 0.6) | 0;
      bg = (bg * f + FOG_G * (1 - f) * 0.6) | 0;
      bb = (bb * f + FOG_B * (1 - f) * 0.6) | 0;

      const body = pack(br, bg, bb);

      for (let xx = 0; xx < size; xx++) {
        const pxX = x0 + xx;
        if (pxX < 0 || pxX >= RW) continue;
        if (dist >= zbuf[pxX]) continue;

        const u = (xx / size) * 2 - 1;
        const cut = 1 - u * u;
        if (cut <= 0) continue;

        const hh = (size * (0.35 + 0.65 * cut)) | 0;
        const yy = (horizon - (hh >> 1)) | 0;
        const yA = yy < 0 ? 0 : yy;
        const yB = (yy + hh) > RH ? RH : (yy + hh);

        for (let y = yA; y < yB; y++) {
          px[y * RW + pxX] = body;
        }
      }
    }

    if (boss.alive && enemyImgReady) {
      const dx = boss.x - player.x, dy = boss.y - player.y;
      const dist = hypot(dx, dy);
      const ang = normAng(Math.atan2(dy, dx) - player.a);
      if (Math.abs(ang) < FOV * 0.70) {
        const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
        const baseSize = (PROJ / dist) | 0;
        const size = clamp((baseSize * 2.0) | 0, 12, (RH * 2.0) | 0);
        const x0 = (sx - (size >> 1)) | 0;
        enemySprites.push({ e: boss, dist, size, x0 });
      }
    }
    enemySprites.sort((a, b) => b.dist - a.dist);

    // 4) stairs / exit portal
    if (stairs.active) {
      const dx = stairs.x - player.x;
      const dy = stairs.y - player.y;
      const dist = hypot(dx, dy);
      const ang = normAng(Math.atan2(dy, dx) - player.a);
      if (Math.abs(ang) < FOV * 0.72) {
        const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
        const size = clamp(((PROJ / dist) | 0), 10, 64);
        const x0 = (sx - (size >> 1)) | 0;
        const hh = clamp((size * 1.50) | 0, 12, (RH * 1.65) | 0);
        const yy = (horizon - (hh >> 1)) | 0;
        const yA = yy < 0 ? 0 : yy;
        const yB = (yy + hh) > RH ? RH : (yy + hh);

        const pulse = 0.55 + 0.45 * Math.sin(stairs.pulse * 6.0);
        const shade = floorShade(dist);
        const f = 0.24 + 0.76 * (shade / (SH - 1));
        const frame = pack((28 * f) | 0, (25 * f) | 0, (20 * f) | 0);
        const stepA = pack((clamp(180 + 45 * pulse, 0, 255) * f) | 0, (clamp(130 + 25 * pulse, 0, 255) * f) | 0, (50 * f) | 0);
        const stepB = pack((clamp(130 + 35 * pulse, 0, 255) * f) | 0, (clamp(88 + 20 * pulse, 0, 255) * f) | 0, (34 * f) | 0);
        const arrow = pack((clamp(235 + 20 * pulse, 0, 255) * f) | 0, (clamp(210 + 20 * pulse, 0, 255) * f) | 0, (150 * f) | 0);

        for (let xx = 0; xx < size; xx++) {
          const pxX = x0 + xx;
          if (pxX < 0 || pxX >= RW) continue;
          if (dist >= zbuf[pxX]) continue;
          const u = (xx / size) * 2 - 1;
          const edgeX = Math.abs(u) > 0.47;

          for (let y = yA; y < yB; y++) {
            const v = ((y - yy) / (hh || 1)) * 2 - 1;
            const edgeY = Math.abs(v) > 0.47;
            const stepBand = (((y - yy) >> 2) & 1) === 0;

            let col = frame;
            if (!edgeX && !edgeY) col = stepBand ? stepA : stepB;

            // Up-arrow cue in center.
            if (v > -0.44 && v < -0.16 && Math.abs(u) < 0.09) col = arrow;
            if (v > -0.28 && v < -0.18 && Math.abs(u) < 0.25 - Math.abs(v + 0.23) * 1.8) col = arrow;

            px[y * RW + pxX] = col;
          }
        }
      }
    } else if (floorIndex === FLOOR_COUNT - 1) {
      const dx = exitGate.x - player.x;
      const dy = exitGate.y - player.y;
      const dist = hypot(dx, dy);
      const ang = normAng(Math.atan2(dy, dx) - player.a);
      if (Math.abs(ang) < FOV * 0.72) {
        const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
        const size = clamp(((PROJ / dist) | 0), 12, 72);
        const x0 = (sx - (size >> 1)) | 0;
        const hh = clamp((size * 1.65) | 0, 14, (RH * 1.75) | 0);
        const yy = (horizon - (hh >> 1)) | 0;
        const yA = yy < 0 ? 0 : yy;
        const yB = (yy + hh) > RH ? RH : (yy + hh);

        const pulse = 0.55 + 0.45 * Math.sin(exitGate.pulse * 6.2);
        const shade = floorShade(dist);
        const f = 0.24 + 0.76 * (shade / (SH - 1));
        const frameCol = pack((22 * f) | 0, (24 * f) | 0, (30 * f) | 0);
        const closedA = pack((120 * f) | 0, (42 * f) | 0, (42 * f) | 0);
        const closedB = pack((70 * f) | 0, (22 * f) | 0, (22 * f) | 0);
        const openOuter = pack((28 * f) | 0, (95 * f) | 0, (145 * f) | 0);
        const openRing = pack(
          (clamp(95 + 120 * pulse, 0, 255) * f) | 0,
          (clamp(170 + 75 * pulse, 0, 255) * f) | 0,
          (clamp(230 + 20 * pulse, 0, 255) * f) | 0
        );
        const openCoreA = pack((28 * f) | 0, (clamp(150 + 90 * pulse, 0, 255) * f) | 0, (clamp(225 + 25 * pulse, 0, 255) * f) | 0);
        const openCoreB = pack((18 * f) | 0, (clamp(95 + 65 * pulse, 0, 255) * f) | 0, (clamp(170 + 20 * pulse, 0, 255) * f) | 0);

        for (let xx = 0; xx < size; xx++) {
          const pxX = x0 + xx;
          if (pxX < 0 || pxX >= RW) continue;
          if (dist >= zbuf[pxX]) continue;
          const u = (xx / size) * 2 - 1;
          const edgeX = Math.abs(u) > 0.47;

          for (let y = yA; y < yB; y++) {
            const v = ((y - yy) / (hh || 1)) * 2 - 1;
            const edgeY = Math.abs(v) > 0.47;

            let col = frameCol;
            if (!edgeX && !edgeY) {
              if (!exitGate.open) {
                const stripe = ((xx + ((y + ((exitGate.pulse * 26) | 0)) >> 1)) & 7) < 2;
                col = stripe ? closedA : closedB;
              } else {
                const ring = Math.abs(Math.hypot(u * 1.08, v * 0.92) - 0.60) < 0.08;
                const core = Math.hypot(u * 1.15, v * 0.95) < 0.52;
                if (ring) col = openRing;
                else if (core) {
                  const wave = Math.sin(v * 14 + exitGate.pulse * 8 + u * 5);
                  col = wave > 0 ? openCoreA : openCoreB;
                } else col = openOuter;
              }
            }
            px[y * RW + pxX] = col;
          }
        }
      }
    }

    // 5) machine gun pickup billboard
    if (mgPickup.active) {
      const dx = mgPickup.x - player.x;
      const dy = mgPickup.y - player.y;
      const dist = hypot(dx, dy);
      const ang = normAng(Math.atan2(dy, dx) - player.a);
      if (Math.abs(ang) < FOV * 0.65) {
        const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
        const size = clamp(((PROJ / dist) | 0), 7, 44);
        const x0 = (sx - (size >> 1)) | 0;

        const shade = floorShade(dist);
        const f = 0.22 + 0.78 * (shade / (SH - 1));
        const body = pack((205 * f) | 0, (148 * f) | 0, (74 * f) | 0);
        const dark = pack((85 * f) | 0, (62 * f) | 0, (38 * f) | 0);
        const hi = pack((250 * f) | 0, (220 * f) | 0, (150 * f) | 0);

        for (let xx = 0; xx < size; xx++) {
          const pxX = x0 + xx;
          if (pxX < 0 || pxX >= RW) continue;
          if (dist >= zbuf[pxX]) continue;

          const hh = (size * 0.92) | 0;
          const yy = (horizon - (hh >> 1)) | 0;
          const yA = yy < 0 ? 0 : yy;
          const yB = (yy + hh) > RH ? RH : (yy + hh);
          const u = xx / (size || 1);

          for (let y = yA; y < yB; y++) {
            const v = (y - yy) / (hh || 1);
            let col = 0;
            const stock = (u > 0.10 && u < 0.34 && v > 0.35 && v < 0.70);
            const bodyRect = (u > 0.26 && u < 0.70 && v > 0.32 && v < 0.58);
            const barrel = (u >= 0.66 && u < 0.94 && v > 0.40 && v < 0.52);
            const grip = (u > 0.44 && u < 0.56 && v > 0.56 && v < 0.86);
            const sight = (u > 0.50 && u < 0.62 && v > 0.20 && v < 0.30);

            if (stock || bodyRect || barrel || grip) col = body;
            if (barrel || grip) col = dark;
            if (sight) col = hi;
            if (col) px[y * RW + pxX] = col;
          }
        }
      }
    }

    // 6) medkit billboard
    if (med.x !== 0) {
      const dx = med.x - player.x;
      const dy = med.y - player.y;
      const dist = hypot(dx, dy);
      const ang = normAng(Math.atan2(dy, dx) - player.a);
      if (Math.abs(ang) < FOV * 0.65) {
        const sx = (RW / 2 + Math.tan(ang) * PROJ) | 0;
        const size = clamp(((PROJ / dist) | 0), 6, 40);
        const x0 = (sx - (size >> 1)) | 0;

        const shade = floorShade(dist);
        const f = 0.22 + 0.78 * (shade / (SH - 1));
        const col = pack((40 * f) | 0, (220 * f) | 0, (80 * f) | 0);
        const cross = pack((240 * f) | 0, (240 * f) | 0, (240 * f) | 0);

        for (let xx = 0; xx < size; xx++) {
          const pxX = x0 + xx;
          if (pxX < 0 || pxX >= RW) continue;
          if (dist >= zbuf[pxX]) continue;

          const hh = (size * 1.15) | 0;
          const yy = (horizon - (hh >> 1)) | 0;
          const yA = yy < 0 ? 0 : yy;
          const yB = (yy + hh) > RH ? RH : (yy + hh);

          const mid = size >> 1;
          for (let y = yA; y < yB; y++) {
            let pcol = col;
            const v = (y - yy) / (hh || 1);

            const cx = Math.abs(xx - mid) < (size * 0.08);
            const cy = Math.abs(v - 0.55) < 0.06;
            if (cx || cy) pcol = cross;

            px[y * RW + pxX] = pcol;
          }
        }
      }
    }

    // commit pixel buffer
    g.putImageData(img, 0, 0);
    drawEnemySprites(enemySprites, horizon);

    // world-only post tint + threat darken (HUD stays clean)
    g.fillStyle = "rgba(25,40,80,0.06)";
    g.fillRect(0, 0, RW, RH);
    if (threatLevel > 0) {
      g.fillStyle = `rgba(0,0,0,${0.10 * threatLevel})`;
      g.fillRect(0, 0, RW, RH);
    }

    drawSparks();
    drawImpactLights();

    // HUD + minimap + objective + crosshair + weapon
    drawHUD();
    drawMinimap();
    drawObjectiveArrow();

    const cx = RW >> 1, cy = (horizon | 0);
    const spread = 6 + (player.recoil * 22) | 0;

    g.fillStyle = "rgba(234,244,255,0.90)";
    g.fillRect(cx - spread, cy, spread * 2, 1);
    g.fillRect(cx, cy - spread, 1, spread * 2);

    if (hitMark > 0) {
      g.fillStyle = "rgba(255,107,107,0.9)";
      g.fillRect(cx - 9, cy - 9, 18, 2);
      g.fillRect(cx - 9, cy + 7, 18, 2);
      g.fillRect(cx - 9, cy - 9, 2, 18);
      g.fillRect(cx + 7, cy - 9, 2, 18);
    }

    drawWeapon(horizon);

    // damage / flash overlays
    if (flash > 0) {
      g.fillStyle = "rgba(255,255,255,0.16)";
      g.fillRect(0, 0, RW, RH);
    }
    if (player.hurt > 0) {
      const a = clamp(player.hurt, 0, 1);
      g.fillStyle = `rgba(255,60,60,${0.20 * a})`;
      g.fillRect(0, 0, RW, RH);
    }
    if (player.blind > 0) {
      const a = clamp(player.blind, 0, 1);
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.006 + player.dizzy * 6.0);

      // Even full-screen blindness veil (not center-weighted).
      g.fillStyle = `rgba(0,0,0,${0.22 + 0.46 * a})`;
      g.fillRect(0, 0, RW, RH);

      // Subtle rolling haze so blindness feels alive, not just a flat dim.
      g.globalCompositeOperation = "lighter";
      g.fillStyle = `rgba(46,56,74,${(0.04 + 0.10 * a) * pulse})`;
      for (let y = 0; y < RH; y += 10) {
        const h = 4 + (((y >> 3) + ((performance.now() * 0.01) | 0)) & 3);
        g.fillRect(0, y, RW, h);
      }
      g.globalCompositeOperation = "source-over";
    }

    if (jumpscareT > 0) {
      const t = clamp(jumpscareT / BOSS_JUMPSCARE_DUR, 0, 1);
      const flick = 0.55 + 0.45 * Math.sin(performance.now() * 0.11);
      const a = clamp((0.70 + 0.30 * t) * flick, 0, 1);
      const spr = bossImgHurt || bossImg;
      const j = (0.30 + 0.70 * t) * 20;
      const pop = 1.05 + 0.26 * t;
      const oxJ = (Math.random() - 0.5) * j;
      const oyJ = (Math.random() - 0.5) * j * 0.65;

      g.save();
      g.imageSmoothingEnabled = true;
      g.fillStyle = `rgba(0,0,0,${0.14 + 0.22 * t})`;
      g.fillRect(0, 0, RW, RH);
      g.translate((RW * 0.5) + oxJ, (RH * 0.5) + oyJ);
      g.scale(pop, pop);
      g.globalAlpha = a;
      g.drawImage(spr, -RW * 0.5, -RH * 0.5, RW, RH);
      g.globalAlpha = 0.34 * t;
      g.fillStyle = "rgba(255,35,35,1)";
      g.fillRect(-RW * 0.5, -RH * 0.5, RW, RH);
      g.restore();
    }

    // CRT overlays on top
    g.globalAlpha = 1;
    g.drawImage(overlays.scan, 0, 0);
    g.drawImage(overlays.vig, 0, 0);

    // Final-floor timer overlay (score timer)
    if (state === "play" && finalStartClock >= 0) {
      const t = Math.max(0, runClock - finalStartClock);
      g.fillStyle = "rgba(0,0,0,0.58)";
      g.fillRect(RW - 126, 6, 120, 18);
      g.fillStyle = "#eaf4ff";
      g.font = "12px monospace";
      g.fillText("TIMER " + formatTime(t), RW - 122, 19);
    }
  }

  function drawHUD() {
    const hp = Math.max(0, player.hp | 0);

    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(6, 6, 124, 8);
    g.fillStyle = hp > 30 ? "rgba(43,240,111,0.9)" : "rgba(255,107,107,0.9)";
    g.fillRect(6, 6, Math.max(0, Math.min(124, (hp / 100) * 124)) | 0, 8);
    if (boss.alive) {
      const w = 140, h = 8;
      const x = (RW / 2 - w / 2) | 0;
      const y = 4;

      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(x, y, w, h);
      const p = clamp(boss.hp / (boss.max || 1), 0, 1);

      g.fillStyle = "rgba(255,107,107,0.92)";
      g.fillRect(x, y, (w * p) | 0, h);
    }

    if (state === "play") {
      let obj = "";
      if (boss.alive) obj = "OBJECTIVE: DEFEAT BOSS";
      else if (stairs.active && mgPickup.active && !machineUnlocked) obj = "OBJECTIVE: FIND STAIRS (MG OPTIONAL)";
      else if (stairs.active) obj = "OBJECTIVE: FIND STAIRS";
      else if (mgPickup.active) obj = "OBJECTIVE: FIND MACHINE GUN";
      else if (exitGate.x !== 0 && !exitGate.open) obj = "OBJECTIVE: UNLOCK EXIT";
      else if (exitGate.x !== 0 && exitGate.open) obj = "OBJECTIVE: REACH EXIT";

      if (obj) {
        g.fillStyle = "rgba(0,0,0,0.45)";
        g.fillRect(132, 4, 184, 12);
        g.fillStyle = "#cfe5ff";
        g.font = "10px monospace";
        g.fillText(obj, 136, 13);
      }
    }

    if (state === "dead") {
      g.fillStyle = "rgba(0,0,0,0.70)";
      g.fillRect(0, 0, RW, RH);
      g.fillStyle = "#eaf4ff";
      g.font = "18px monospace";
      g.fillText("GAME OVER", (RW / 2 - 55) | 0, (RH / 2 - 10) | 0);
      g.fillStyle = "#b7d4f2";
      g.font = "12px monospace";
      g.fillText("Press BTN1 to restart", (RW / 2 - 68) | 0, (RH / 2 + 30) | 0);
    }

    if (state === "won") {
      g.fillStyle = "rgba(0,0,0,0.70)";
      g.fillRect(0, 0, RW, RH);
      g.fillStyle = "#eaf4ff";
      g.font = "18px monospace";
      g.fillText("YOU ESCAPED", (RW / 2 - 58) | 0, (RH / 2 - 10) | 0);
      g.fillStyle = "#b7d4f2";
      g.font = "12px monospace";
      g.fillText("SCORE " + formatTime(finalScore), (RW / 2 - 58) | 0, (RH / 2 + 10) | 0);
      g.fillText("Press BTN1 to play again", (RW / 2 - 72) | 0, (RH / 2 + 30) | 0);
      drawLeaderboardPanel(194, 92, "LEADERBOARD");
    }
  }

  function drawWeapon(horizon) {
    const bob = Math.sin(player.bob * 0.9) * 3;
    const rec = player.recoil * 16;
    const isMG = WEAPONS[weaponIndex].auto;

    const baseY = (RH - 6 + bob + rec) | 0;
    const baseX = (RW >> 1);

    g.fillStyle = "rgba(0,0,0,0.50)";
    g.fillRect(baseX - 54, baseY - 50, 108, 50);

    if (isMG) {
      g.fillStyle = "rgba(85,105,130,0.95)";
      g.fillRect(baseX - 48, baseY - 45, 96, 41);
      g.fillStyle = "rgba(35,50,70,0.95)";
      g.fillRect(baseX - 16, baseY - 46, 32, 20);
      g.fillStyle = "rgba(18,22,30,0.95)";
      g.fillRect(baseX - 10, baseY - 56, 20, 12); // thicker barrel block
      g.fillRect(baseX + 8, baseY - 53, 24, 6);   // extended barrel
      g.fillStyle = "rgba(120,95,55,0.90)";
      g.fillRect(baseX - 34, baseY - 20, 10, 16); // side mag hint
      g.strokeStyle = "rgba(234,244,255,0.24)";
      g.strokeRect(baseX - 48, baseY - 45, 96, 41);
    } else {
      g.fillStyle = "rgba(95,120,150,0.92)";
      g.fillRect(baseX - 46, baseY - 44, 92, 40);
      g.fillStyle = "rgba(35,50,70,0.95)";
      g.fillRect(baseX - 12, baseY - 44, 24, 18);
      g.fillStyle = "rgba(18,22,30,0.95)";
      g.fillRect(baseX - 7, baseY - 48, 14, 10);
      g.strokeStyle = "rgba(234,244,255,0.25)";
      g.strokeRect(baseX - 46, baseY - 44, 92, 40);
    }

    if (flash > 0) {
      g.fillStyle = "rgba(255,240,120,0.85)";
      g.fillRect(baseX - 2, baseY - (isMG ? 62 : 58), 4, 10);
      g.fillStyle = "rgba(255,255,255,0.55)";
      g.fillRect(baseX - 1, baseY - (isMG ? 66 : 62), 2, 6);
    }
  }

  function drawMinimap() {
    const mm = 66;
    const x0 = 6, y0 = 30;

    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(x0 - 2, y0 - 2, mm + 4, mm + 4);

    const sX = mm / MW, sY = mm / MH;

    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const t = grid[y * MW + x];
        if (!t) continue;
        g.fillStyle = t === 1 ? "rgba(140,120,170,0.85)" : t === 2 ? "rgba(90,150,210,0.85)" : "rgba(60,150,80,0.85)";
        g.fillRect((x0 + x * sX) | 0, (y0 + y * sY) | 0, (sX + 0.2) | 0, (sY + 0.2) | 0);
      }
    }

    if (med.x !== 0) {
      g.fillStyle = "rgba(43,240,111,0.95)";
      g.fillRect((x0 + med.x * sX) | 0, (y0 + med.y * sY) | 0, 2, 2);
    }

    if (mgPickup.active) {
      g.fillStyle = "rgba(255,170,90,0.95)";
      g.fillRect((x0 + mgPickup.x * sX) | 0, (y0 + mgPickup.y * sY) | 0, 3, 3);
    }

    if (stairs.active) {
      g.fillStyle = "rgba(255,205,90,0.95)";
      g.fillRect((x0 + stairs.x * sX) | 0, (y0 + stairs.y * sY) | 0, 3, 3);
    }

    if (!stairs.active && exitGate.x !== 0) {
      g.fillStyle = exitGate.open ? "rgba(110,240,255,0.95)" : "rgba(180,80,80,0.95)";
      g.fillRect((x0 + exitGate.x * sX) | 0, (y0 + exitGate.y * sY) | 0, 3, 3);
    }

    g.fillStyle = "rgba(255,107,107,0.90)";
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      g.fillRect((x0 + e.x * sX) | 0, (y0 + e.y * sY) | 0, 2, 2);
    }

    const px0 = (x0 + player.x * sX) | 0;
    const py0 = (y0 + player.y * sY) | 0;
    g.fillStyle = "rgba(234,244,255,0.95)";
    g.fillRect(px0 - 1, py0 - 1, 3, 3);

    const fx = px0 + Math.cos(player.a) * 6;
    const fy = py0 + Math.sin(player.a) * 6;
    g.strokeStyle = "rgba(234,244,255,0.55)";
    g.beginPath();
    g.moveTo(px0, py0);
    g.lineTo(fx, fy);
    g.stroke();

    const fa = player.a - FOV * 0.33;
    const fb = player.a + FOV * 0.33;
    g.strokeStyle = "rgba(160,210,255,0.35)";
    g.beginPath();
    g.moveTo(px0, py0);
    g.lineTo(px0 + Math.cos(fa) * 7, py0 + Math.sin(fa) * 7);
    g.moveTo(px0, py0);
    g.lineTo(px0 + Math.cos(fb) * 7, py0 + Math.sin(fb) * 7);
    g.stroke();
  }

  // ----------------- Main loop -----------------
  let last = performance.now();
  loadMap(generateMapLines());

  function tick(t) {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    if (noteT > 0) noteT = Math.max(0, noteT - dt);
    if (jumpscareT > 0) jumpscareT = Math.max(0, jumpscareT - dt);
    updateSparks(dt);
    updateImpactLights(dt);
    drawBossCastFX();

    if (state === "play") {
      runClock += dt;
      if (shootCd > 0) shootCd -= dt;
      if (flash > 0) flash -= dt;
      if (hitMark > 0) hitMark -= dt;
      if (player.recoil > 0) player.recoil = Math.max(0, player.recoil - dt * 3.6);
      if (player.hurt > 0) player.hurt = Math.max(0, player.hurt - dt * 1.8);
      if (player.dizzy > 0) player.dizzy = Math.max(0, player.dizzy - dt * 0.42);
      if (player.blind > 0) player.blind = Math.max(0, player.blind - dt * 0.35);
      if (shake > 0) shake = Math.max(0, shake - dt * 3.2);

      if (triggerHeld && WEAPONS[weaponIndex].auto) shoot();

      movePlayer(dt);
      updateEnemies(dt);
      updateBoss(dt);
      updatePickup(dt);
      updateExit(dt);

      let nearestD2 = 1e9;
      let bossFxLevel = 0;
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        const dx = e.x - player.x, dy = e.y - player.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD2) nearestD2 = d2;
      }
      if (boss.alive) {
        const dx = boss.x - player.x, dy = boss.y - player.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD2) nearestD2 = d2;
        bossFxLevel = clamp((12 - Math.sqrt(d2)) / 12, 0, 1);
      }
      if (nearestD2 < 64) {
        threatLevel = clamp((8 - Math.sqrt(nearestD2)) / 7, 0, 1);
        audio.threat(threatLevel, dt);
      } else {
        threatLevel = 0;
        audio.threat(0, dt);
      }
      audio.bossFx(bossFxLevel);

      if (player.hp <= 0) {
        player.hp = 0;
        state = "dead";
        audio.stopMusic();
      }
    } else {
      threatLevel = 0;
      audio.threat(0, dt);
      audio.bossFx(0);
      audio.footstep(0, dt);
      if (player.dizzy > 0) player.dizzy = Math.max(0, player.dizzy - dt * 0.8);
      if (player.blind > 0) player.blind = Math.max(0, player.blind - dt * 0.8);
    }

    renderFrame();

    // present with subtle screen shake
    const sh = shake > 0 ? shake : 0;
    const dz = (state === "play") ? clamp(player.dizzy, 0, 1) : 0;
    const js = jumpscareT > 0 ? clamp(jumpscareT / BOSS_JUMPSCARE_DUR, 0, 1) : 0;
    const sx = (sh ? ((Math.random() - 0.5) * sh * 10 * scale) : 0)
      + (dz ? Math.sin(t * 0.012) * dz * 7 * scale : 0)
      + (js ? (Math.random() - 0.5) * (16 * js * scale) : 0);
    const sy = (sh ? ((Math.random() - 0.5) * sh * 8 * scale) : 0)
      + (dz ? Math.cos(t * 0.016) * dz * 6 * scale : 0)
      + (js ? (Math.random() - 0.5) * (12 * js * scale) : 0);
    const roll = dz ? Math.sin(t * 0.009) * dz * 0.032 : 0;

    ctx.clearRect(0, 0, c.width, c.height);
    if (roll) {
      const cxp = c.width * 0.5, cyp = c.height * 0.5;
      ctx.save();
      ctx.translate(cxp, cyp);
      ctx.rotate(roll);
      ctx.drawImage(buf, 0, 0, RW, RH, (ox + sx) - cxp, (oy + sy) - cyp, RW * scale, RH * scale);
      ctx.restore();
    } else {
      ctx.drawImage(buf, 0, 0, RW, RH, (ox + sx) | 0, (oy + sy) | 0, RW * scale, RH * scale);
    }

    requestAnimationFrame(tick);
  }

  state = "intro";
  requestAnimationFrame(tick);
})();
// i love pupu <3
// i love gluglu <3
// i love tarche <3
// i love heibor <3
// i love celestia <3
// i love everyone <3
