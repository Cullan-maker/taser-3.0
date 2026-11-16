/**
 * TASER 7 ELITE - VR / AR Headset & Split-Screen Passthrough Application
 * Reuses core simulation modules (fsm, audio, ballistics, scene, xr, voice, pose)
 * while isolating VR headset rendering, camera passthrough, WebXR controllers,
 * Bluetooth gamepad polling, Live AI dual-eye HUD, and Firebase Marker sync.
 */

import * as THREE from 'three';
import { StereoEffect } from 'three/addons/effects/StereoEffect.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TaserFSM, ChamberState } from './fsm.js';
import { TaserAudio } from './audio.js';
import { TaserBallistics } from './ballistics.js';
import { TaserScene } from './scene.js';
import { TaserXR } from './xr.js';
import { TaserVoice } from './voice.js';
import { TaserAIPose } from './pose.js';

if (typeof window !== 'undefined') {
  window.THREE = THREE;
  window.StereoEffect = StereoEffect;
  window.GLTFLoader = GLTFLoader;
}

const VR_CAMERA_FOV = 78;
const GAMEPAD_MAP_STORAGE_KEY = 'taser7_vr_gamepad_map_v1';
const WEAPON_MODE_STORAGE_KEY = 'taser7_vr_weapon_mode_v1';

/**
 * Standardmappning för extern Bluetooth-joystick / VR-fjärrkontroll.
 * Kan ändras direkt här eller via "🕹️ Mappa BT" i VR-menyn (sparas i localStorage).
 */
export const DEFAULT_GAMEPAD_MAP = Object.freeze({
  fire: 0,           // Button 0 (Trigger / A): Avfyra vald kassett / elchock om skott redan är avfyrat
  safety: 1,         // Button 1 (B / Sidoknapp): Osäkra / Säkra
  cassette: 2,       // Button 2 (X): Ladda om / Byt kassett
  arc: 3,            // Button 3 (Y): Ljusbågscykel (motsv. Enter i HID-läge)
  confirm: [10, 11], // Button 10/11 (L3/R3 spakklick): Fastställ målposition (motsv. Space i HID-läge)
  reset: 9           // Button 9 (Start / Meny): Återställ skott & trådar
});

function normalizeMappingValue(val) {
  if (Array.isArray(val)) {
    const clean = val.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0);
    return clean.length === 1 ? clean[0] : (clean.length > 1 ? clean : []);
  }
  const num = Number(val);
  return Number.isInteger(num) && num >= 0 ? num : 0;
}

function loadGamepadMap() {
  const base = {
    fire: DEFAULT_GAMEPAD_MAP.fire,
    safety: DEFAULT_GAMEPAD_MAP.safety,
    cassette: DEFAULT_GAMEPAD_MAP.cassette,
    arc: DEFAULT_GAMEPAD_MAP.arc,
    confirm: [...DEFAULT_GAMEPAD_MAP.confirm],
    reset: DEFAULT_GAMEPAD_MAP.reset
  };
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(GAMEPAD_MAP_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          let hadLegacyTilt = false;
          if ('tilt' in parsed) {
            delete parsed.tilt;
            hadLegacyTilt = true;
          }
          for (const key of Object.keys(base)) {
            if (parsed[key] !== undefined) {
              base[key] = normalizeMappingValue(parsed[key]);
            }
          }
          if (hadLegacyTilt) {
            localStorage.setItem(GAMEPAD_MAP_STORAGE_KEY, JSON.stringify(base));
          }
        }
      }
    }
  } catch (err) {
    console.warn('[VR Gamepad] Kunde inte läsa sparad mappning:', err);
  }
  return base;
}

export const GAMEPAD_MAP = loadGamepadMap();

function isButtonMapped(buttonIndex, mappingValue) {
  if (Array.isArray(mappingValue)) {
    return mappingValue.includes(buttonIndex);
  }
  return Number(mappingValue) === buttonIndex;
}

function formatMappingLabel(mappingValue) {
  if (Array.isArray(mappingValue)) {
    return mappingValue.length ? `KNAPP ${mappingValue.join(', ')}` : 'EJ MAPPAD';
  }
  return Number.isInteger(Number(mappingValue)) ? `KNAPP ${mappingValue}` : 'EJ MAPPAD';
}

export class TaserVRApp {
  constructor() {
    if (typeof window !== 'undefined') {
      window.taserApp = this;
      window.app = this;
      window.appMode = 'vr-headset';
      window.currentMode = 'vr';
      window.vrJoystickReady = true;
      window.handDetected = false;
      window.activeCartridge = 1;
      window.isFiring = false;
      window.state = window.state || {
        tilt: 0,
        isSafe: true,
        functionCheckMode: false,
        isFiring: false,
        activeCartridge: 1
      };
    }

    // Core simulation modules
    this.fsm = new TaserFSM();
    this.audio = new TaserAudio(this.fsm);
    this.ballistics = new TaserBallistics();

    const viewportEl = document.getElementById('three-canvas');
    this.scene = new TaserScene(viewportEl);
    this.vrFov = VR_CAMERA_FOV;
    this.applyVRCameraProjection();

    this.xr = new TaserXR(this.scene, {
      onSessionStart: this.onXRSessionStart.bind(this),
      onSessionEnd: this.onXRSessionEnd.bind(this)
    });
    this.scene.xrManager = this.xr;

    // Force transparent WebGL passthrough from frame 0
    this.scene.enableARMode();

    // AI-Based Person Pose & Dynamic Hitbox Engine (Live AI)
    this.aiPose = new TaserAIPose(this.scene, this.scene.camera, {
      videoElement: document.getElementById('camera-feed-left'),
      onStatusChange: (detected, label) => {
        const tLabel = document.getElementById('target-label');
        const dLabel = document.getElementById('dist-label');
        if (tLabel && this.isLiveAIRunning()) {
          tLabel.textContent = detected ? 'MÄNNISKA (AI LÅST: LIVE)' : (label || 'SÖKER PERSON (AI)...');
          tLabel.classList.toggle('armed', detected);
        }
        if (dLabel && this.isLiveAIRunning() && detected) {
          dLabel.textContent = `${this.aiPose.estimatedDistance.toFixed(1)} M (AI)`;
          this.currentDistance = this.aiPose.estimatedDistance;
          this.updateAimVisuals();
        }
      }
    });
    this.scene.aiPose = this.aiPose;

    // Swedish tactical Voice Command Engine ('sv-SE')
    this.voice = new TaserVoice({
      onCommand: this.handleVoiceCommand.bind(this),
      onStatusChange: (active, label) => {
        const btn = document.getElementById('btn-voice');
        if (btn) {
          btn.textContent = `🎙️ Röst: ${label}`;
          btn.classList.toggle('listening', active);
        }
        const topBtn = document.getElementById('vr-btn-voice');
        if (topBtn) {
          topBtn.textContent = active ? '🎙️ Röst: PÅ' : '🎙️ Röst';
          topBtn.classList.toggle('active-pill', active);
        }
      },
      onLog: (msg) => this.log(msg)
    });

    // Display & Stereo VR state
    this.isStereoVR = true;
    this.stereoEffect = new StereoEffect(this.scene.renderer);
    this.stereoEffect.setEyeSeparation(0.064);
    this.hudHidden = false;
    this.passthroughStream = null;
    this.isSyntheticPassthrough = false;

    // Aim & Ballistic state
    this.currentDistance = 3.0;
    this.aimX = 50;
    this.aimY = 50;
    this.tilt = 0;
    this._gyroContinuousRoll = 0;
    this._hasGyroRoll = false;
    this._hudVisualDropPx = null;
    this._hudTiltDeg = 0;
    this._lastModalOpenAt = 0;

    // Threat escalation & Verbal warnings
    this.threatLevel = 0;
    this.threatWeapon = 'KNIFE';
    this.threatInterval = null;
    this.nmiTimer = null;
    this.warningGiven = false;
    this.isScenarioActive = false;
    this.isTased = false;
    this.isGameOver = false;
    this.isFiring = false;
    this.liveWires = [];
    this.liveARRoomCode = null;
    this.selectedScenario = 'static';

    // Gamepad, HID Keyboard & WebXR controller polling state
    this._prevGamepadButtons = new Array(24).fill(false);
    this._prevGamepadButtonsMap = new Map();
    this._prevXRButtons = new Map();
    this._heldKeys = new Set();
    this._gpMoveX = 0;
    this._gpMoveY = 0;
    this._lastPlacementTickTs = performance.now();
    this._xrManualMoveUsed = false;
    this._xrManualPos = new THREE.Vector3(0, 0, 0);
    this._xrFwdVec = new THREE.Vector3();
    this._xrRightVecLocal = new THREE.Vector3();
    this._lastControllerActionTs = 0;
    this._fireBtnHeldSince = 0;
    this._aimTrimX = 0;
    this._aimTrimY = 0;
    this._calibratingAction = null;
    this._showBtDebugHud = true;
    this._btConnected = false;
    this._btInputDetected = false;
    this._lastBtSignalText = '';
    this._btDebugFadeTimer = null;
    this._lastMoveSignalLogTs = 0;
    this._wireArcPulseInterval = null;
    this._lastFirebaseHitSentTs = 0;
    this._xrSelectStartBound = null;
    this._xrSqueezeStartBound = null;

    // 3D Hand-tracked Weapon + Dynamic CID + Chamber Overlays + Electrode Arcs
    this.weaponInitialized = false;
    this.weaponGroup = null;
    this.weaponMesh = null;
    this.muzzlePoint = null;
    this.cidCanvas = null;
    this.cidCtx = null;
    this.cidTexture = null;
    this.cidMesh = null;
    this._cidLastKey = '';
    this._cidActiveCycleCount = 0;
    this._safetyLeverMesh = null;
    this.chamber1Overlay = null;
    this.chamber2Overlay = null;
    this.weaponArcActive = false;
    this.weaponArcGroup = null;
    this.weaponArcLight = null;
    this.weaponArcTubeMesh = null;
    this.weaponArcCoreMesh = null;
    this.weaponArcSprites = [];
    this.weaponArcCurvePoints = [];
    this.handsInstance = null;
    this.handLoopActive = false;
    this.handSending = false;
    this.lastHandSendTime = 0;
    this.lastHandSeenTime = 0;
    this.HAND_GRACE_MS = 800;
    this.FALLBACK_TRANSITION_TAU = 0.115; // ~0.4s mjuk LERP/SLERP-övergång
    this.HAND_REACQUIRE_FRAMES = 3;
    this.HAND_SMOOTHING = 0.35;
    this.handPreference = 'auto';
    this.detectedHandedness = 'Right';
    this.weaponLockMode = this.loadWeaponLockMode(); // 'auto' | 'locked_fallback'
    this.weaponTrackState = 'FALLBACK_READY'; // 'HAND_TRACKED' | 'GRACE_FREEZE' | 'FALLBACK_READY'
    this._consecutiveHandFrames = 0;
    this._returnBlendRemaining = 0;
    this._lastHudTrackBadgeKey = '';
    this.handDetected = true;
    this.handTargetPos = new THREE.Vector3(0.21, -0.19, -0.56);
    this.handCurrentPos = new THREE.Vector3(0.21, -0.19, -0.56);
    this.handTargetQuat = new THREE.Quaternion();
    this.handCurrentQuat = new THREE.Quaternion();
    this._fallbackTargetPos = new THREE.Vector3(0.21, -0.19, -0.56);
    this._fallbackTargetQuat = new THREE.Quaternion();

    // Pre-allocated math helpers (Zero-GC render loop)
    this._normMat = new THREE.Matrix4();
    this._box3 = new THREE.Box3();
    this._vSize = new THREE.Vector3();
    this._vCenter = new THREE.Vector3();
    this._handFwd = new THREE.Vector3();
    this._handUp = new THREE.Vector3();
    this._handRight = new THREE.Vector3();
    this._handBack = new THREE.Vector3();
    this._handBasis = new THREE.Matrix4();
    this._fbFwd = new THREE.Vector3();
    this._fbUp = new THREE.Vector3();
    this._fbRight = new THREE.Vector3();
    this._fbBack = new THREE.Vector3();
    this._fbBasis = new THREE.Matrix4();

    // Ready weapon hardware state for immediate VR operation
    this.ensureReadyHardware();

    this.initDOM();
    this.initFSMSubscriptions();
    this.initInputs();
    this.initTaser3DWeapon();
    this.initStereoVRMode();
    this.startRenderLoop();

    // Auto-start rear camera passthrough immediately on load
    this.startCameraPassThrough();

    this.log("VR/AR Headset Simulator v7.47 initierad. <span style='color:#2ecc71;'>Kamera pass-through & Stereo 3D aktiv.</span>");
  }

  ensureReadyHardware() {
    this.fsm.hasBattery = true;
    this.fsm.chamber1 = ChamberState.LOADED;
    this.fsm.chamber2 = ChamberState.LOADED;
    this.fsm.activeChamber = 1;
    this.fsm.shotsFired = 0;
    this.fsm.isSafe = true;
    this.fsm.displayState = 'OFF';
    if (typeof window !== 'undefined' && window.state) {
      window.state.isSafe = true;
      window.state.activeCartridge = 1;
    }
  }

  isLiveAIRunning() {
    return !!(
      (this.aiPose && this.aiPose.isActive) ||
      document.body.classList.contains('live-ar-active') ||
      document.body.classList.contains('live-ai-active')
    );
  }

  log(msg) {
    const logBox = document.getElementById('log');
    if (!logBox) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `> ${msg}`;
    logBox.prepend(entry);
    while (logBox.children.length > 40) {
      logBox.removeChild(logBox.lastChild);
    }
  }

  // =========================================================================
  // 1. CAMERA PASSTHROUGH (FIXED TRANSPARENCY + FALLBACKS)
  // =========================================================================
  attachStreamToCameraFeeds(stream) {
    const leftEl = document.getElementById('camera-feed-left');
    const rightEl = document.getElementById('camera-feed-right');
    const container = document.getElementById('camera-container');
    if (container) container.style.display = 'flex';

    [leftEl, rightEl].forEach((el) => {
      if (!el) return;
      if (el.srcObject !== stream) {
        el.srcObject = stream;
      }
      el.setAttribute('playsinline', '');
      el.setAttribute('autoplay', '');
      el.muted = true;
      el.play().catch(() => {});
    });

    document.documentElement.classList.add('camera-active');
    document.body.classList.add('camera-active');
    this.scene.enableARMode();
  }

  applyVRCameraProjection() {
    if (!this.scene || !this.scene.camera || !this.scene.renderer) return;
    const width = this.scene.container?.clientWidth || window.innerWidth || 1;
    const height = this.scene.container?.clientHeight || window.innerHeight || 1;
    const targetFov = this.vrFov || VR_CAMERA_FOV;

    this.scene.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (this.scene.camera.fov !== targetFov) {
      this.scene.camera.fov = targetFov;
    }
    this.scene.camera.aspect = width / Math.max(1, height);
    this.scene.camera.updateProjectionMatrix();
  }

  async resetCameraWideAngle(stream) {
    if (!stream || typeof stream.getVideoTracks !== 'function') return;
    const [track] = stream.getVideoTracks();
    if (!track || typeof track.getCapabilities !== 'function') return;
    try {
      const capabilities = track.getCapabilities();
      if (capabilities && capabilities.zoom !== undefined) {
        const minZoom = (typeof capabilities.zoom === 'object' ? capabilities.zoom.min : capabilities.zoom) || 1.0;
        await track.applyConstraints({ advanced: [{ zoom: minZoom }] });
        this.log(`<span style='color:#2ecc71;'>📷 Kamera vidvinkel-zoom: ${Number(minZoom).toFixed(1)}x</span>`);
      }
    } catch (err) {
      console.warn('[VR CAMERA] Kunde inte återställa min-zoom:', err);
    }
  }

  async startCameraPassThrough() {
    if (this.xr && this.xr.xrSession) return null;

    const leftEl = document.getElementById('camera-feed-left');
    if (this.passthroughStream && this.passthroughStream.active) {
      await this.resetCameraWideAngle(this.passthroughStream);
      this.attachStreamToCameraFeeds(this.passthroughStream);
      if (!this.isLiveAIRunning()) this.startHandTracking(leftEl);
      return this.passthroughStream;
    }

    let stream = null;
    this.isSyntheticPassthrough = false;

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
          },
          audio: false
        });
      } catch (errEnv) {
        console.warn('[VR CAMERA] Bakre 1080p-kamera nekad/ej tillgänglig, provar generell 1080p-kamera:', errEnv);
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 }
            },
            audio: false
          });
        } catch (errHD) {
          console.warn('[VR CAMERA] HD-kamera nekad/ej tillgänglig, provar standardkamera:', errHD);
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          } catch (errAny) {
            console.warn('[VR CAMERA] Kamera blockerad/saknas, startar syntetisk pass-through:', errAny);
            this.isSyntheticPassthrough = true;
            stream = this.xr.createSyntheticCameraStream(640, 480);
          }
        }
      }
    } else {
      this.isSyntheticPassthrough = true;
      stream = this.xr.createSyntheticCameraStream(640, 480);
    }

    if (stream) {
      if (!this.isSyntheticPassthrough) {
        await this.resetCameraWideAngle(stream);
      }
      this.passthroughStream = stream;
      if (this.xr) {
        this.xr.videoStream = stream;
        this.xr.isSimulatedCamera = this.isSyntheticPassthrough;
      }
      this.attachStreamToCameraFeeds(stream);
      if (!this.isLiveAIRunning()) {
        this.startHandTracking(leftEl);
      }
      const badge = document.getElementById('vr-cam-status');
      if (badge) {
        badge.textContent = this.isSyntheticPassthrough ? '📷 Kamera: Demo' : '📷 Kamera: LIVE';
      }
    }
    return stream;
  }

  stopCameraPassThrough() {
    this.stopHandTracking();
    const leftEl = document.getElementById('camera-feed-left');
    const rightEl = document.getElementById('camera-feed-right');

    [leftEl, rightEl].forEach((el) => {
      if (!el) return;
      try { el.pause(); } catch (_) {}
      el.srcObject = null;
    });

    if (this.passthroughStream) {
      if (typeof this.passthroughStream.getTracks === 'function') {
        this.passthroughStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
      if (typeof this.passthroughStream._cleanup === 'function') {
        try { this.passthroughStream._cleanup(); } catch (_) {}
      }
      this.passthroughStream = null;
    }

    if (this.xr) {
      if (this.xr.videoStream && typeof this.xr.videoStream.getTracks === 'function') {
        this.xr.videoStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
      this.xr.videoStream = null;
      this.xr.useCamera = false;
    }

    const container = document.getElementById('camera-container');
    if (container) container.style.display = 'none';
    document.documentElement.classList.remove('camera-active');
    document.body.classList.remove('camera-active');
  }

  initStereoVRMode() {
    document.documentElement.classList.add('vr-headset-session', 'vr-ar-passthrough');
    document.body.classList.add('vr-headset-session', 'vr-ar-passthrough');
    this.enableStereoVR();
    this.scene.enableARMode();
    this.togglePlaceMode(true);
    this.updateDisplay();
    this.updateAimVisuals();
  }

  toggleStereoSplit() {
    if (this.xr && this.xr.xrSession) {
      this.showHudToast('Avsluta WebXR först för att byta delad skärm', '#f1c40f');
      return;
    }
    if (this.isStereoVR) {
      this.disableStereoVR();
      document.body.classList.add('vr-mono-mode');
      document.documentElement.classList.add('vr-mono-mode');
      this.showHudToast('👁️ Mono AR-vy', '#3498db');
    } else {
      document.body.classList.remove('vr-mono-mode');
      document.documentElement.classList.remove('vr-mono-mode');
      this.enableStereoVR();
      this.showHudToast('🥽 Stereo Split-Screen VR', '#2ecc71');
    }
    const splitBtn = document.getElementById('vr-btn-stereo');
    if (splitBtn) {
      splitBtn.textContent = this.isStereoVR ? '🥽 Stereo: PÅ' : '📱 Vy: Mono';
      splitBtn.classList.toggle('active-pill', this.isStereoVR);
    }
    this.scene.enableARMode();
    this.updateAimVisuals();
    this.updateProjectors();
    window.dispatchEvent(new Event('resize'));
  }

  toggleHudVisibility() {
    this.hudHidden = !this.hudHidden;
    document.body.classList.toggle('vr-hud-hidden', this.hudHidden);
    const btn = document.getElementById('vr-btn-hide-hud');
    if (btn) {
      btn.textContent = this.hudHidden ? '👁️ Visa HUD' : '👁️ Dölj HUD';
    }
  }

  async toggleFullscreenAndLandscape() {
    try {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
        if (screen.orientation && screen.orientation.lock) {
          await screen.orientation.lock('landscape').catch(() => {});
        }
      } else if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
        if (screen.orientation && screen.orientation.unlock) {
          try { screen.orientation.unlock(); } catch (_) {}
        }
      }
    } catch (e) {
      this.showHudToast('Vrid telefonen till liggande för VR-glasögon', '#f1c40f');
    }
  }

  // =========================================================================
  // 2. DOM API EXPOSURE & TACTILE HANDLERS
  // =========================================================================
  initDOM() {
    window.toggleBattery = () => {
      const res = this.fsm.toggleBattery();
      this.updateDisplay();
      return res;
    };
    window.toggleCassette = () => {
      const res = this.fsm.toggleCassette();
      this.updateDisplay();
      return res;
    };
    window.toggleCartridge = () => this.toggleCartridge();
    window.toggleSafety = () => {
      if (!this.fsm.hasBattery) {
        this.showHudToast('🔋 Sätt i batteri först!', '#f1c40f');
      }
      const res = this.fsm.toggleSafety();
      this.updateDisplay();
      if (res) {
        this.showHudToast(
          this.fsm.isSafe ? '🔒 SÄKRAD' : (this.fsm.functionCheckMode ? '⚠️ OSÄKRAD (FUNK. KONTROLL)' : '🔓 OSÄKRAD'),
          this.fsm.isSafe ? '#2ecc71' : '#f1c40f'
        );
      }
      return res;
    };
    window.toggleFunctionCheck = () => this.toggleFunctionCheck();
    window.activateStealth = () => this.fsm.activateStealth();
    window.toggleClothing = () => this.fsm.toggleClothing();
    window.toggleScenario = () => this.toggleScenario();
    window.startScenario = () => this.startScenario();
    window.stopScenario = () => this.stopScenario();
    window.pressSingleWarning = () => {
      this.animateWarningButtons();
      if (!this.fsm.hasBattery) {
        this.showHudToast('🔋 Sätt i batteri först!', '#f1c40f');
      } else if (this.fsm.isSafe && !this.fsm.isFunkLocked && this.fsm.displayState !== 'FUNK_MODE') {
        this.showHudToast('🔓 Osäkra eller aktivera Funk. Kontroll först!', '#f1c40f');
      }
      return this.fsm.pressSingleWarning();
    };
    window.pressDualWarning = () => {
      this.animateWarningButtons();
      if (!this.fsm.hasBattery) {
        this.showHudToast('🔋 Sätt i batteri först!', '#f1c40f');
      }
      return this.fsm.pressDualWarning();
    };
    window.pressTrigger = () => this.handleTrigger();
    window.performKontaktstot = () => this.fsm.performKontaktstot();
    window.resetSimulator = () => this.resetSimulator();
    window.startRealPersonAI = () => this.startRealPersonAI();
    window.stopRealPersonAI = () => this.stopRealPersonAI();
    window.openScenarioModal = () => this.openModal('scenario-modal');
    window.startXR = (type) => this.startWebXR(type);
    window.togglePlaceMode = () => this.togglePlaceMode();
    window.confirmPlacement = () => this.confirmPlacement();
    window.initGyro = () => this.initGyro();
    window.openModal = (id) => this.openModal(id);
    window.closeModal = (id) => this.closeModal(id);
    window.toggleVoice = () => this.voice.toggle();
    window.testVoiceCommand = (cmd) => this.voice.simulateCommand(cmd);
    window.updateUI = () => this.updateDisplay();
    window.triggerFire = () => this.triggerFireInput();
    window.triggerSafetyToggle = () => this.triggerSafetyInput();
    window.triggerArc = () => this.triggerArcInput();
    window.triggerCartridgeToggle = () => this.triggerCartridgeInput();
    window.startCameraPassThrough = () => this.startCameraPassThrough();
    window.stopCameraPassThrough = () => this.stopCameraPassThrough();
    window.syncWeaponOverlays = (fsm) => this.syncWeaponOverlays(fsm);
    window.syncActiveCartridgeFromFSM = (fsm) => this.syncActiveCartridgeFromFSM(fsm);
    window.onChamberFired = (ch, fsm) => this.onChamberFired(ch, fsm);
    window.resetWeaponPhase4 = (fsm) => this.resetWeaponPhase4(fsm);
    window.updateWeaponPose = () => this.updateWeaponPose();
  }

  initFSMSubscriptions() {
    this.fsm.subscribe((event, fsm, payload) => {
      if (event === 'LOG') {
        this.log(payload.message);
      } else if (event === 'BATTERY_CHANGED') {
        const bEl = document.getElementById('stat-battery');
        if (bEl) {
          bEl.textContent = fsm.hasBattery ? '🔋 Batteri i' : '🔋 Batteri ur';
          bEl.classList.toggle('ok', fsm.hasBattery);
        }
        const btnBatt = document.getElementById('btn-battery');
        if (btnBatt) btnBatt.style.borderColor = fsm.hasBattery ? '#2ecc71' : '';
        this.updateDisplay();
      } else if (event === 'CASSETTE_CHANGED') {
        const cEl = document.getElementById('stat-cassette');
        const hasLoaded = fsm.chamber1 === ChamberState.LOADED;
        if (cEl) {
          cEl.textContent = hasLoaded ? '⏏️ Kassetter i' : '⏏️ Kassetter ur';
          cEl.classList.toggle('ok', hasLoaded);
        }
        const btnCass = document.getElementById('btn-cassette');
        if (btnCass) btnCass.style.borderColor = hasLoaded ? '#2ecc71' : '';
        if (fsm.chamber1 === ChamberState.EMPTY || (fsm.chamber1 === ChamberState.LOADED && fsm.chamber2 === ChamberState.LOADED && fsm.shotsFired === 0)) {
          this.liveWires = [];
          this.scene.clearWiresAndDarts();
          this.scene.resetTarget();
          this.stopScenario();
        }
        this.updateDisplay();
      } else if (event === 'SAFETY_CHANGED') {
        if (window.state) window.state.isSafe = !!fsm.isSafe;
        const sSwitch = document.getElementById('safety-switch');
        const sLabel = document.getElementById('safety-label');
        if (sSwitch) sSwitch.classList.toggle('unsafe', !fsm.isSafe);
        if (sLabel) sLabel.textContent = fsm.isSafe ? 'SÄKRAD' : 'OSÄKRAD';
        this.updateDisplay();
      } else if (event === 'FUNCTION_CHECK_CHANGED') {
        if (window.state) window.state.functionCheckMode = !!fsm.functionCheckMode;
        const warnBtn = document.getElementById('btn-warn');
        if (warnBtn) {
          warnBtn.classList.toggle('active-funk', !!fsm.functionCheckMode);
          warnBtn.style.borderColor = fsm.functionCheckMode ? '#f1c40f' : '';
        }
        this.updateDisplay();
      } else if (event === 'CHAMBER_CHANGED') {
        this.isFiring = !!fsm.isFiring;
        this.syncWeaponOverlays(this.fsm);
        this.updateAimVisuals();
        this.updateDisplay();
      } else if (event === 'DISPLAY_CHANGED') {
        this.updateDisplay();
      } else if (event === 'STEALTH_CHANGED') {
        this.updateDisplay();
      } else if (event === 'SCENARIO_CHANGED') {
        this.isScenarioActive = payload.isScenarioActive;
        const btn = document.getElementById('btn-scenario');
        if (btn) {
          btn.textContent = this.isScenarioActive ? '⏸️ Stoppa' : '🚨 Angrepp';
          btn.classList.toggle('active-attack', this.isScenarioActive);
        }
      } else if (event === 'CYCLE_STARTED') {
        this.log(`<span style='color:#3498db'>${payload.message} ⚡</span>`);
        if (this._wireArcPulseInterval) {
          clearInterval(this._wireArcPulseInterval);
          this._wireArcPulseInterval = null;
        }
        this.startWarningArcHaptics();
        this._cidActiveCycleCount = 1;
        this.syncWeaponOverlays(this.fsm, 1);

        const hasTargetWires = this.hasEmbeddedWiresInTarget();
        if (payload.type === 'DARTS') {
          const canvas = document.getElementById('three-canvas');
          if (canvas) canvas.classList.add('flash');

          // Om 3D-trådar sitter i målet: visa kontinuerlig högspänningsbåge mellan pilarna under 5s-cykeln
          if (!this.isLiveAIRunning() && this.scene && Array.isArray(this.scene.activeWires) && this.scene.activeWires.length >= 2) {
            const pulse3DWireArc = () => {
              const wires = this.scene.activeWires;
              if (!this.fsm.cycleTimer || !wires || wires.length < 2) return;
              const w1 = wires[wires.length - 2];
              const w2 = wires[wires.length - 1];
              const p1 = new THREE.Vector3();
              const p2 = new THREE.Vector3();
              if (w1?.wireAnchor) w1.wireAnchor.getWorldPosition(p1);
              if (w2?.wireAnchor) w2.wireAnchor.getWorldPosition(p2);
              if (p1.distanceToSquared(p2) > 0.0004) {
                this.scene.spawnElectricArc(p1, p2, true);
              }
            };
            pulse3DWireArc();
            this._wireArcPulseInterval = setInterval(pulse3DWireArc, 220);

            if (!this.isTased && !this.scene.isTased) {
              this.scene.startWarningArc();
            }
          }
          this.startWeaponArcEffect();

          if (hasTargetWires) {
            this.sendFirebaseLiveHit('LJUSBÅGE / ELCHOCK');
          }
        } else if (payload.type !== 'DRIVE_STUN') {
          this.scene.startWarningArc();
          this.startWeaponArcEffect();
          if (hasTargetWires) {
            this.sendFirebaseLiveHit('LJUSBÅGE');
          }
        } else {
          this.startWeaponArcEffect();
        }

        this.audio.startElectricSound();
        const dEl = document.getElementById('taser-display');
        if (dEl) {
          const isFunk = payload.isFunk && (this.fsm.isFunkLocked || this.fsm.displayState === 'FUNK_MODE') && !this.fsm.isSafe;
          dEl.classList.toggle('oled-inverted', !!isFunk);
          dEl.classList.toggle('funk-mode', !!isFunk);
          dEl.classList.toggle('inverted', !!isFunk);
          document.body.classList.toggle('function-check-active', !!isFunk);
          dEl.innerHTML = `5 SEK<br>CYKEL: 1`;
        }
      } else if (event === 'CYCLE_TICK') {
        const tickCount = Number(payload.count) || 1;
        this._cidActiveCycleCount = tickCount;
        this.syncWeaponOverlays(this.fsm, tickCount);
        const dEl = document.getElementById('taser-display');
        if (dEl) dEl.innerHTML = `5 SEK<br>CYKEL: ${tickCount}`;
      } else if (event === 'CYCLE_ENDED') {
        if (this._wireArcPulseInterval) {
          clearInterval(this._wireArcPulseInterval);
          this._wireArcPulseInterval = null;
        }
        this._cidActiveCycleCount = 0;
        const canvas = document.getElementById('three-canvas');
        if (canvas) canvas.classList.remove('flash');
        this.scene.stopWarningArc();
        this.stopWeaponArcEffect();
        this.stopWarningArcHaptics();
        this.audio.stopElectricSound();
        this.updateDisplay();
        this.syncWeaponOverlays(this.fsm, 0);
      } else if (event === 'RESET') {
        if (this._wireArcPulseInterval) {
          clearInterval(this._wireArcPulseInterval);
          this._wireArcPulseInterval = null;
        }
        this._cidActiveCycleCount = 0;
        document.body.classList.remove('function-check-active');
        this.hideNMIOverlay();
        this.isFiring = false;
        this.scene.stopWarningArc();
        this.stopWeaponArcEffect();
        this.stopWarningArcHaptics();
        this.aimX = 50;
        this.aimY = 50;
        this.tilt = 0;
        if (window.state) window.state.tilt = 0;
        this.warningGiven = false;
        this.updateWarningUI();
        this.scene.resetTarget();
        this.syncDistanceFromTarget();
        this.updateDisplay();
        this.stopScenario();
        this.syncWeaponOverlays(this.fsm, 0);
      }
    });
  }

  initInputs() {
    if (this.xr) {
      this.xr.onPhysicalTilt = (dir, gamma) => this.handlePhysicalTilt(dir, gamma);
    }

    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission !== 'function' &&
      !this.xr.gyroEnabled
    ) {
      this.initGyro(true);
    }

    const unlockSensorsAndAudio = () => {
      this.audio.init();
      if (this.audio.silentAudioEl) {
        this.audio.silentAudioEl.play().catch(() => {});
      }
      if (!this.xr.gyroEnabled) {
        this.initGyro(true);
      }
      // Restart video playback if autoplay was blocked until gesture
      ['camera-feed-left', 'camera-feed-right'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && el.srcObject && el.paused) {
          el.play().catch(() => {});
        }
      });
    };
    window.addEventListener('pointerdown', unlockSensorsAndAudio, { once: true });

    // Touch aiming when gyro isn't driving orientation
    const viewport = document.getElementById('viewport');
    if (viewport) {
      const handleTouchAim = (touch) => {
        if (this.xr.gyroEnabled || this.xr.placeMode || this.xr.xrSession || this.isStereoVR) return;
        const rect = viewport.getBoundingClientRect();
        this.aimX = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100));
        this.aimY = Math.max(0, Math.min(100, ((touch.clientY - rect.top) / rect.height) * 100));
        this.updateAimVisuals();
      };
      viewport.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) handleTouchAim(e.touches[0]);
      }, { passive: true });
      viewport.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) handleTouchAim(e.touches[0]);
      }, { passive: true });
    }

    // Compact weapon HUD bindings
    this.setupTactileButton('btn-trigger', () => this.handleTrigger());
    this.setupTactileButton('btn-cassette', () => window.toggleCassette());
    this.setupTactileButton('btn-battery', () => window.toggleBattery());
    this.setupTactileButton('btn-warn', () => this.toggleFunctionCheck());
    this.setupTactileButton('btn-reset', () => this.resetSimulator());
    this.setupTactileButton('btn-fail-reset', () => this.resetSimulator());
    this.setupTactileButton('btn-voice', () => this.voice.toggle());
    this.setupTactileButton('btn-scenario', () => this.toggleScenario());
    this.setupTactileButton('warn-left', () => window.pressSingleWarning(), { preventDefaultOnDown: true });
    this.setupTactileButton('warn-right', () => window.pressSingleWarning(), { preventDefaultOnDown: true });
    this.setupTactileButton('safety-switch', () => window.toggleSafety(), { preventDefaultOnDown: true });

    // Top VR quick-bar controls
    this.setupTactileButton('vr-btn-gamepad', () => this.openGamepadCalibration(), { preventDefaultOnDown: true });
    this.setupTactileButton('vr-btn-place', () => {
      if (this.isLiveAIRunning()) {
        this.showHudToast('Avsluta Live AI först för att placera 3D-mål', '#f1c40f');
        return;
      }
      if (this.isPlacementActive()) {
        this.confirmPlacement();
      } else {
        this.togglePlaceMode();
      }
    }, { preventDefaultOnDown: true });
    this.setupTactileButton('vr-btn-stereo', () => this.toggleStereoSplit(), { preventDefaultOnDown: true });
    this.setupTactileButton('vr-btn-webxr', () => {
      if (this.xr && this.xr.xrSession) {
        this.xr.endXRSession();
      } else {
        this.openModal('scenario-modal');
      }
    }, { preventDefaultOnDown: true });
    this.setupTactileButton('vr-btn-live-ai', () => {
      if (this.isLiveAIRunning()) {
        this.stopRealPersonAI();
      } else {
        this.startRealPersonAI();
      }
    }, { xrAction: true });
    this.setupTactileButton('vr-btn-voice', () => this.voice.toggle(), { preventDefaultOnDown: true });
    this.setupTactileButton('vr-btn-gyro', () => this.initGyro(), { preventDefaultOnDown: true });
    this.setupTactileButton('vr-btn-hand', () => this.cycleHandPreference(), { preventDefaultOnDown: true });
    this.updateHandPreferenceUI();
    this.setupTactileButton('vr-btn-weapon-mode', () => this.toggleWeaponLockMode(), { preventDefaultOnDown: true });
    this.updateWeaponModeUI();
    this.updateWeaponTrackBadge();
    this.setupTactileButton('vr-btn-fullscreen', () => this.toggleFullscreenAndLandscape(), { useClick: true });
    this.setupTactileButton('vr-btn-hide-hud', () => this.toggleHudVisibility(), { preventDefaultOnDown: true });

    // Bluetooth Gamepad Calibration ("MAPPA KNAPPAR") controls
    this.setupTactileButton('btn-close-gamepad', () => this.closeModal('gamepad-modal'), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-close-gamepad-footer', () => this.closeModal('gamepad-modal'), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-gp-reset-map', () => this.resetGamepadMapping(), { preventDefaultOnDown: true });
    document.querySelectorAll('#gamepad-map-list .gp-map-row').forEach((row) => {
      this.setupTactileButton(row, () => {
        const action = row.getAttribute('data-map-action');
        this.startGamepadButtonListen(action);
      }, { preventDefaultOnDown: true });
    });
    const chkDebugHud = document.getElementById('chk-bt-debug-hud');
    if (chkDebugHud) {
      this._showBtDebugHud = chkDebugHud.checked;
      chkDebugHud.addEventListener('change', () => {
        this._showBtDebugHud = !!chkDebugHud.checked;
        this.updateBluetoothStatusUI(this._getActiveGamepad());
      });
    }
    this.updateGamepadMappingUI();

    // WebXR & Live AI grip actions
    this.setupTactileButton('btn-place-xr', () => this.confirmPlacement(), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-xr-move-target', () => this.togglePlaceMode(), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-xr-exit', () => {
      if (this.xr && this.xr.xrSession) {
        this.xr.endXRSession();
      } else {
        this.onXRSessionEnd();
      }
    }, { preventDefaultOnDown: true });
    this.setupTactileButton('btn-live-ar-exit', () => this.stopRealPersonAI(), { preventDefaultOnDown: true });

    // Scenario Modal buttons
    this.setupTactileButton('btn-close-scenario', () => this.closeModal('scenario-modal'), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-cancel-scenario', () => this.closeModal('scenario-modal'), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-start-real-person-xr', () => this.startRealPersonAI(), {
      xrAction: true,
      loadingText: '⏳ STARTAR LIVE AI...'
    });
    this.setupTactileButton('btn-xr-static', () => this.startWebXR('static'), {
      xrAction: true,
      loadingText: '⏳ STARTAR AR...'
    });
    this.setupTactileButton('btn-xr-moving', () => this.startWebXR('moving'), {
      xrAction: true,
      loadingText: '⏳ STARTAR AR...'
    });
    this.setupTactileButton('btn-xr-charging', () => this.startWebXR('charging'), {
      xrAction: true,
      loadingText: '⏳ STARTAR AR...'
    });

    // Modal backdrop close
    document.querySelectorAll('.modal-overlay').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          if (performance.now() - (this._lastModalOpenAt || 0) < 420) return;
          this.closeModal(modal.id);
        }
      });
    });

    // Floor placement tap
    const placementTarget = viewport || this.scene.renderer.domElement;
    if (placementTarget) {
      placementTarget.addEventListener('pointerdown', (e) => {
        if (!this.xr.isPlacing || !this.xr.placeMode) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;
        if (this.xr.xrSession) {
          this.confirmPlacement();
        } else {
          const rect = viewport ? viewport.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
          const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
          const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
          const hits = this.scene.setPlacementFromScreen(x, y);
          if (hits.length > 0 && this.scene.placementMarker) {
            this.scene.placementMarker.position.copy(hits[0].point);
            this.scene.placementMarker.position.y += 0.01;
            this.scene.placementMarker.visible = true;
          }
        }
      });
    }

    // Protect DOM overlay buttons from triggering WebXR scene select
    document.addEventListener('beforexrselect', (e) => {
      if (
        e.target &&
        e.target.closest &&
        e.target.closest('#main-container, .taser-device, .sim-controls, #vr-top-bar, #btn-place-xr, .modal-overlay, #fail-overlay, button, .action-btn, .safety-switch, .warning-btn')
      ) {
        e.preventDefault();
      }
    }, true);

    // Sync Three.js 78° FOV & sharp DPR on resize / orientation change
    const syncProjectionOnResize = () => {
      if (this.scene) this.scene.onResize();
      this.applyVRCameraProjection();
      this.updateProjectors();
    };
    window.addEventListener('resize', syncProjectionOnResize);
    window.addEventListener('orientationchange', () => {
      setTimeout(syncProjectionOnResize, 120);
    });

    // Bluetooth Gamepad status & Keyboard/VR Remote controls
    this.initBluetoothAndKeyboardInputs();
  }

  setupTactileButton(elementOrId, callback, options = {}) {
    const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!el) return;

    const isXrAction = !!options.xrAction;
    const useClick = !!options.useClick || options.triggerOn === 'click';
    const preventDefaultOnDown = !!options.preventDefaultOnDown;
    let lastActionTs = 0;
    let lastPointerDownAt = 0;

    if (!el.dataset.origHtml) {
      el.dataset.origHtml = el.innerHTML;
    }

    const showLoadingFeedback = () => {
      if (options.loadingText) {
        if (!el.dataset.origHtml) el.dataset.origHtml = el.innerHTML;
        el.innerHTML = `${options.loadingText}<span>Initierar session, vänta ett ögonblick...</span>`;
        el.classList.add('is-loading');
      }
    };

    const clearPress = () => el.classList.remove('active-press');
    el.addEventListener('pointerup', clearPress);
    el.addEventListener('pointercancel', clearPress);
    el.addEventListener('pointerleave', clearPress);

    if (isXrAction || useClick) {
      let firedInCurrentGesture = false;
      let downX = 0;
      let downY = 0;
      let pointerActive = false;

      const triggerAction = (e) => {
        const now = Date.now();
        if (now - lastActionTs < 350) return;
        lastActionTs = now;
        pointerActive = false;
        clearPress();
        showLoadingFeedback();

        if (this.audio) this.audio.init();
        if (navigator.vibrate) {
          try { navigator.vibrate(16); } catch (_) {}
        }
        try {
          callback(e);
        } catch (err) {
          console.error('[VR Button Error]', el.id, err);
        }
      };

      const onGestureDown = (x, y) => {
        firedInCurrentGesture = false;
        pointerActive = true;
        downX = x;
        downY = y;
        el.classList.add('active-press');
        if (isXrAction) showLoadingFeedback();
      };

      el.addEventListener('touchstart', (e) => {
        const t = e.touches && e.touches[0];
        onGestureDown(t ? t.clientX : 0, t ? t.clientY : 0);
      }, { passive: true });

      el.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (e.pointerType !== 'touch' || !pointerActive) {
          onGestureDown(e.clientX || 0, e.clientY || 0);
        }
      });

      el.addEventListener('touchend', (e) => {
        if (!firedInCurrentGesture) {
          firedInCurrentGesture = true;
          if (e.cancelable) e.preventDefault();
          triggerAction(e);
        }
      }, { passive: false });

      el.addEventListener('pointerup', (e) => {
        if (!firedInCurrentGesture) {
          firedInCurrentGesture = true;
          triggerAction(e);
        }
      });

      el.addEventListener('pointercancel', (e) => {
        if (pointerActive && !firedInCurrentGesture) {
          const dist = Math.hypot((e.clientX || downX) - downX, (e.clientY || downY) - downY);
          if (dist < 22) {
            firedInCurrentGesture = true;
            triggerAction(e);
            return;
          }
        }
        pointerActive = false;
        clearPress();
      });

      el.addEventListener('click', (e) => {
        if (!firedInCurrentGesture) {
          firedInCurrentGesture = true;
          triggerAction(e);
        }
      });
      return;
    }

    const fireAction = (e) => {
      const now = Date.now();
      if (now - lastActionTs < 200) return;
      lastActionTs = now;

      if (this.audio) this.audio.init();
      if (navigator.vibrate) {
        try { navigator.vibrate(14); } catch (_) {}
      }
      el.classList.add('active-press');
      setTimeout(clearPress, 160);

      try {
        callback(e);
      } catch (err) {
        console.error('[VR Button Error]', el.id, err);
      }
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (preventDefaultOnDown && e.cancelable) e.preventDefault();
      e.stopPropagation();
      lastPointerDownAt = performance.now();
      fireAction(e);
    });

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sinceDown = performance.now() - lastPointerDownAt;
      if (e.detail === 0 || sinceDown > 1200) {
        fireAction(e);
      }
    });
  }

  // =========================================================================
  // 3. VR CONTROLLER, BLUETOOTH GAMEPAD & KEYBOARD INPUTS
  // =========================================================================
  triggerFireInput() {
    if (this.isFiring || this.fsm.isFiring) return;
    if (!this.fsm.hasBattery) {
      this.fsm.hasBattery = true;
      this.fsm.chamber1 = ChamberState.LOADED;
      this.fsm.chamber2 = ChamberState.LOADED;
      this.updateDisplay();
    }
    if (this.fsm.isSafe) {
      this.fsm.toggleSafety();
      this.updateDisplay();
    }
    this.audio.init();
    this.handleTrigger();
  }

  triggerSafetyInput() {
    if (!this.fsm.hasBattery) this.fsm.hasBattery = true;
    window.toggleSafety();
  }

  isPlacementActive() {
    if (this.isLiveAIRunning()) return false;
    return !!(this.xr && (this.xr.isPlacing || this.xr.placeMode || !this.xr.figureLocked));
  }

  hasEmbeddedWiresInTarget() {
    if (this.isLiveAIRunning()) {
      return Array.isArray(this.liveWires) && this.liveWires.some(
        (ws) => ws && Array.isArray(ws.probes) && (ws.probes[0]?.isHit || ws.probes[1]?.isHit)
      );
    }
    return !!(
      this.scene &&
      Array.isArray(this.scene.activeWires) &&
      this.scene.activeWires.length >= 2 &&
      (this.isTased || this.scene.isTased || this.fsm.shotsFired > 0)
    );
  }

  sendFirebaseLiveHit(sourceLabel = 'TRÄFF') {
    if (!this.liveARRoomCode || !window.taserFirebase || typeof window.taserFirebase.reportLiveHit !== 'function') {
      return;
    }
    const now = performance.now();
    if (now - (this._lastFirebaseHitSentTs || 0) < 450) return;
    this._lastFirebaseHitSentTs = now;

    window.taserFirebase.reportLiveHit(this.liveARRoomCode).then((ok) => {
      if (ok) {
        this.log(`<span style='color:#2ecc71; font-weight:bold;'>📡 ${sourceLabel} skickad till Markör (Kod ${this.liveARRoomCode})!</span>`);
      }
    });
    const badgeEl = document.getElementById('live-ar-room-badge');
    if (badgeEl) {
      badgeEl.classList.add('hit-sent');
      setTimeout(() => badgeEl.classList.remove('hit-sent'), 2500);
    }
  }

  playPlacementConfirmSound() {
    this.audio.init();
    const ctx = this.audio && this.audio.audioCtx;
    if (!ctx) return;
    try {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(660, t);
      osc.frequency.setValueAtTime(990, t + 0.06);
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      osc.connect(gain);
      gain.connect(this.audio.pannerNode || ctx.destination);
      osc.start(t);
      osc.stop(t + 0.15);
    } catch (_) {}
  }

  syncDistanceFromTarget() {
    if (!this.scene || !this.scene.taserGroup) return this.currentDistance || 3.0;
    const target = this.scene.taserGroup;
    const isXR = !!(this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting);
    const camPos = isXR
      ? this.scene.renderer.xr.getCamera(this.scene.camera).position
      : { x: 0, z: 3.0 };
    const dist = Math.hypot(target.position.x - camPos.x, target.position.z - camPos.z);
    if (!isNaN(dist) && dist > 0.1) {
      this.currentDistance = Math.max(0.8, Math.min(10.0, dist));
    }
    return this.currentDistance;
  }

  triggerArcInput() {
    if (!this.fsm.hasBattery) this.fsm.hasBattery = true;
    this.audio.init();
    if (this.fsm.cycleTimer) return false;

    if (!this.fsm.isSafe && this.hasEmbeddedWiresInTarget()) {
      if (this.fsm.startCycle('Återaktiverar ljusbåge i trådarna (5 sek)...', 'DARTS')) {
        this.showHudToast('⚡ Ljusbågscykel i trådar (5 sek)', '#a8eb12');
        return true;
      }
    }

    if (!window.pressSingleWarning()) {
      return window.pressDualWarning();
    }
    return true;
  }

  triggerCartridgeInput() {
    if (!this.fsm.hasBattery) this.fsm.hasBattery = true;
    window.toggleCassette();
    this.syncActiveCartridgeFromFSM(this.fsm);
    this.updateAimVisuals();
    this.updateDisplay();
    const loadedBoth = this.fsm.chamber1 === ChamberState.LOADED && this.fsm.chamber2 === ChamberState.LOADED;
    if (loadedBoth && !this.fsm.isSafe) {
      this.showHudToast(`⏏️ Kammare ${this.fsm.activeChamber} aktiv`, '#3498db');
    } else if (loadedBoth) {
      this.showHudToast('📥 Kassetter laddade (2/2 redo)', '#2ecc71');
    } else {
      this.showHudToast('⏏️ Kassetter utmatade', '#bdc3c7');
    }
  }

  handleGamepadFireEdge() {
    if (this.isPlacementActive()) {
      this.confirmPlacement();
      return;
    }
    this.triggerFireInput();
  }

  handleGamepadFireHold(now) {
    if (this.isPlacementActive()) return;
    if (this.isFiring || this.fsm.isFiring || this.fsm.isSafe || !this.fsm.hasBattery) return;
    if (this.fsm.shotsFired <= 0) return;
    if (this.fsm.cycleTimer) return;
    if (!this._fireBtnHeldSince || (now - this._fireBtnHeldSince) < 380) return;

    this.audio.init();
    if (this.fsm.startCycle('Håller inne: Elchock (Arc) aktiv!', 'DARTS')) {
      this.showHudToast('⚡ Elchock (Arc) hålls inne', '#a8eb12');
    }
  }

  _getActiveGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const gamepads = navigator.getGamepads();
    if (!gamepads) return null;
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (gp && gp.connected) return gp;
    }
    return null;
  }

  markBtActive(signalText = null, gp = null) {
    this._btInputDetected = true;
    const activeGp = gp || this._getActiveGamepad();
    this.updateBluetoothStatusUI(activeGp);
    if (signalText) {
      this.updateBtDebugReadout(signalText, activeGp);
    }
  }

  updateBluetoothStatusUI(activeGp) {
    const connected = !!activeGp;
    const btReady = connected || this._btInputDetected;
    this._btConnected = connected;

    const topBadge = document.getElementById('vr-bt-status');
    if (topBadge) {
      topBadge.textContent = btReady ? '🎮 BT REDO' : '🎮 BT: AV';
      topBadge.classList.toggle('bt-connected', btReady);
    }

    const hudBadge = document.getElementById('vr-joystick-status');
    if (hudBadge) {
      hudBadge.textContent = '🎮 BT REDO';
      hudBadge.style.display = btReady ? 'inline-flex' : 'none';
    }

    const debugHud = document.getElementById('vr-bt-debug-hud');
    if (debugHud) {
      debugHud.style.display = (btReady && this._showBtDebugHud) ? 'inline-flex' : 'none';
    }
  }

  updateBtDebugReadout(signalOrBtn, gp = null) {
    let label = this._lastBtSignalText || 'BT: VÄNTAR PÅ SIGNAL...';
    let isFreshSignal = false;

    if (typeof signalOrBtn === 'string' && signalOrBtn.trim()) {
      label = signalOrBtn.trim();
      this._lastBtSignalText = label;
      isFreshSignal = true;
    } else if (typeof signalOrBtn === 'number') {
      label = `BT: KNAPP ${signalOrBtn}`;
      this._lastBtSignalText = label;
      isFreshSignal = true;
    } else if (!this._lastBtSignalText) {
      label = (gp || this._btInputDetected) ? '🎮 BT REDO — VÄNTAR...' : 'BT: VÄNTAR PÅ SIGNAL...';
    }

    const debugHud = document.getElementById('vr-bt-debug-hud');
    if (debugHud) {
      debugHud.textContent = label;
      if (isFreshSignal) {
        debugHud.classList.add('active-input');
        if (this._btDebugFadeTimer) clearTimeout(this._btDebugFadeTimer);
        this._btDebugFadeTimer = setTimeout(() => {
          debugHud.classList.remove('active-input');
        }, 550);
      }
    }

    const modalLive = document.getElementById('vr-bt-debug-live');
    if (modalLive && isFreshSignal) {
      modalLive.textContent = label;
    }

    const modalAxes = document.getElementById('vr-bt-debug-axes');
    if (modalAxes) {
      if (gp) {
        const a0 = Number(gp.axes?.[0] || 0).toFixed(2);
        const a1 = Number(gp.axes?.[1] || 0).toFixed(2);
        const shortId = String(gp.id || 'BT-Kontroll').slice(0, 26);
        modalAxes.textContent = `Spak: Ax0=${a0} | Ax1=${a1} — Ansluten: ${shortId}`;
      } else if (this._btInputDetected) {
        modalAxes.textContent = 'HID Tangentbordsläge aktivt — Spak/Knappar redo';
      } else {
        modalAxes.textContent = 'Spak: Ax0=0.00 | Ax1=0.00 — Status: Ej ansluten';
      }
    }
  }

  saveGamepadMap() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(GAMEPAD_MAP_STORAGE_KEY, JSON.stringify(GAMEPAD_MAP));
      }
    } catch (err) {
      console.warn('[VR Gamepad] Kunde inte spara mappning:', err);
    }
  }

  updateGamepadMappingUI() {
    const actions = ['fire', 'safety', 'cassette', 'arc', 'confirm', 'reset'];
    actions.forEach((action) => {
      const badge = document.getElementById(`gp-badge-${action}`);
      const row = document.querySelector(`#gamepad-map-list .gp-map-row[data-map-action="${action}"]`);
      const isListening = this._calibratingAction === action;
      if (row) row.classList.toggle('listening', isListening);
      if (badge) {
        badge.textContent = isListening ? 'TRYCK KNAPP...' : formatMappingLabel(GAMEPAD_MAP[action]);
      }
    });
  }

  openGamepadCalibration() {
    this._calibratingAction = null;
    this.updateGamepadMappingUI();
    const gp = this._getActiveGamepad();
    this.updateBluetoothStatusUI(gp);
    this.updateBtDebugReadout(null, gp);
    this.openModal('gamepad-modal');
  }

  startGamepadButtonListen(action) {
    if (!action || !(action in GAMEPAD_MAP)) return;
    this._calibratingAction = this._calibratingAction === action ? null : action;
    this.updateGamepadMappingUI();
    if (this._calibratingAction) {
      this.showHudToast('🕹️ Tryck nu på valfri knapp på din BT-kontroll...', '#f1c40f');
    }
  }

  resetGamepadMapping() {
    GAMEPAD_MAP.fire = DEFAULT_GAMEPAD_MAP.fire;
    GAMEPAD_MAP.safety = DEFAULT_GAMEPAD_MAP.safety;
    GAMEPAD_MAP.cassette = DEFAULT_GAMEPAD_MAP.cassette;
    GAMEPAD_MAP.arc = DEFAULT_GAMEPAD_MAP.arc;
    GAMEPAD_MAP.confirm = [...DEFAULT_GAMEPAD_MAP.confirm];
    GAMEPAD_MAP.reset = DEFAULT_GAMEPAD_MAP.reset;
    this._calibratingAction = null;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(GAMEPAD_MAP_STORAGE_KEY);
      }
    } catch (_) {}
    this.updateGamepadMappingUI();
    this.showHudToast('♻️ Standardmappning återställd', '#2ecc71');
  }

  initBluetoothAndKeyboardInputs() {
    const handleConnected = (gp) => {
      this._btInputDetected = true;
      this.updateBluetoothStatusUI(gp);
      this.updateBtDebugReadout('🎮 BT REDO — GAMEPAD ANSLUTEN', gp);
      this.log(`<span style='color:#2ecc71; font-weight:bold;'>🎮 BT REDO</span>${gp?.id ? ` (${gp.id})` : ''}`);
    };

    window.addEventListener('gamepadconnected', (e) => handleConnected(e.gamepad));
    window.addEventListener('gamepaddisconnected', (e) => {
      if (e.gamepad) this._prevGamepadButtonsMap.delete(e.gamepad.index);
      const remaining = this._getActiveGamepad();
      this.updateBluetoothStatusUI(remaining);
      this.updateBtDebugReadout(null, remaining);
    });

    const initialGp = this._getActiveGamepad();
    if (initialGp) {
      handleConnected(initialGp);
    } else {
      this.updateBluetoothStatusUI(null);
    }

    const DEBOUNCE_MS = 160;
    const isArrowKey = (k, c) =>
      k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight' ||
      c === 'ArrowUp' || c === 'ArrowDown' || c === 'ArrowLeft' || c === 'ArrowRight';

    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      const key = e.key || '';
      const code = e.code || '';
      const kl = key.toLowerCase();
      const now = performance.now();

      // 1. RETURNKEY (ENTER) -> Aktivera 5-sekunders ljusbågscykel (ALDRIG klicka fokuserad knapp)
      if (key === 'Enter' || code === 'Enter' || code === 'NumpadEnter') {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        if (e.repeat) return;
        this.markBtActive(`BT: KEY ${code === 'NumpadEnter' ? 'NumpadEnter' : 'Enter'} -> LJUSBÅGE`);
        this.triggerArcInput();
        return;
      }

      // 2. SPACE -> Fastställ målposition i placeringsläge (eller Avfyra i skarpt läge)
      if (key === ' ' || key === 'Spacebar' || code === 'Space') {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA' && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        if (e.repeat) return;
        if (this.isPlacementActive()) {
          this.markBtActive('BT: KEY Space -> MÅL LÅST');
          this.confirmPlacement();
        } else if (now - this._lastControllerActionTs >= DEBOUNCE_MS) {
          this._lastControllerActionTs = now;
          this.markBtActive('BT: KEY Space -> AVFYRA');
          this.triggerFireInput();
        }
        return;
      }

      // 3. PILTANGENTER (HID) -> Styr dummyn på golvet i placeringsläge
      if (isArrowKey(key, code)) {
        e.preventDefault();
        e.stopPropagation();
        const arrowCode = code.startsWith('Arrow') ? code : key;
        this._heldKeys.add(arrowCode);
        if (this.isPlacementActive()) {
          if (!e.repeat) {
            this.markBtActive(`BT: KEY ${arrowCode} -> FLYTTA MÅL`);
          }
        } else if (arrowCode === 'ArrowUp') {
          this.currentDistance = Math.max(1.5, Number(((this.currentDistance || 3.0) - 0.2).toFixed(2)));
          this.markBtActive('BT: KEY ArrowUp -> AVSTÅND');
          this.updateAimVisuals();
        } else if (arrowCode === 'ArrowDown') {
          this.currentDistance = Math.min(7.0, Number(((this.currentDistance || 3.0) + 0.2).toFixed(2)));
          this.markBtActive('BT: KEY ArrowDown -> AVSTÅND');
          this.updateAimVisuals();
        }
        return;
      }

      // 4. ÖVRIGA HID-KNAPPAR (Game mode / Bluetooth remote)
      if (kl === 'a' || key === 'AudioVolumeUp' || key === 'VolumeUp' || code === 'AudioVolumeUp' || code === 'VolumeUp') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (now - this._lastControllerActionTs >= DEBOUNCE_MS) {
          this._lastControllerActionTs = now;
          this.markBtActive(`BT: KEY ${key === ' ' ? 'Space' : key} -> AVFYRA`);
          this.handleGamepadFireEdge();
        }
      } else if (kl === 'b' || key === 'Escape' || key === 'Backspace' || key === 'BrowserBack' || key === 'GoBack') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        const gpModal = document.getElementById('gamepad-modal');
        const scModal = document.getElementById('scenario-modal');
        if (key === 'Escape' && gpModal && gpModal.style.display === 'flex') {
          this.closeModal('gamepad-modal');
          return;
        }
        if (key === 'Escape' && scModal && scModal.style.display === 'flex') {
          this.closeModal('scenario-modal');
          return;
        }
        if (now - this._lastControllerActionTs >= DEBOUNCE_MS) {
          this._lastControllerActionTs = now;
          this.markBtActive(`BT: KEY ${key} -> SÄKRING`);
          this.triggerSafetyInput();
        }
      } else if (kl === 'c' || kl === 'd' || key === 'AudioVolumeDown' || key === 'VolumeDown' || code === 'VolumeDown' || key === 'MediaPlayPause' || code === 'MediaPlayPause') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (now - this._lastControllerActionTs >= DEBOUNCE_MS) {
          this._lastControllerActionTs = now;
          this.markBtActive(`BT: KEY ${key} -> LJUSBÅGE`);
          this.triggerArcInput();
        }
      } else if (kl === 'q' || kl === 'x' || key === 'Tab' || key === 'MediaNextTrack' || key === 'MediaPreviousTrack' || code === 'MediaTrackNext' || code === 'MediaTrackPrevious') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (now - this._lastControllerActionTs >= DEBOUNCE_MS) {
          this._lastControllerActionTs = now;
          this.markBtActive(`BT: KEY ${key} -> KASSETT`);
          this.triggerCartridgeInput();
        }
      } else if (kl === 'r') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        this.markBtActive('BT: KEY r -> ÅTERSTÄLL');
        this.resetSimulator();
      }
    }, { capture: true, passive: false });

    window.addEventListener('keyup', (e) => {
      if (e.code) this._heldKeys.delete(e.code);
      if (e.key) this._heldKeys.delete(e.key);
    }, { capture: true });

    window.addEventListener('blur', () => {
      this._heldKeys.clear();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._heldKeys.clear();
    });
  }

  pollGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const gamepads = navigator.getGamepads();
    if (!gamepads) return;

    const activeList = [];
    for (let g = 0; g < gamepads.length; g++) {
      if (gamepads[g] && gamepads[g].connected) {
        activeList.push(gamepads[g]);
      }
    }

    const primaryGp = activeList[0] || null;
    if (Boolean(primaryGp) !== this._btConnected) {
      this.updateBluetoothStatusUI(primaryGp);
    }
    if (!primaryGp) {
      this._gpMoveX = 0;
      this._gpMoveY = 0;
      this.updateBtDebugReadout(null, null);
      return;
    }

    const now = performance.now();
    const isPlacing = this.isPlacementActive();

    for (const gp of activeList) {
      const buttons = gp.buttons || [];
      let prev = this._prevGamepadButtonsMap.get(gp.index);
      if (!prev || prev.length !== buttons.length) {
        prev = new Array(buttons.length).fill(false);
        this._prevGamepadButtonsMap.set(gp.index, prev);
      }

      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        const isPressed = !!(btn && (btn.pressed || btn.value > 0.5));
        const wasPressed = !!prev[i];

        if (isPressed && !wasPressed) {
          this._btInputDetected = true;

          // Kalibreringsläge: fånga nästa knapptryck till vald funktion
          if (this._calibratingAction) {
            const action = this._calibratingAction;
            GAMEPAD_MAP[action] = i;
            this.saveGamepadMap();
            this._calibratingAction = null;
            this.updateGamepadMappingUI();
            const labels = {
              fire: 'Avfyra / Elchock',
              safety: 'Osäkra / Säkra',
              cassette: 'Byt kassett',
              arc: 'Ljusbågscykel / Arc',
              confirm: 'Fastställ mål',
              reset: 'Återställ'
            };
            this.markBtActive(`BT: KNAPP ${i} -> ${labels[action] || action}`, gp);
            this.showHudToast(`✅ ${labels[action] || action} → Knapp ${i}`, '#2ecc71');
            prev[i] = true;
            return;
          }

          // Edge-detection på mappade knappar + L3/R3 spakklick
          if (isButtonMapped(i, GAMEPAD_MAP.confirm)) {
            if (isPlacing) {
              this.markBtActive('BT: SPAKKLICK -> MÅL LÅST', gp);
              this.confirmPlacement();
            } else {
              this.markBtActive(`BT: KNAPP ${i} -> SPAKKLICK`, gp);
            }
          } else if (isButtonMapped(i, GAMEPAD_MAP.fire)) {
            this._fireBtnHeldSince = now;
            this.markBtActive(`BT: KNAPP ${i} -> ${isPlacing ? 'MÅL LÅST' : 'AVFYRA'}`, gp);
            this.handleGamepadFireEdge();
          } else if (isButtonMapped(i, GAMEPAD_MAP.safety)) {
            this.markBtActive(`BT: KNAPP ${i} -> SÄKRING`, gp);
            this.triggerSafetyInput();
          } else if (isButtonMapped(i, GAMEPAD_MAP.cassette)) {
            this.markBtActive(`BT: KNAPP ${i} -> KASSETT`, gp);
            this.triggerCartridgeInput();
          } else if (isButtonMapped(i, GAMEPAD_MAP.arc)) {
            this.markBtActive(`BT: KNAPP ${i} -> LJUSBÅGE`, gp);
            this.triggerArcInput();
          } else if (isButtonMapped(i, GAMEPAD_MAP.reset)) {
            this.markBtActive(`BT: KNAPP ${i} -> ÅTERSTÄLL`, gp);
            this.resetSimulator();
          } else if (i >= 12 && i <= 15 && isPlacing) {
            const dirLabel = i === 12 ? 'UPP' : (i === 13 ? 'NER' : (i === 14 ? 'VÄNSTER' : 'HÖGER'));
            this.markBtActive(`BT: D-PAD ${dirLabel} -> FLYTTA MÅL`, gp);
          } else {
            this.markBtActive(`BT: KNAPP ${i}`, gp);
          }
        } else if (isPressed && wasPressed && !this._calibratingAction) {
          if (isButtonMapped(i, GAMEPAD_MAP.fire)) {
            this.handleGamepadFireHold(now);
          }
        } else if (!isPressed && wasPressed) {
          if (isButtonMapped(i, GAMEPAD_MAP.fire)) {
            this._fireBtnHeldSince = 0;
          }
        }

        prev[i] = isPressed;
      }
    }

    // Analog spak (axes[0], axes[1] med deadzone 0.15) + Digital D-pad (knapp 12..15)
    const DEADZONE = 0.15;
    const applyDeadzone = (rawVal) => {
      const v = Number(rawVal) || 0;
      if (Math.abs(v) <= DEADZONE) return 0;
      return (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
    };

    const axes = primaryGp.axes || [];
    const stickX = applyDeadzone(axes[0]);
    const stickY = applyDeadzone(axes[1]);

    const isDpadSpecial = (idx) =>
      isButtonMapped(idx, GAMEPAD_MAP.fire) ||
      isButtonMapped(idx, GAMEPAD_MAP.safety) ||
      isButtonMapped(idx, GAMEPAD_MAP.cassette) ||
      isButtonMapped(idx, GAMEPAD_MAP.arc) ||
      isButtonMapped(idx, GAMEPAD_MAP.confirm) ||
      isButtonMapped(idx, GAMEPAD_MAP.reset);

    const isBtnDown = (idx) => {
      if (isDpadSpecial(idx)) return false;
      const b = primaryGp.buttons && primaryGp.buttons[idx];
      return !!(b && (b.pressed || b.value > 0.5));
    };

    const dpadX = (isBtnDown(15) ? 1 : 0) - (isBtnDown(14) ? 1 : 0);
    const dpadY = (isBtnDown(13) ? 1 : 0) - (isBtnDown(12) ? 1 : 0);

    if (isPlacing) {
      this._gpMoveX = Math.max(-1, Math.min(1, stickX !== 0 ? stickX : dpadX));
      this._gpMoveY = Math.max(-1, Math.min(1, stickY !== 0 ? stickY : dpadY));
      if ((Math.abs(this._gpMoveX) > 0.05 || Math.abs(this._gpMoveY) > 0.05) && now - (this._lastMoveSignalLogTs || 0) > 450) {
        this._lastMoveSignalLogTs = now;
        this.markBtActive('BT: SPAK -> FLYTTA MÅL', primaryGp);
      }
    } else {
      this._gpMoveX = 0;
      this._gpMoveY = 0;

      const aimStepX = stickX !== 0 ? stickX * 1.15 : dpadX * 0.95;
      const aimStepY = stickY !== 0 ? stickY * 1.15 : dpadY * 0.95;

      if (aimStepX !== 0 || aimStepY !== 0) {
        if (this.xr && this.xr.gyroEnabled) {
          this._aimTrimX = Math.max(-40, Math.min(40, (this._aimTrimX || 0) + aimStepX));
          this._aimTrimY = Math.max(-40, Math.min(40, (this._aimTrimY || 0) + aimStepY));
        }
        this.aimX = Math.max(5, Math.min(95, (this.aimX ?? 50) + aimStepX));
        this.aimY = Math.max(5, Math.min(95, (this.aimY ?? 50) + aimStepY));
        this.updateAimVisuals();
      }
    }

    // Uppdatera spakvärden live om kalibreringsfönstret är öppet
    const gamepadModal = document.getElementById('gamepad-modal');
    if (gamepadModal && gamepadModal.style.display === 'flex') {
      const modalAxes = document.getElementById('vr-bt-debug-axes');
      if (modalAxes) {
        const a0 = Number(axes[0] || 0).toFixed(2);
        const a1 = Number(axes[1] || 0).toFixed(2);
        const shortId = String(primaryGp.id || 'BT-Kontroll').slice(0, 26);
        modalAxes.textContent = `Spak: Ax0=${a0} | Ax1=${a1} — Ansluten: ${shortId}`;
      }
    }
  }

  updatePlacementMovement(dt, activeCamera) {
    if (!this.isPlacementActive() || !this.scene || !this.scene.taserGroup) return;

    const target = this.scene.taserGroup;
    const marker = this.scene.placementMarker;
    const isXRPresenting = !!(this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting);

    this.scene.set3DVisibility(true);
    if (marker) {
      marker.visible = true;
      marker.scale.set(1.8, 1.8, 1.8);
    }

    const hidX = (this._heldKeys.has('ArrowRight') ? 1 : 0) - (this._heldKeys.has('ArrowLeft') ? 1 : 0);
    const hidY = (this._heldKeys.has('ArrowDown') ? 1 : 0) - (this._heldKeys.has('ArrowUp') ? 1 : 0);
    const moveX = Math.max(-1, Math.min(1, (this._gpMoveX || 0) + hidX));
    const moveY = Math.max(-1, Math.min(1, (this._gpMoveY || 0) + hidY));
    const hasMove = Math.abs(moveX) > 0.01 || Math.abs(moveY) > 0.01;
    const MOVE_SPEED = 1.8; // m/s (1.5–2.0 m/s)

    if (isXRPresenting && activeCamera) {
      const camPos = activeCamera.position;
      if (hasMove) {
        if (!this._xrManualMoveUsed) {
          this._xrManualMoveUsed = true;
          if (marker && marker.visible) {
            target.position.set(marker.position.x, Math.max(0, marker.position.y - 0.015), marker.position.z);
          }
        }

        const fwd = this._xrFwdVec.set(0, 0, -1).applyQuaternion(activeCamera.quaternion);
        fwd.y = 0;
        if (fwd.lengthSq() < 0.001) fwd.set(0, 0, -1);
        fwd.normalize();

        const right = this._xrRightVecLocal.set(1, 0, 0).applyQuaternion(activeCamera.quaternion);
        right.y = 0;
        if (right.lengthSq() < 0.001) right.set(1, 0, 0);
        right.normalize();

        target.position.addScaledVector(right, moveX * MOVE_SPEED * dt);
        target.position.addScaledVector(fwd, -moveY * MOVE_SPEED * dt);

        // Kläm Z-djup från skytten till [1.5 m, 7.0 m] och sidled till [-4.0 m, +4.0 m]
        const relX = target.position.x - camPos.x;
        const relZ = target.position.z - camPos.z;
        const depth = Math.max(1.5, Math.min(7.0, relX * fwd.x + relZ * fwd.z));
        const lateral = Math.max(-4.0, Math.min(4.0, relX * right.x + relZ * right.z));
        target.position.x = camPos.x + fwd.x * depth + right.x * lateral;
        target.position.z = camPos.z + fwd.z * depth + right.z * lateral;
      } else if (!this._xrManualMoveUsed && marker && marker.visible) {
        target.position.set(marker.position.x, Math.max(0, marker.position.y - 0.015), marker.position.z);
      }

      target.lookAt(camPos.x, target.position.y, camPos.z);
      if (marker) {
        marker.position.set(target.position.x, target.position.y + 0.015, target.position.z);
        marker.rotation.set(0, 0, 0);
        marker.quaternion.identity();
        marker.updateMatrix();
        marker.updateMatrixWorld(true);
      }
      this.currentDistance = Math.max(1.5, Math.min(8.5, Math.hypot(target.position.x - camPos.x, target.position.z - camPos.z)));
      this.updateAimVisuals();
      return;
    }

    // Stereo / Mono VR (skytt förankrad på x=0, y=1.35, z=3.0)
    const SHOOTER_Z = 3.0;
    let nextX = target.position.x;
    let nextZ = target.position.z;

    if (hasMove) {
      nextX += moveX * MOVE_SPEED * dt;
      nextZ += moveY * MOVE_SPEED * dt;
    }

    const clampedDistZ = Math.max(1.5, Math.min(7.0, SHOOTER_Z - nextZ));
    nextZ = SHOOTER_Z - clampedDistZ;
    nextX = Math.max(-4.0, Math.min(4.0, nextX));

    target.position.set(nextX, 0, nextZ);
    target.lookAt(0, 0, SHOOTER_Z);
    if (marker) {
      marker.position.set(nextX, 0.015, nextZ);
    }

    const dist = Math.hypot(nextX, nextZ - SHOOTER_Z);
    this.currentDistance = Math.max(1.5, Math.min(8.5, dist));
    this.updateAimVisuals();
  }

  handleWebXRControllers(session) {
    if (!session || !session.inputSources) return;
    const now = performance.now();
    const DEBOUNCE_MS = 180;

    for (const source of session.inputSources) {
      const gp = source.gamepad;
      if (!gp || !gp.buttons) continue;
      const key = `${source.handedness || 'any'}_${source.targetRayMode || 'ray'}`;
      let prev = this._prevXRButtons.get(key);
      if (!prev || prev.length !== gp.buttons.length) {
        prev = new Array(gp.buttons.length).fill(false);
        this._prevXRButtons.set(key, prev);
      }

      for (let i = 0; i < Math.min(gp.buttons.length, 12); i++) {
        const b = gp.buttons[i];
        const pressed = !!(b && (b.pressed || b.value > 0.55));
        if (pressed && !prev[i] && (now - this._lastControllerActionTs >= DEBOUNCE_MS)) {
          this._lastControllerActionTs = now;
          if (i === 0 || i === 10 || i === 11) {
            if (this.isPlacementActive()) {
              this.confirmPlacement();
            } else if (i === 0) {
              this.triggerFireInput();
            }
          } else if (i === 1) {
            this.triggerArcInput();
          } else if (i === 4 || i === 5) {
            this.triggerSafetyInput();
          } else if (i === 3) {
            this.triggerCartridgeInput();
          }
        }
        prev[i] = pressed;
      }
    }
  }

  // =========================================================================
  // 4. BALLISTICS, TRIGGER, LIVE AI WIRES & FIREBASE MARKER SYNC
  // =========================================================================
  handleTrigger() {
    if (this.isFiring || this.fsm.isFiring || window.isFiring) return;
    if (this.isGameOver) {
      this.audio.init();
      this.showHudToast('⛔ Avtryckare spärrad — tryck Återställ', '#e74c3c');
      return;
    }
    if (!this.fsm.hasBattery) {
      this.audio.init();
      this.showHudToast('🔋 Sätt i batteri först!', '#f1c40f');
      return;
    }
    if (this.fsm.isSafe) {
      this.audio.init();
      this.showHudToast('🔒 Osäkra vapnet före avfyring!', '#f1c40f');
      return;
    }
    const chState = this.fsm.activeChamber === 1 ? this.fsm.chamber1 : this.fsm.chamber2;
    if (chState === ChamberState.EMPTY) {
      this.audio.init();
      this.showHudToast('⏏️ Ladda kassett först!', '#f1c40f');
    }

    this.audio.init();
    this.fsm.pressTrigger((firedChamber) => {
      this.audio.playPopSound();
      this.onChamberFired(firedChamber, this.fsm);

      const viewport = document.getElementById('viewport');
      const vHeight = viewport ? viewport.clientHeight : window.innerHeight || 720;
      const vWidth = viewport ? viewport.clientWidth : window.innerWidth || 1280;
      const activeTiltDeg = this.getEffectiveTiltDeg();

      const { ndc1, ndc2, spreadInfo } = this.ballistics.calculateNdcCoordinates(
        this.currentDistance,
        firedChamber,
        vHeight,
        activeTiltDeg,
        vWidth
      );

      const isLiveARActive = this.isLiveAIRunning();
      let hitResult;

      if (isLiveARActive) {
        const liveDist = (this.aiPose && this.aiPose.isPersonDetected && typeof this.aiPose.estimatedDistance === 'number')
          ? this.aiPose.estimatedDistance
          : (this.currentDistance || 3.0);
        const liveDropPx = this.ballistics.calculateLiveSpreadPx(liveDist, firedChamber, vHeight);
        const liveHits = this.aiPose
          ? this.aiPose.checkScreenHit(this.aimX, this.aimY, liveDropPx, activeTiltDeg)
          : null;
        hitResult = liveHits || { hit1: null, hit2: null, hitWall1: true, hitWall2: true };
        this.spawnLiveARWires(firedChamber, hitResult, liveDropPx);
      } else {
        hitResult = this.scene.fireDarts({
          ndc1,
          ndc2,
          chamber: firedChamber,
          distance: this.currentDistance,
          tiltDeg: activeTiltDeg
        });
      }

      const evalResult = this.ballistics.evaluateHit({
        hit1: hitResult.hit1,
        hit2: hitResult.hit2,
        hitWall1: hitResult.hitWall1,
        hitWall2: hitResult.hitWall2,
        currentDistance: this.currentDistance,
        heavyClothing: this.fsm.heavyClothing,
        isLiveAR: isLiveARActive,
        ballisticSpreadCm: spreadInfo.spreadCm
      });

      if (evalResult.success) {
        this.isTased = true;
        this.log(`<span style='color:#2ecc71; font-weight:bold;'>NMI UPPNÅDD!</span> ${evalResult.reason}`);
        this.showNMIOverlay(true, evalResult.reason, evalResult.spreadCm);
        this.fsm.startCycle('NMI påbörjad...', 'DARTS');

        // Send live hit to connected Marker in Firestore
        if (isLiveARActive && this.liveARRoomCode) {
          this.sendFirebaseLiveHit('Markör-träff');
        }

        if (this.threatInterval) clearInterval(this.threatInterval);
        const sub = document.getElementById('subtitle-overlay');
        if (sub) sub.style.display = 'none';
        this.audio.suspectSpeak('Aaaargh!');
        this.scene.triggerNMI(() => {
          this.audio.playBodyFallSound();
        });
      } else {
        this.log(`<span style='color:#c0392b; font-weight:bold;'>NMI MISSLYCKADES!</span> ${evalResult.reason}`);
        this.showNMIOverlay(false, evalResult.reason, evalResult.spreadCm);
        const canvas = document.getElementById('three-canvas');
        if (canvas) {
          canvas.classList.remove('fail-flash');
          void canvas.offsetWidth;
          canvas.classList.add('fail-flash');
        }
      }

      return evalResult;
    });

    this.isFiring = !!this.fsm.isFiring;
    this.updateDisplay();
  }

  spawnLiveARWires(chamber, hitResult, dropPx) {
    const hudCanvas = document.getElementById('hud-canvas');
    const vp = document.getElementById('viewport');
    const w = (hudCanvas && hudCanvas.clientWidth) || (vp && vp.clientWidth) || window.innerWidth || 640;
    const h = (hudCanvas && hudCanvas.clientHeight) || (vp && vp.clientHeight) || window.innerHeight || 480;

    const coords = hitResult && hitResult.screenCoords ? hitResult.screenCoords : null;
    const box = (coords && coords.box) || (this.aiPose && typeof this.aiPose.getCurrentScreenBox === 'function' ? this.aiPose.getCurrentScreenBox() : null);

    const d1X = coords ? coords.d1X : ((this.aimX / 100) * w);
    const d1Y = coords ? coords.d1Y : ((this.aimY / 100) * h);
    const tiltRad = (this.getEffectiveTiltDeg() * Math.PI) / 180;
    const d2X = coords ? coords.d2X : (d1X - Math.sin(tiltRad) * dropPx);
    const d2Y = coords ? coords.d2Y : (d1Y + Math.cos(tiltRad) * dropPx);

    const buildProbe = (px, py, hitObj, slot) => {
      const insideBox = !!(box && box.width > 0 && box.height > 0 &&
        px >= box.left && px <= box.left + box.width &&
        py >= box.top && py <= box.top + box.height);
      const attachedToBox = insideBox && !!(hitObj || (this.aiPose && this.aiPose.isPersonDetected));
      return {
        slot,
        chamber,
        attachedToBox,
        relX: attachedToBox ? Math.max(0.05, Math.min(0.95, (px - box.left) / box.width)) : 0.5,
        relY: attachedToBox ? Math.max(0.05, Math.min(0.95, (py - box.top) / box.height)) : 0.35,
        normX: Math.max(0, Math.min(1, px / Math.max(1, w))),
        normY: Math.max(0, Math.min(1, py / Math.max(1, h))),
        screenX: px,
        screenY: py,
        isHit: !!hitObj,
        isApproved: !!(hitObj && hitObj.isApproved),
        firedAt: performance.now()
      };
    };

    this.liveWires.push({
      chamber,
      firedAt: performance.now(),
      probes: [
        buildProbe(d1X, d1Y, hitResult ? hitResult.hit1 : null, 'top'),
        buildProbe(d2X, d2Y, hitResult ? hitResult.hit2 : null, 'bottom')
      ]
    });
  }

  // =========================================================================
  // 5. DUAL-EYE STEREO & MONO 2D HUD RENDERING (LIVE AI + LASERS + WIRES)
  // =========================================================================
  updateProjectors() {
    const flashlight = document.getElementById('flashlight');
    const laserGreen = document.getElementById('laser-green');
    const laserRed = document.getElementById('laser-red');

    const isLiveAR = this.isLiveAIRunning();
    const isXRPresenting = !!(this.scene && this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting);
    const hasCartridge = (this.fsm.chamber1 === ChamberState.LOADED || this.fsm.chamber2 === ChamberState.LOADED);
    const flashlightOn = !this.fsm.isSafe && this.fsm.hasBattery && !this.fsm.stealthMode;
    const shouldShow = isLiveAR ? flashlightOn : (flashlightOn && hasCartridge);

    // Hide CSS single-screen elements in Stereo VR / Live-AR so #hud-canvas & 3D dots render cleanly per-eye
    if (isLiveAR || this.isStereoVR || isXRPresenting) {
      if (flashlight) flashlight.style.display = 'none';
      if (laserGreen) laserGreen.style.display = 'none';
      if (laserRed) laserRed.style.display = 'none';
    } else {
      if (flashlight) flashlight.style.display = flashlightOn ? 'block' : 'none';
      if (laserGreen) laserGreen.style.display = shouldShow ? 'block' : 'none';
      if (laserRed) laserRed.style.display = shouldShow ? 'block' : 'none';
    }

    this.drawHudCanvas(flashlightOn, shouldShow);
  }

  drawHudCanvas(flashlightOn, lasersOn) {
    const hudCanvas = document.getElementById('hud-canvas');
    if (!hudCanvas) return;
    const ctx = hudCanvas.getContext('2d');
    if (!ctx) return;

    const w = hudCanvas.clientWidth || window.innerWidth || 0;
    const h = hudCanvas.clientHeight || window.innerHeight || 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetW = Math.max(1, Math.round(w * dpr));
    const targetH = Math.max(1, Math.round(h * dpr));

    if (hudCanvas.width !== targetW || hudCanvas.height !== targetH) {
      hudCanvas.width = targetW;
      hudCanvas.height = targetH;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);

    const isXRPresenting = !!(this.scene && this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting);
    const isLiveAR = this.isLiveAIRunning();
    const isStereo = this.isStereoVR && !isXRPresenting;
    const hasWires = Array.isArray(this.liveWires) && this.liveWires.length > 0;

    // Outside WebXR: draw reticle / flashlight / Live AI HUD onto #hud-canvas
    if (isXRPresenting) return;
    if (!isLiveAR && !isStereo && !flashlightOn && !lasersOn) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Smooth visual spread & tilt interpolation shared across eyes
    const activeCh = this.fsm.activeChamber || 1;
    const liveDist = (isLiveAR && this.aiPose && this.aiPose.isPersonDetected && typeof this.aiPose.estimatedDistance === 'number')
      ? this.aiPose.estimatedDistance
      : (this.currentDistance || 3.0);
    const targetDrop = isLiveAR
      ? this.ballistics.calculateLiveSpreadPx(liveDist, activeCh, h)
      : this.ballistics.calculateSpread(liveDist, activeCh).visualDropPx;

    if (this._hudVisualDropPx === null || isNaN(this._hudVisualDropPx)) {
      this._hudVisualDropPx = targetDrop;
    } else {
      this._hudVisualDropPx += (targetDrop - this._hudVisualDropPx) * 0.35;
    }

    const targetTiltDeg = this.getEffectiveTiltDeg();
    let tiltDiff = targetTiltDeg - (this._hudTiltDeg || 0);
    while (tiltDiff > 180) tiltDiff -= 360;
    while (tiltDiff < -180) tiltDiff += 360;
    this._hudTiltDeg = (this._hudTiltDeg || 0) + tiltDiff * 0.35;

    const tiltRad = (this._hudTiltDeg * Math.PI) / 180;
    const drop = this._hudVisualDropPx;
    const dx = -Math.sin(tiltRad) * drop;
    const dy = Math.cos(tiltRad) * drop;

    const liveBox = (isLiveAR && this.aiPose && typeof this.aiPose.getCurrentScreenBox === 'function')
      ? this.aiPose.getCurrentScreenBox()
      : null;

    // Render helper per eye viewport (half-width in Stereo VR, full-width in Mono)
    const drawEyeOverlay = (eyeX0, eyeW, eyeH) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(eyeX0, 0, eyeW, eyeH);
      ctx.clip();

      const aimPctX = (typeof this.aimX === 'number' && !isNaN(this.aimX)) ? this.aimX : 50;
      const aimPctY = (typeof this.aimY === 'number' && !isNaN(this.aimY)) ? this.aimY : 50;
      const cx = eyeX0 + (aimPctX / 100) * eyeW;
      const cy = (aimPctY / 100) * eyeH;

      // 1. Tactical Flashlight glow (always safe on transparent passthrough)
      if (flashlightOn) {
        const beamRadius = Math.max(130, Math.min(eyeW, eyeH) * 0.45);
        const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, beamRadius);
        grad.addColorStop(0.0, isLiveAR ? 'rgba(255, 255, 240, 0.30)' : 'rgba(255, 255, 240, 0.16)');
        grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.06)');
        grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, beamRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // 2. Live AI Person Tracking Brackets in Stereo VR (single DOM overlay is hidden in stereo)
      if (isLiveAR && isStereo && liveBox) {
        const xScale = eyeW / Math.max(1, w);
        const camLeftEl = document.getElementById('camera-feed-left');
        const vidW = camLeftEl && camLeftEl.videoWidth ? camLeftEl.videoWidth : 16;
        const vidH = camLeftEl && camLeftEl.videoHeight ? camLeftEl.videoHeight : 9;
        const vidAspect = vidW / Math.max(1, vidH);
        const eyeAspect = eyeW / Math.max(1, eyeH);
        const renderedH = eyeAspect < vidAspect ? (eyeW / vidAspect) : eyeH;
        const yScale = renderedH / Math.max(1, h);
        const yOffset = (eyeH - renderedH) * 0.5;

        const drawCorners = (bx, by, bw, bh, strokeCol, fillCol) => {
          const sx = eyeX0 + bx * xScale;
          const sy = yOffset + by * yScale;
          const sw = bw * xScale;
          const sh = bh * yScale;
          const clen = Math.max(8, Math.min(sw, sh) * 0.24);
          if (fillCol) {
            ctx.fillStyle = fillCol;
            ctx.fillRect(sx, sy, sw, sh);
          }
          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(sx, sy + clen); ctx.lineTo(sx, sy); ctx.lineTo(sx + clen, sy);
          ctx.moveTo(sx + sw - clen, sy); ctx.lineTo(sx + sw, sy); ctx.lineTo(sx + sw, sy + clen);
          ctx.moveTo(sx, sy + sh - clen); ctx.lineTo(sx, sy + sh); ctx.lineTo(sx + clen, sy + sh);
          ctx.moveTo(sx + sw - clen, sy + sh); ctx.lineTo(sx + sw, sy + sh); ctx.lineTo(sx + sw, sy + sh - clen);
          ctx.stroke();
        };

        if (liveBox.torsoBox) {
          const tb = liveBox.torsoBox;
          drawCorners(tb.left, tb.top, tb.width, tb.height, 'rgba(46, 204, 113, 0.92)', 'rgba(46, 204, 113, 0.10)');
        }
        if (liveBox.headBox) {
          const hb = liveBox.headBox;
          drawCorners(hb.left, hb.top, hb.width, hb.height, 'rgba(231, 76, 60, 0.95)', null);
        }
        const labelX = eyeX0 + (liveBox.left + liveBox.width * 0.5) * xScale;
        const labelY = Math.max(22, yOffset + liveBox.top * yScale - 8);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
        ctx.fillRect(labelX - 36, labelY - 11, 72, 16);
        ctx.fillStyle = '#2ecc71';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`● ${(this.aiPose.estimatedDistance || 3.0).toFixed(1)} M`, labelX, labelY - 3);
      }

      // 3. Subtle VR Stereoscopic Reticle Ring (dämpad när 3D-handvapnets lasrar är aktiva)
      if (!isLiveAR && isStereo) {
        const hasHandWeapon = !!(this.weaponGroup && this.weaponGroup.visible);
        ctx.strokeStyle = hasHandWeapon
          ? 'rgba(0, 255, 136, 0.16)'
          : (lasersOn ? 'rgba(0, 255, 136, 0.48)' : 'rgba(241, 196, 15, 0.38)');
        ctx.lineWidth = hasHandWeapon ? 1.0 : 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, hasHandWeapon ? 8 : 12, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 4. Live-AR Lasers (Dynamic spread + smooth tilt rotation)
      if (isLiveAR && lasersOn) {
        ctx.save();
        ctx.shadowColor = '#00ff00';
        ctx.shadowBlur = 14;
        ctx.fillStyle = 'rgba(0, 255, 0, 0.42)';
        ctx.beginPath();
        ctx.arc(cx, cy, 9.0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#00ff00';
        ctx.beginPath();
        ctx.arc(cx, cy, 4.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        const pulse = 0.65 + 0.35 * Math.sin(performance.now() * 0.025);
        const rx = cx + dx;
        const ry = cy + dy;

        ctx.save();
        ctx.shadowColor = '#ff0000';
        ctx.shadowBlur = 14;
        ctx.fillStyle = `rgba(255, 0, 0, ${(0.42 * pulse).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(rx, ry, 9.0 * (0.9 + 0.15 * pulse), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255, 24, 24, ${pulse.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(rx, ry, 4.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 5. Live-AR Synchronized 2D Copper Wires, Probes & Electric Arcs
      if (isLiveAR && hasWires) {
        const now = performance.now();
        const xScale = isStereo ? (eyeW / Math.max(1, w)) : 1.0;
        const muzzleBaseX = eyeX0 + eyeW * 0.5;
        const muzzleBaseY = eyeH - 28;
        const cycleActive = !!this.fsm.cycleTimer;

        for (let wIdx = 0; wIdx < this.liveWires.length; wIdx++) {
          const wireSet = this.liveWires[wIdx];
          const ageMs = now - wireSet.firedAt;
          const resolvedPts = [];

          for (let pIdx = 0; pIdx < wireSet.probes.length; pIdx++) {
            const p = wireSet.probes[pIdx];
            let tx = eyeX0 + p.screenX * xScale;
            let ty = p.screenY;

            if (p.attachedToBox && liveBox && liveBox.width > 0 && liveBox.height > 0) {
              tx = eyeX0 + (liveBox.left + p.relX * liveBox.width) * xScale;
              ty = liveBox.top + p.relY * liveBox.height;
            }
            resolvedPts.push({ tx, ty, probe: p });

            const chamberOffX = wireSet.chamber === 1 ? -10 : 10;
            const slotOffY = p.slot === 'top' ? -4 : 4;
            const ox = muzzleBaseX + chamberOffX;
            const oy = muzzleBaseY + slotOffY;
            const midX = (ox + tx) * 0.5 + (p.slot === 'top' ? -7 : 7);
            const midY = (oy + ty) * 0.5 + 20;

            ctx.save();
            ctx.lineWidth = 1.8;
            ctx.strokeStyle = 'rgba(212, 132, 62, 0.92)';
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.quadraticCurveTo(midX, midY, tx, ty);
            ctx.stroke();

            ctx.fillStyle = '#e2e8f0';
            ctx.beginPath();
            ctx.arc(tx, ty, 3.2, 0, Math.PI * 2);
            ctx.fill();

            if (ageMs < 520) {
              const flashAlpha = Math.max(0, 1 - ageMs / 520);
              const radius = 14 + (1 - flashAlpha) * 22;
              const flashGrad = ctx.createRadialGradient(tx, ty, 1, tx, ty, radius);
              flashGrad.addColorStop(0.0, `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`);
              flashGrad.addColorStop(0.35, p.isHit ? `rgba(112, 214, 255, ${(0.95 * flashAlpha).toFixed(3)})` : `rgba(255, 170, 0, ${(0.85 * flashAlpha).toFixed(3)})`);
              flashGrad.addColorStop(1.0, 'rgba(56, 189, 248, 0)');
              ctx.fillStyle = flashGrad;
              ctx.beginPath();
              ctx.arc(tx, ty, radius, 0, Math.PI * 2);
              ctx.fill();
            }
            ctx.restore();
          }

          if (cycleActive && resolvedPts.length === 2 && resolvedPts[0].probe.isHit && resolvedPts[1].probe.isHit) {
            const pA = resolvedPts[0];
            const pB = resolvedPts[1];
            ctx.save();
            ctx.strokeStyle = '#70d6ff';
            ctx.shadowColor = '#38bdf8';
            ctx.shadowBlur = 10;
            ctx.lineWidth = 2.0;
            ctx.beginPath();
            ctx.moveTo(pA.tx, pA.ty);
            for (let st = 1; st < 6; st++) {
              const t = st / 6;
              ctx.lineTo(
                pA.tx + (pB.tx - pA.tx) * t + (Math.random() - 0.5) * 12,
                pA.ty + (pB.ty - pA.ty) * t + (Math.random() - 0.5) * 9
              );
            }
            ctx.lineTo(pB.tx, pB.ty);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      ctx.restore();
    };

    if (isStereo) {
      const halfW = w * 0.5;
      drawEyeOverlay(0, halfW, h);
      drawEyeOverlay(halfW, halfW, h);
      // Clean stereo divider line
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(halfW, 0);
      ctx.lineTo(halfW, h);
      ctx.stroke();
      ctx.restore();
    } else {
      drawEyeOverlay(0, w, h);
    }
  }

  // =========================================================================
  // 6. FUNCTION CHECK, DISPLAY & SCENARIO LOGIC (IDENTICAL TO MOBILE)
  // =========================================================================
  toggleFunctionCheck() {
    const active = this.fsm.toggleFunctionCheck();
    if (window.state) window.state.functionCheckMode = active;
    this.updateDisplay();
    if (active) {
      this.showHudToast(
        this.fsm.isSafe ? '⚠️ Funk. Kontroll vald — osäkra vapnet!' : '⚡ FUNKTIONSKONTROLL AKTIV',
        '#FCBE00'
      );
    } else {
      this.showHudToast('Funktionskontroll AV', '#bdc3c7');
    }
    return active;
  }

  toggleCartridge() {
    if (this.fsm.chamber1 === ChamberState.EMPTY && this.fsm.chamber2 === ChamberState.EMPTY) {
      const loaded = this.fsm.toggleCassette();
      this.updateDisplay();
      return loaded;
    }
    const switched = this.fsm.toggleCartridge();
    this.syncActiveCartridgeFromFSM(this.fsm);
    this.updateAimVisuals();
    this.updateDisplay();
    return switched;
  }

  getEffectiveTiltDeg() {
    const manualTilt = typeof this.tilt === 'number' && !isNaN(this.tilt) ? this.tilt : 0;
    const gyroRoll = (this._hasGyroRoll && typeof this._gyroContinuousRoll === 'number' && !isNaN(this._gyroContinuousRoll))
      ? this._gyroContinuousRoll
      : 0;
    let combined = manualTilt + gyroRoll;
    while (combined > 180) combined -= 360;
    while (combined < -180) combined += 360;
    return combined;
  }

  updateAimVisuals() {
    const isLiveAR = this.isLiveAIRunning();
    const activeDist = (isLiveAR && this.aiPose && this.aiPose.isPersonDetected && typeof this.aiPose.estimatedDistance === 'number')
      ? this.aiPose.estimatedDistance
      : (this.currentDistance || 3.0);

    const activeCh = this.fsm.activeChamber || 1;
    const spreadData = this.ballistics.calculateSpread(activeDist, activeCh);

    const distLabel = document.getElementById('dist-label');
    const spreadLabel = document.getElementById('spread-label');
    if (distLabel) distLabel.textContent = `${spreadData.distanceMeters.toFixed(1)} M`;
    if (spreadLabel) spreadLabel.textContent = `SPRIDNING: ${spreadData.spreadCm.toFixed(1)} CM (K${activeCh})`;

    const tiltDeg = this.getEffectiveTiltDeg();
    const tiltRad = (tiltDeg * Math.PI) / 180;
    const vp = document.getElementById('viewport');
    const vH = (vp && vp.clientHeight) || window.innerHeight || 760;
    const drop = isLiveAR
      ? this.ballistics.calculateLiveSpreadPx(activeDist, activeCh, vH)
      : spreadData.visualDropPx;
    const dx = -Math.sin(tiltRad) * drop;
    const dy = Math.cos(tiltRad) * drop;

    const laserRed = document.getElementById('laser-red');
    if (laserRed) {
      laserRed.style.left = `calc(50% + ${dx.toFixed(2)}px)`;
      laserRed.style.top = `calc(50% + ${dy.toFixed(2)}px)`;
    }
  }

  renderIconsHTML() {
    const renderBaySVG = (chamberState, isActive) => {
      const activeGlow = isActive ? 'active-bay' : '';
      if (chamberState === ChamberState.LOADED) {
        return `<svg class="cassette-svg loaded ${activeGlow}" viewBox="0 0 24 24" width="22" height="22"><rect x="2" y="2" width="20" height="20" rx="2" class="box" /></svg>`;
      }
      if (chamberState === ChamberState.FIRED) {
        return `<svg class="cassette-svg fired ${activeGlow}" viewBox="0 0 24 24" width="22" height="22"><rect x="2" y="2" width="20" height="20" rx="2" class="box" /><line x1="5" y1="5" x2="19" y2="19" class="cross" /><line x1="19" y1="5" x2="5" y2="19" class="cross" /></svg>`;
      }
      return `<svg class="cassette-svg empty ${activeGlow}" viewBox="0 0 24 24" width="22" height="22"><rect x="2" y="2" width="20" height="20" rx="2" class="box dashed" /><line x1="5" y1="19" x2="19" y2="5" class="slash" /></svg>`;
    };

    const isCh1Active = this.fsm.activeChamber === 1;
    const isCh2Active = this.fsm.activeChamber === 2;
    return `
      <div class="display-icons">
        <div class="chamber-col">
          ${renderBaySVG(this.fsm.chamber1, isCh1Active)}
          <div class="active-line ${isCh1Active ? 'show' : ''}"></div>
        </div>
        <div class="icon-battery-wrap full">
          <div class="batt-nub"></div>
          <div class="batt-body"></div>
        </div>
        <div class="chamber-col">
          ${renderBaySVG(this.fsm.chamber2, isCh2Active)}
          <div class="active-line ${isCh2Active ? 'show' : ''}"></div>
        </div>
      </div>
    `;
  }

  updateDisplay() {
    if (this.fsm.cycleTimer) return;
    this.updateAimVisuals();

    if (window.state) {
      window.state.isSafe = !!this.fsm.isSafe;
      window.state.functionCheckMode = !!this.fsm.functionCheckMode;
    }

    const dEl = document.getElementById('taser-display');
    if (!dEl) return;

    if (!this.fsm.hasBattery || this.fsm.isSafe) {
      dEl.innerHTML = '';
      dEl.className = 'display-screen';
      document.body.classList.remove('function-check-active');
      document.documentElement.classList.remove('function-check-active');
      this.updateProjectors();
      this.syncWeaponOverlays(this.fsm);
      return;
    }

    dEl.classList.toggle('dimmed', this.fsm.stealthMode);
    const isFunkMode = !!this.fsm.functionCheckMode;
    document.body.classList.toggle('function-check-active', isFunkMode);
    document.documentElement.classList.toggle('function-check-active', isFunkMode);

    dEl.classList.toggle('oled-inverted', isFunkMode);
    dEl.classList.toggle('funk-mode', isFunkMode);
    dEl.classList.toggle('inverted', isFunkMode);
    dEl.innerHTML = this.renderIconsHTML();

    this.updateProjectors();
    this.syncWeaponOverlays(this.fsm);
  }

  animateWarningButtons() {
    const l = document.getElementById('warn-left');
    const r = document.getElementById('warn-right');
    if (l) l.classList.add('active-press');
    if (r) r.classList.add('active-press');
    setTimeout(() => {
      if (l) l.classList.remove('active-press');
      if (r) r.classList.remove('active-press');
    }, 200);
  }

  showHudToast(message, accentColor = '#f1c40f') {
    const toast = document.getElementById('ar-hud-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.style.borderColor = accentColor;
    toast.style.color = accentColor;
    toast.style.display = 'inline-flex';
    if (this._hudToastTimer) clearTimeout(this._hudToastTimer);
    this._hudToastTimer = setTimeout(() => {
      toast.style.display = 'none';
    }, 2200);
  }

  showNMIOverlay(success, reason, spreadCm) {
    const overlay = document.getElementById('nmi-overlay');
    const title = document.getElementById('nmi-title');
    const distSpan = document.getElementById('nmi-dist');
    const spreadSpan = document.getElementById('nmi-spread');
    const reasonSpan = document.getElementById('nmi-reason');
    if (!overlay) return;

    distSpan.textContent = `${this.currentDistance.toFixed(1)} M`;
    spreadSpan.textContent = spreadCm ? `${spreadCm.toFixed(1)} CM` : '--';
    reasonSpan.textContent = reason;
    overlay.className = success ? '' : 'fail';
    title.textContent = success ? 'NMI UPPNÅDD' : 'INGEN VERKAN';
    overlay.style.display = 'block';

    if (this.nmiTimer) clearTimeout(this.nmiTimer);
    this.nmiTimer = setTimeout(() => {
      overlay.style.display = 'none';
    }, 3500);
  }

  hideNMIOverlay() {
    const overlay = document.getElementById('nmi-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  triggerFailState() {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.isScenarioActive = false;
    this.fsm.isScenarioActive = false;
    if (this.threatInterval) {
      clearInterval(this.threatInterval);
      this.threatInterval = null;
    }
    if (this.scene && this.scene.mixer) {
      this.scene.mixer.timeScale = 0.0;
    }
    this.audio.init();
    this.audio.suspectSpeak('Fick dig!');
    if (navigator.vibrate) {
      try { navigator.vibrate([250, 100, 250]); } catch (_) {}
    }
    const overlay = document.getElementById('fail-overlay');
    if (overlay) overlay.style.display = 'flex';
  }

  hideFailOverlay() {
    const overlay = document.getElementById('fail-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  updateWarningUI() {
    const badge = document.getElementById('hud-warning');
    if (badge) {
      badge.style.display = this.warningGiven ? 'inline-block' : 'none';
      if (this.warningGiven) badge.textContent = '⚠️ VARNING DELGIVEN';
    }
  }

  toggleScenario() {
    if (this.isGameOver) {
      this.resetSimulator();
      return;
    }
    if (this.isScenarioActive) {
      this.stopScenario();
    } else {
      this.startScenario();
    }
  }

  rollThreatWeapon() {
    const roll = Math.random();
    this.threatWeapon = roll < 0.4 ? 'KNIFE' : (roll < 0.7 ? 'BATON' : 'FISTS');
    if (this.scene) this.scene.setThreatWeapon(this.threatWeapon);
    return this.threatWeapon;
  }

  startScenario() {
    this.isScenarioActive = true;
    this.fsm.isScenarioActive = true;
    this.rollThreatWeapon();

    this.scene.set3DVisibility(true);
    if (this.scene.taserGroup) {
      this.scene.taserGroup.visible = true;
      if (this.scene.figureFallen) this.scene.resetTarget();

      if (this.xr && this.xr.xrSession) {
        const cam = this.scene.renderer.xr.getCamera(this.scene.camera);
        const distToCam = this.scene.taserGroup.position.distanceTo(cam.position);
        if (!this.scene.taserGroup.userData.startPos || distToCam < 0.8 || this.scene.taserGroup.position.lengthSq() === 0) {
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
          forward.y = 0;
          if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
          forward.normalize().multiplyScalar(3.0);
          this.scene.taserGroup.position.set(cam.position.x + forward.x, 0, cam.position.z + forward.z);
          this.scene.taserGroup.rotation.set(0, 0, 0);
          this.scene.taserGroup.quaternion.identity();
          this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
        }
      } else {
        if (!this.scene.taserGroup.userData.startPos) {
          this.scene.taserGroup.userData.startPos = new THREE.Vector3(0, 0, 0);
        }
        this.scene.taserGroup.position.copy(this.scene.taserGroup.userData.startPos);
        this.scene.taserGroup.lookAt(0, this.scene.taserGroup.position.y, 3.0);
        this.syncDistanceFromTarget();
        this.updateAimVisuals();
      }
    }

    this.scene.armOverrideWeight = 0;
    this.scene.updateWeaponVisibility(false);
    this.scene.setAnimation('Idle', 0.2);

    const btn = document.getElementById('btn-scenario');
    if (btn) {
      btn.textContent = '⏸️ Stoppa';
      btn.classList.add('active-attack');
    }
    const tLabel = document.getElementById('target-label');
    if (tLabel) {
      tLabel.textContent = 'MÅL: ANGREPP PÅGÅR';
      tLabel.classList.add('armed');
    }

    this.startThreatEscalation();
  }

  stopScenario() {
    this.isScenarioActive = false;
    this.fsm.isScenarioActive = false;
    this.isTased = false;
    if (this.threatInterval) {
      clearInterval(this.threatInterval);
      this.threatInterval = null;
    }
    this.threatLevel = 0;
    window.threatLevel = 0;
    this.threatWeapon = 'KNIFE';
    if (this.scene) {
      this.scene.setThreatWeapon('KNIFE');
      this.scene.armOverrideWeight = 0;
      this.scene.updateWeaponVisibility(false);
    }
    this.warningGiven = false;
    this.updateWarningUI();

    if (this.isLiveAIRunning()) {
      this.scene.set3DVisibility(false);
    } else {
      this.scene.set3DVisibility(true);
      if (this.scene.taserGroup) {
        this.scene.taserGroup.visible = true;
        if (!this.scene.figureFallen) this.scene.setAnimation('Idle', 0.5);
        if (this.scene.taserGroup.userData.startPos) {
          this.scene.taserGroup.position.copy(this.scene.taserGroup.userData.startPos);
          this.syncDistanceFromTarget();
          this.updateAimVisuals();
        }
      }
    }

    const btn = document.getElementById('btn-scenario');
    if (btn) {
      btn.textContent = '🚨 Angrepp';
      btn.classList.remove('active-attack');
    }
    const tLabel = document.getElementById('target-label');
    if (tLabel && !this.isLiveAIRunning()) {
      tLabel.textContent = this.isPlacementActive() ? 'PLACERINGSLÄGE (FLYTTA MÅL)' : 'PERSON (3D VR): SKARPT LÄGE';
      tLabel.classList.remove('armed');
    }
    const sub = document.getElementById('subtitle-overlay');
    if (sub) sub.style.display = 'none';
  }

  startThreatEscalation() {
    this.threatLevel = 0;
    window.threatLevel = 0;
    this.scene.armOverrideWeight = 0;
    this.scene.updateWeaponVisibility(false);
    if (this.threatInterval) clearInterval(this.threatInterval);
    this.warningGiven = false;
    this.updateWarningUI();
    this.scene.setAnimation('Idle', 0.4);

    setTimeout(() => {
      if (this.isScenarioActive && !this.scene.figureFallen) {
        this.threatLevel = 1;
        window.threatLevel = 1;
        this.suspectSpeak('Vad fan glor du på?! Backa!');
      }
    }, 700);

    this.threatInterval = setInterval(() => {
      if (!this.isScenarioActive || this.scene.figureFallen || !this.scene.taserGroup || !this.scene.taserGroup.visible) return;
      this.threatLevel++;
      window.threatLevel = this.threatLevel;
      const tLabel = document.getElementById('target-label');

      if (this.threatLevel === 2) {
        this.suspectSpeak('Rör mig inte sa jag! Stick!');
      } else if (this.threatLevel === 3) {
        this.scene.setThreatWeapon(this.threatWeapon);
        this.scene.setAnimation('Walk', 0.5);
        if (this.threatWeapon === 'KNIFE') {
          this.suspectSpeak('Jag sprättar dig! Jag svär!');
          if (tLabel) { tLabel.textContent = 'PERSON: BEVÄPNAD (KNIV)'; tLabel.classList.add('armed'); }
        } else if (this.threatWeapon === 'BATON') {
          this.suspectSpeak('Jag slår ihjäl dig! Backa!');
          if (tLabel) { tLabel.textContent = 'PERSON: BEVÄPNAD (BATONG)'; tLabel.classList.add('armed'); }
        } else {
          this.suspectSpeak('Jag ska spöa skiten ur dig!');
          if (tLabel) { tLabel.textContent = 'PERSON: ANGREPP (KNYTNÄVAR)'; tLabel.classList.add('armed'); }
        }
      }
    }, 4500);
  }

  suspectSpeak(text) {
    const subtitle = document.getElementById('subtitle-overlay');
    if (subtitle) {
      subtitle.textContent = `MÅL: "${text}"`;
      subtitle.style.display = 'block';
      setTimeout(() => { subtitle.style.display = 'none'; }, 4000);
    }
    this.audio.suspectSpeak(text);
  }

  // =========================================================================
  // 7. SWEDISH VOICE COMMAND HANDLER (IDENTICAL PARITY WITH MOBILE MODE)
  // =========================================================================
  handleVoiceCommand(cmd) {
    if (cmd === 'VAPEN_OSAKRA') {
      if (!this.fsm.hasBattery) {
        this.showHudToast('🔋 Sätt i batteri först!', '#f1c40f');
        return;
      }
      if (!this.fsm.isSafe) {
        this.showHudToast('Vapnet är redan osäkrat', '#f1c40f');
        return;
      }
      window.toggleSafety();
      return;
    }
    if (cmd === 'VAPEN_SAKRA') {
      if (this.fsm.hasBattery && !this.fsm.isSafe) window.toggleSafety();
      return;
    }
    if (cmd === 'VAPEN_AVFYRA') {
      this.showHudToast('🎙️ Röst: AVFYRA!', '#e74c3c');
      this.handleTrigger();
      return;
    }
    if (cmd === 'VAPEN_LADDA_OM') {
      if (this.fsm.chamber1 !== ChamberState.LOADED || this.fsm.chamber2 !== ChamberState.LOADED) {
        this.fsm.toggleCassette();
        this.updateDisplay();
        this.showHudToast('📥 Röst: Kassetter omladdade (2/2)', '#2ecc71');
      } else if (!this.fsm.isSafe && this.fsm.hasBattery) {
        this.toggleCartridge();
        this.showHudToast(`🔄 Röst: K${this.fsm.activeChamber}`, '#3498db');
      }
      return;
    }
    if (cmd === 'STARTA_ANGREPP') { this.startScenario(); return; }
    if (cmd === 'STOPPA_ANGREPP') { this.stopScenario(); return; }

    if (cmd === 'VARNING_EL' || cmd === 'VARNING_FULL' || cmd === 'VARNING_ELCHOCKVAPEN' || cmd === 'VARNING_BEREDD') {
      const wasWarned = this.warningGiven;
      this.warningGiven = true;
      this.updateWarningUI();
      this.showHudToast('📢 VARNING DELGIVEN', '#f1c40f');
      if (!this.scene.figureFallen) {
        if (this.threatLevel >= 3) {
          this.suspectSpeak(!wasWarned ? 'Tror du jag bryr mig om ditt elvapen?!' : 'Jag hörde dig! Stick sa jag!');
        } else {
          this.suspectSpeak('Vadå elchockvapen?! Ta det lugnt!');
        }
      }
      return;
    }

    if (this.scene.figureFallen) return;
    const isThreatActive = this.threatLevel >= 3 || (this.xr && this.xr.xrSession && (this.xr.scenario === 'moving' || this.xr.scenario === 'charging') && !this.xr.targetSurrendered);
    const isArmed = isThreatActive || (this.scene.knifeMesh && this.scene.knifeMesh.visible) || (this.scene.batonMesh && this.scene.batonMesh.visible) || this.threatWeapon === 'FISTS';

    const applySurrenderStop = (labelText) => {
      if (this.threatInterval) { clearInterval(this.threatInterval); this.threatInterval = null; }
      this.threatLevel = 0;
      window.threatLevel = 0;
      this.isScenarioActive = false;
      this.fsm.isScenarioActive = false;
      this.xr.surrenderScenario();
      this.scene.armOverrideWeight = 0;
      this.scene.updateWeaponVisibility(false);
      this.scene.setAnimation('Idle', 0.4);
      const tLabel = document.getElementById('target-label');
      if (tLabel) { tLabel.textContent = labelText || 'PERSON: GAV UPP'; tLabel.classList.remove('armed'); }
    };

    if (cmd === 'SLAPP_KNIVEN' || cmd === 'SLAPP_VAPNET') {
      if (isArmed && Math.random() < (this.warningGiven ? 0.50 : 0.35)) {
        applySurrenderStop('PERSON: GAV UPP');
        this.showHudToast('✅ Målet släpper vapnet!', '#2ecc71');
        this.suspectSpeak('Okej! Skjut inte, jag ger upp!');
      } else if (isArmed) {
        this.showHudToast('⚠️ Målet vägrar släppa!', '#e74c3c');
        this.suspectSpeak('Aldrig i livet! Kom hit då!');
      }
    } else if (cmd === 'HANDERNA_UPP') {
      if (isThreatActive && Math.random() < (this.warningGiven ? 0.45 : 0.25)) {
        applySurrenderStop('PERSON: HÄNDERNA UPPE');
        this.showHudToast('✅ Målet stannar & ger upp!', '#2ecc71');
        this.suspectSpeak('Okej, mina händer är uppe! Skjut inte!');
      } else {
        this.xr.pauseScenario(1600);
        this.suspectSpeak('Gå bort från mig!');
      }
    } else if (cmd === 'BACKA') {
      this.xr.retreatTarget(0.8);
      this.showHudToast('↩️ Målet backar', '#f1c40f');
      this.suspectSpeak('Okej, jag backar!');
    } else if (cmd === 'POLIS_STANNA' || cmd === 'STANNA') {
      const chance = cmd === 'POLIS_STANNA' ? (this.warningGiven ? 0.55 : 0.35) : 0.20;
      if (isThreatActive && Math.random() < chance) {
        applySurrenderStop('PERSON: STANNADE');
        this.showHudToast('✅ Målet stannar!', '#2ecc71');
        this.suspectSpeak('Okej polis, jag stannar! Skjut inte!');
      } else if (isThreatActive) {
        this.xr.pauseScenario(2600);
        this.suspectSpeak('Vad vill du mig?!');
      }
    } else if (cmd === 'LAGG_DIG_NER') {
      if (!isArmed || Math.random() < (this.warningGiven ? 0.45 : 0.15)) {
        applySurrenderStop('PERSON: PÅ MARKEN');
        this.scene.collapseTarget();
        this.showHudToast('✅ Målet lägger sig ner!', '#2ecc71');
        this.suspectSpeak('Okej! Jag lägger mig ner!');
      } else {
        this.showHudToast('⚠️ Målet vägrar lägga sig!', '#e74c3c');
        this.suspectSpeak('Aldrig i livet! Jag lägger mig inte!');
      }
    }
  }

  // =========================================================================
  // 8. LIVE AI REAL PERSON + FIRESTORE MARKER SYNC
  // =========================================================================
  async startRealPersonAI() {
    this.closeModal('scenario-modal');
    this.stopHandTracking(); // Free MediaPipe WASM / CPU for BlazePose person tracking

    // Avsluta eventuell aktiv 3D-placering så pistol-HUD visas direkt i Live AI
    if (this.xr) {
      this.xr.isPlacing = false;
      this.xr.placeMode = false;
      this.xr.figureLocked = true;
    }
    document.body.classList.remove('xr-placing');
    document.documentElement.classList.remove('xr-placing');
    if (this.scene && this.scene.placementMarker) {
      this.scene.placementMarker.visible = false;
      this.scene.placementMarker.scale.set(1, 1, 1);
    }
    if (this.scene && this.scene.reticle) this.scene.reticle.visible = false;
    const btnPlaceXrLive = document.getElementById('btn-place-xr');
    if (btnPlaceXrLive) btnPlaceXrLive.style.display = 'none';
    const hintLive = document.getElementById('place-hint');
    if (hintLive) hintLive.classList.remove('visible');
    const topPlaceBtnLive = document.getElementById('vr-btn-place');
    if (topPlaceBtnLive) {
      topPlaceBtnLive.textContent = '📍 Flytta mål';
      topPlaceBtnLive.classList.remove('active-pill');
    }

    const cameraFeed = document.getElementById('camera-feed-left');
    const cameraFeedRight = document.getElementById('camera-feed-right');
    const tLabel = document.getElementById('target-label');

    this.liveWires = [];
    this.aimX = 50;
    this.aimY = 50;
    document.body.classList.add('ar-active', 'live-ai-active', 'live-ar-active');
    document.documentElement.classList.add('ar-active', 'live-ai-active', 'live-ar-active');

    // Generate 4-digit Firestore room code for Marker sync
    const roomCode = String(Math.floor(1000 + Math.random() * 9000));
    this.liveARRoomCode = roomCode;
    const roomBadge = document.getElementById('live-ar-room-badge');
    if (roomBadge) {
      roomBadge.textContent = `🔗 KOD: ${roomCode}`;
      roomBadge.classList.remove('hit-sent');
      roomBadge.style.display = 'inline-flex';
    }
    if (window.taserFirebase && typeof window.taserFirebase.createSession === 'function') {
      window.taserFirebase.createSession(roomCode).then((ok) => {
        if (ok) this.log(`<span style='color:#2ecc71; font-weight:bold;'>🔗 Markör-rum skapat: ${roomCode}</span>`);
      });
    }

    if (tLabel) tLabel.textContent = 'INITIERAR AI & KAMERA...';
    const liveBtn = document.getElementById('vr-btn-live-ai');
    if (liveBtn) {
      liveBtn.textContent = '⏹️ Avsluta Live AI';
      liveBtn.classList.add('active-pill');
    }

    try {
      const stream = await this.startCameraPassThrough();
      if (stream && cameraFeedRight && cameraFeed && cameraFeed.srcObject) {
        cameraFeedRight.srcObject = cameraFeed.srcObject;
        cameraFeedRight.play().catch(() => {});
      }
      if (this.xr) this.xr.useCamera = true;
      this.scene.enableARMode();
      this.aiPose.isSimulated = !!this.isSyntheticPassthrough;

      if (!this.aiPose.isSimulated) {
        if (tLabel) tLabel.textContent = 'LADDAR AI-MODELL...';
        await this.aiPose.ensureReady().catch(() => {
          this.aiPose.isSimulated = true;
        });
      }

      this.aiPose.start(cameraFeed);
      if (tLabel) tLabel.textContent = this.aiPose.isSimulated ? 'MÄNNISKA (AI DEMO)' : 'MÄNNISKA (AI SÖKER...)';
      this.updateAimVisuals();
      this.updateDisplay();
      this.updateProjectors();
      this.showHudToast(`🤖 Live AI aktiv — KOD: ${roomCode}`, '#2ecc71');
    } catch (err) {
      this.aiPose.isSimulated = true;
      this.aiPose.start(cameraFeed);
      this.updateAimVisuals();
      this.updateDisplay();
      this.updateProjectors();
    }
  }

  stopRealPersonAI(silent = false) {
    document.body.classList.remove('ar-active', 'live-ai-active', 'live-ar-active');
    document.documentElement.classList.remove('ar-active', 'live-ai-active', 'live-ar-active');
    this.liveWires = [];
    this.liveARRoomCode = null;
    if (this.xr) this.xr.useCamera = false;

    const roomBadge = document.getElementById('live-ar-room-badge');
    if (roomBadge) {
      roomBadge.style.display = 'none';
      roomBadge.classList.remove('hit-sent');
    }
    const liveBtn = document.getElementById('vr-btn-live-ai');
    if (liveBtn) {
      liveBtn.textContent = '🤖 Live AI';
      liveBtn.classList.remove('active-pill');
    }

    if (this.aiPose) this.aiPose.stop();
    if (this.scene) {
      this.scene.clearWiresAndDarts();
      this.scene.resetTarget();
      this.scene.set3DVisibility(true);
      this.scene.enableARMode(); // Keep transparent VR passthrough active!
    }

    // Resume hand tracking in Stereo VR passthrough
    const camLeft = document.getElementById('camera-feed-left');
    if (camLeft && camLeft.srcObject) {
      this.startHandTracking(camLeft);
    }

    this.currentDistance = 3.0;
    this.aimX = 50;
    this.aimY = 50;
    this.stopScenario();
    this.updateAimVisuals();
    this.updateDisplay();
    this.updateProjectors();
    if (!silent) this.showHudToast('Återgick till 3D VR-mål', '#3498db');
  }

  // =========================================================================
  // 9. WEBXR (IMMERSIVE-AR) SUPPORT & FLOOR PLACEMENT
  // =========================================================================
  async startWebXR(type = 'static') {
    this.stopHandTracking();
    const res = await this.xr.startXR(type);
    this.closeModal('scenario-modal');
    if (res && res.success === false) {
      this.startVirtualScenario(type);
    }
  }

  startVirtualScenario(type = 'static') {
    if (this.aiPose && this.aiPose.isActive) this.stopRealPersonAI(true);
    this.selectedScenario = type;
    this.scene.resetTarget();
    this.scene.set3DVisibility(true);
    this.scene.enableARMode();

    const tLabel = document.getElementById('target-label');
    if (type === 'charging') {
      if (tLabel) tLabel.textContent = 'MÅL: FRAMSTORMANDE';
      this.threatLevel = 4;
      window.threatLevel = 4;
      this.startScenario();
    } else if (type === 'moving') {
      if (tLabel) tLabel.textContent = 'MÅL: RÖRLIGT';
      this.threatLevel = 3;
      window.threatLevel = 3;
      this.startScenario();
    } else {
      if (tLabel) tLabel.textContent = 'MÅL: STATISKT';
      this.threatLevel = 1;
      window.threatLevel = 1;
      this.isScenarioActive = false;
      this.fsm.isScenarioActive = false;
    }
    this.currentDistance = 3.0;
    this.updateAimVisuals();
    this.updateDisplay();
    this.showHudToast(`🎯 Scenario: ${type.toUpperCase()}`, '#2ecc71');
  }

  onXRSessionStart(session, scenario) {
    if (this.aiPose && this.aiPose.isActive) this.aiPose.stop();
    this.liveARRoomCode = null;
    const roomBadgeXR = document.getElementById('live-ar-room-badge');
    if (roomBadgeXR) roomBadgeXR.style.display = 'none';

    document.body.classList.remove('live-ai-active', 'live-ar-active');
    document.body.classList.add('ar-active', 'webxr-mode', 'ar-combat-mode');
    document.documentElement.classList.add('ar-active', 'webxr-mode', 'ar-combat-mode');

    this.liveWires = [];
    this.scene.clearWiresAndDarts();
    this.scene.enableARMode();

    // Bind WebXR controller trigger/grip events
    this._xrSelectStartBound = () => {
      if (this.xr.isPlacing && this.xr.placeMode) {
        this.confirmPlacement();
      } else {
        this.triggerFireInput();
      }
    };
    this._xrSqueezeStartBound = () => this.triggerArcInput();
    session.addEventListener('selectstart', this._xrSelectStartBound);
    session.addEventListener('squeezestart', this._xrSqueezeStartBound);

    const btnWebXR = document.getElementById('vr-btn-webxr');
    if (btnWebXR) {
      btnWebXR.textContent = '⛔ Avsluta XR';
      btnWebXR.classList.add('active-pill');
    }

    this.updateProjectors();
    this.togglePlaceMode();

    if (this.voice && this.voice.isSupported) {
      if (!this.voice.isListening) this.voice.start({ autoFromXR: true });
      else this.voice.ensureActive();
    }
    this.log(`WebXR startad i scenario: ${scenario}`);
  }

  onXRSessionEnd() {
    document.body.classList.remove('ar-active', 'webxr-mode', 'ar-combat-mode', 'xr-placing');
    document.documentElement.classList.remove('ar-active', 'webxr-mode', 'ar-combat-mode', 'xr-placing');
    this._prevXRButtons.clear();

    this.xr.isPlacing = false;
    this.xr.placeMode = false;
    this.xr.figureLocked = true;
    if (this.scene && this.scene.placementMarker) {
      this.scene.placementMarker.visible = false;
      this.scene.placementMarker.scale.set(1, 1, 1);
    }

    const btnPlaceXr = document.getElementById('btn-place-xr');
    if (btnPlaceXr) btnPlaceXr.style.display = 'none';
    const topPlaceBtn = document.getElementById('vr-btn-place');
    if (topPlaceBtn) {
      topPlaceBtn.textContent = '📍 Flytta mål';
      topPlaceBtn.classList.remove('active-pill');
    }
    const hint = document.getElementById('place-hint');
    if (hint) hint.classList.remove('visible');
    const btnWebXR = document.getElementById('vr-btn-webxr');
    if (btnWebXR) {
      btnWebXR.textContent = '🌐 WebXR';
      btnWebXR.classList.remove('active-pill');
    }

    this.scene.clearWiresAndDarts();
    this.scene.resetTarget();
    this.stopScenario();
    this.updateDisplay();

    // Restore stereo passthrough camera after WebXR releases camera HAL
    setTimeout(() => {
      this.startCameraPassThrough();
      this.scene.enableARMode();
    }, 250);
  }

  togglePlaceMode(silent = false) {
    if (this.isLiveAIRunning()) return;
    this.xr.isPlacing = true;
    this.xr.placeMode = true;
    this.xr.figureLocked = false;
    this.xr.hasHitTestPose = false;
    this._xrManualMoveUsed = false;
    document.body.classList.add('xr-placing');
    document.documentElement.classList.add('xr-placing');

    const btnPlaceXr = document.getElementById('btn-place-xr');
    if (btnPlaceXr) btnPlaceXr.style.display = 'inline-flex';
    const topPlaceBtn = document.getElementById('vr-btn-place');
    if (topPlaceBtn) {
      topPlaceBtn.textContent = '📍 Placerar...';
      topPlaceBtn.classList.add('active-pill');
    }
    const hint = document.getElementById('place-hint');
    if (hint) {
      hint.textContent = 'Styr med D-pad/spak • Tryck L3 / Space / FASTSTÄLL';
      hint.classList.add('visible');
    }
    const tLabel = document.getElementById('target-label');
    if (tLabel) {
      tLabel.textContent = 'PLACERINGSLÄGE (FLYTTA MÅL)';
      tLabel.classList.remove('armed');
    }

    this.scene.set3DVisibility(true);
    if (this.scene.taserGroup) {
      this.scene.taserGroup.visible = true;
      if (!this.scene.figureFallen) {
        const camPos = (this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting)
          ? this.scene.renderer.xr.getCamera(this.scene.camera).position
          : { x: 0, z: 3.0 };
        this.scene.taserGroup.lookAt(camPos.x, this.scene.taserGroup.position.y, camPos.z);
      }
    }
    if (this.scene.placementMarker) {
      this.scene.placementMarker.rotation.set(0, 0, 0);
      this.scene.placementMarker.quaternion.identity();
      this.scene.placementMarker.scale.set(1.8, 1.8, 1.8);
      if (this.scene.taserGroup) {
        this.scene.placementMarker.position.set(
          this.scene.taserGroup.position.x,
          this.scene.taserGroup.position.y + 0.015,
          this.scene.taserGroup.position.z
        );
      }
      this.scene.placementMarker.visible = true;
    }
    this.syncDistanceFromTarget();
    this.updateAimVisuals();
    if (!silent) {
      this.showHudToast('Flytta målet med D-pad/spak • Tryck L3 eller Space', '#2ecc71');
    }
  }

  confirmPlacement() {
    const marker = this.scene.placementMarker;
    const isXR = !!(this.xr && this.xr.xrSession);
    const xrCam = isXR ? this.scene.renderer.xr.getCamera(this.scene.camera) : null;
    const shooterPos = isXR && xrCam ? xrCam.position : { x: 0, y: 1.35, z: 3.0 };

    if (isXR) {
      if (!this._xrManualMoveUsed && marker && marker.visible && (this.xr.hasHitTestPose || marker.position.lengthSq() > 0.001)) {
        marker.updateMatrix();
        this.scene.taserGroup.position.setFromMatrixPosition(marker.matrix);
        this.scene.taserGroup.position.y = Math.max(0, this.scene.taserGroup.position.y - 0.015);
      } else if (!this._xrManualMoveUsed && xrCam) {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
        forward.y = 0;
        if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
        forward.normalize().multiplyScalar(3.0);
        this.scene.taserGroup.position.set(xrCam.position.x + forward.x, 0, xrCam.position.z + forward.z);
      }
    }

    if (this.scene.taserGroup) {
      this.scene.taserGroup.lookAt(shooterPos.x, this.scene.taserGroup.position.y, shooterPos.z);
      this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
      if (this.scene.taserGroup.userData.preFallPos) {
        this.scene.taserGroup.userData.preFallPos.copy(this.scene.taserGroup.position);
      }
    }

    this.xr.isPlacing = false;
    this.xr.placeMode = false;
    this.xr.figureLocked = true;
    this._xrManualMoveUsed = false;
    this._gpMoveX = 0;
    this._gpMoveY = 0;

    document.body.classList.remove('xr-placing');
    document.documentElement.classList.remove('xr-placing');
    this.scene.set3DVisibility(true);

    // Dölj placeringsringen under fötterna helt så att ingen extra ring ligger kvar
    if (marker) {
      marker.visible = false;
      marker.scale.set(1, 1, 1);
    }
    if (this.scene.reticle) {
      this.scene.reticle.visible = false;
    }

    const btnPlaceXr = document.getElementById('btn-place-xr');
    if (btnPlaceXr) btnPlaceXr.style.display = 'none';
    const topPlaceBtn = document.getElementById('vr-btn-place');
    if (topPlaceBtn) {
      topPlaceBtn.textContent = '📍 Flytta mål';
      topPlaceBtn.classList.remove('active-pill');
    }
    const hint = document.getElementById('place-hint');
    if (hint) hint.classList.remove('visible');

    if (isXR && (this.xr.scenario === 'moving' || this.xr.scenario === 'charging')) {
      this.startScenario();
    } else {
      this.stopScenario();
    }

    const placedDist = this.syncDistanceFromTarget();
    this.updateAimVisuals();
    this.updateDisplay();

    const tLabel = document.getElementById('target-label');
    if (tLabel && !this.isScenarioActive && !this.isLiveAIRunning()) {
      tLabel.textContent = 'PERSON (3D VR): SKARPT LÄGE';
      tLabel.classList.remove('armed');
    }

    this.playPlacementConfirmSound();
    if (navigator.vibrate) {
      try { navigator.vibrate(28); } catch (_) {}
    }
    this.showHudToast(`MÅL PLACERAT (${placedDist.toFixed(1)} M)`, '#2ecc71');
    this.log(`<span style='color:#2ecc71; font-weight:bold;'>🔒 MÅL PLACERAT (${placedDist.toFixed(1)} M) — Skarpt skjutläge aktivt.</span>`);
  }

  // =========================================================================
  // 10. GYROSCOPE & PHYSICAL TILT
  // =========================================================================
  handlePhysicalTilt(direction, gamma) {
    if (this.isFiring || this.fsm.isFiring) return;
    if (!this.fsm.hasBattery) {
      this.fsm.hasBattery = true;
      this.fsm.isSafe = false;
      this.fsm.chamber1 = ChamberState.LOADED;
      this.fsm.chamber2 = ChamberState.LOADED;
      this.fsm.displayState = 'ACTIVE';
      this.updateDisplay();
    } else if (this.fsm.isSafe) {
      this.fsm.isSafe = false;
      this.fsm.displayState = 'ACTIVE';
      this.updateDisplay();
    }

    if (this.fsm.tiltWeapon()) {
      if (navigator.vibrate) {
        try { navigator.vibrate([40, 30, 40]); } catch (_) {}
      }
      this.updateDisplay();
      this.showHudToast(`🔄 Gyro-snärt (${String(direction || '').toUpperCase()}): K${this.fsm.activeChamber}`, '#3498db');
    }
  }

  initGyro(silent = false) {
    this.audio.init();
    this.xr.initGyro(
      (aimX, aimY) => {
        if (this.isLiveAIRunning()) {
          this.aimX = Math.max(5, Math.min(95, 50 + (this._aimTrimX || 0)));
          this.aimY = Math.max(5, Math.min(95, 50 + (this._aimTrimY || 0)));
        } else {
          this.aimX = Math.max(5, Math.min(95, aimX + (this._aimTrimX || 0)));
          this.aimY = Math.max(5, Math.min(95, aimY + (this._aimTrimY || 0)));
        }
        this.updateAimVisuals();
      },
      (direction, gamma) => this.handlePhysicalTilt(direction, gamma),
      (continuousRollDeg) => {
        if (typeof continuousRollDeg !== 'number' || isNaN(continuousRollDeg)) return;
        this._hasGyroRoll = true;
        const target = Math.max(-135, Math.min(135, continuousRollDeg));
        this._gyroContinuousRoll += (target - this._gyroContinuousRoll) * 0.28;
        this.updateAimVisuals();
      }
    ).then((res) => {
      const btn = document.getElementById('vr-btn-gyro');
      if (res && res.success) {
        if (btn) {
          btn.textContent = '📱 Gyro: PÅ';
          btn.classList.add('active-pill');
        }
        if (!silent) this.showHudToast('📱 Gyroskop aktiverat!', '#2ecc71');
      } else if (res && res.permission === 'denied' && !silent) {
        this.showHudToast('Gyro nekad i webbläsaren', '#e74c3c');
      }
    });
  }

  resetSimulator() {
    this.audio.init();
    this.hideFailOverlay();
    this.isTased = false;
    this.isGameOver = false;
    this.isFiring = false;
    window.isFiring = false;
    if (this.threatInterval) {
      clearInterval(this.threatInterval);
      this.threatInterval = null;
    }
    this.threatLevel = 0;
    window.threatLevel = 0;
    if (this.scene && this.scene.mixer) this.scene.mixer.timeScale = 1.0;

    this.liveWires = [];
    this.scene.clearWiresAndDarts();
    this.fsm.reset();
    this.xr.resetScenarioState();
    this.scene.resetTarget();

    if (this.isLiveAIRunning()) {
      this.scene.set3DVisibility(false);
    } else {
      this.scene.set3DVisibility(true);
    }

    this.syncDistanceFromTarget();
    this.aimX = 50;
    this.aimY = 50;
    this._aimTrimX = 0;
    this._aimTrimY = 0;
    this.tilt = 0;
    if (window.state) window.state.tilt = 0;
    this.resetWeaponPhase4(this.fsm);

    if (this.xr.xrSession && (this.xr.scenario === 'moving' || this.xr.scenario === 'charging')) {
      this.startScenario();
    } else {
      this.stopScenario();
    }
    this.updateAimVisuals();
    this.updateDisplay();
    this.updateWarningUI();
    this.showHudToast('♻️ Återställd (2/2 kassetter redo)', '#2ecc71');
  }

  openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    this._lastModalOpenAt = performance.now();
    modal.querySelectorAll('.scenario-btn').forEach((b) => {
      b.classList.remove('active-press', 'is-loading');
      if (b.dataset.origHtml) b.innerHTML = b.dataset.origHtml;
    });
    modal.style.display = 'flex';
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (id === 'gamepad-modal' && this._calibratingAction) {
      this._calibratingAction = null;
      this.updateGamepadMappingUI();
    }
    modal.style.display = 'none';
    modal.querySelectorAll('.scenario-btn').forEach((b) => {
      b.classList.remove('active-press', 'is-loading');
      if (b.dataset.origHtml) b.innerHTML = b.dataset.origHtml;
    });
  }

  // =========================================================================
  // 11. 3D HAND-TRACKED TASER 7 MODEL, DYNAMIC CID & CHAMBERS
  // =========================================================================
  loadWeaponLockMode() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(WEAPON_MODE_STORAGE_KEY);
        if (saved === 'locked_fallback' || saved === 'auto') return saved;
      }
    } catch (_) {}
    return 'auto';
  }

  saveWeaponLockMode(mode) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(WEAPON_MODE_STORAGE_KEY, mode);
      }
    } catch (_) {}
  }

  toggleWeaponLockMode() {
    this.weaponLockMode = this.weaponLockMode === 'locked_fallback' ? 'auto' : 'locked_fallback';
    this.saveWeaponLockMode(this.weaponLockMode);
    if (this.weaponLockMode === 'locked_fallback') {
      this._consecutiveHandFrames = 0;
      this.lastHandSeenTime = 0;
      this.weaponTrackState = 'FALLBACK_READY';
    }
    this.updateWeaponModeUI();
    this.updateWeaponTrackBadge();
    this.showHudToast(
      this.weaponLockMode === 'locked_fallback'
        ? '🔒 Låst i höft-/siktläge (handspårning pausad)'
        : '🎯 Vapenläge: Auto (Hand + Fallback)',
      this.weaponLockMode === 'locked_fallback' ? '#f1c40f' : '#2ecc71'
    );
  }

  updateWeaponModeUI() {
    const btn = document.getElementById('vr-btn-weapon-mode');
    if (!btn) return;
    const isLocked = this.weaponLockMode === 'locked_fallback';
    btn.textContent = isLocked ? '🔒 Låst i höft/siktläge' : '🎯 Vapenläge: Auto (Hand + Fallback)';
    btn.classList.toggle('active-pill', isLocked);
  }

  updateWeaponTrackBadge() {
    const badge = document.getElementById('vr-weapon-mode-status');
    if (!badge) return;
    const state = this.weaponLockMode === 'locked_fallback' ? 'FALLBACK_READY' : (this.weaponTrackState || 'FALLBACK_READY');
    const key = `${state}|${this.weaponLockMode}`;
    if (this._lastHudTrackBadgeKey === key) return;
    this._lastHudTrackBadgeKey = key;

    badge.classList.remove('tracked', 'grace', 'fallback');
    if (state === 'HAND_TRACKED') {
      badge.textContent = '✋ HANDSPÅRNING';
      badge.classList.add('tracked');
    } else if (state === 'GRACE_FREEZE') {
      badge.textContent = '✋ HANDSPÅRNING';
      badge.classList.add('grace');
    } else {
      badge.textContent = '🎯 FALLBACK-LÄGE';
      badge.classList.add('fallback');
    }
    this.updateHandPreferenceUI();
  }

  computeFallbackPose() {
    const sideSign = this.handPreference === 'left' ? -1 : 1;
    const pos = this._fallbackTargetPos.set(sideSign * 0.21, -0.19, -0.56);
    const convergeDist = Math.max(1.8, Math.min(9.0, this.currentDistance || 3.0));

    // Rikta pipan från ergonomisk höft-/skjutställning snett inåt mot headsetets siktlinje i mitten (0, 0, -convergeDist)
    const fwd = this._fbFwd.set(-pos.x, -pos.y, -convergeDist - pos.z);
    if (fwd.lengthSq() < 0.0001) fwd.set(0, 0, -1);
    fwd.normalize();

    const upRef = this._fbUp.set(0, 1, 0);
    const rightVec = this._fbRight.crossVectors(fwd, upRef);
    if (rightVec.lengthSq() < 0.0001) rightVec.set(1, 0, 0);
    else rightVec.normalize();
    const orthoUp = this._fbUp.crossVectors(rightVec, fwd).normalize();
    const backVec = this._fbBack.copy(fwd).negate();

    this._fbBasis.makeBasis(rightVec, orthoUp, backVec);
    this._fallbackTargetQuat.setFromRotationMatrix(this._fbBasis);
  }

  cycleHandPreference() {
    const order = ['auto', 'right', 'left'];
    const nextIdx = (order.indexOf(this.handPreference) + 1) % order.length;
    this.handPreference = order[nextIdx];
    this.updateHandPreferenceUI();
    const labelMap = {
      auto: 'Auto (Höger/Vänster)',
      right: 'Höger hand',
      left: 'Vänster hand'
    };
    this.showHudToast(`🤚 Handspårning: ${labelMap[this.handPreference]}`, '#38bdf8');
  }

  updateHandPreferenceUI() {
    const btn = document.getElementById('vr-btn-hand');
    if (!btn) return;
    const textMap = {
      auto: '🤚 Hand: Auto',
      right: '🤚 Hand: Höger',
      left: '🤚 Hand: Vänster'
    };
    btn.textContent = textMap[this.handPreference] || '🤚 Hand: Auto';
    btn.classList.toggle('active-pill', this.handPreference !== 'auto' || this.weaponTrackState === 'HAND_TRACKED');
  }

  ensureCIDCanvas() {
    if (this.cidCanvas && this.cidCtx && this.cidTexture) return;
    this.cidCanvas = document.createElement('canvas');
    this.cidCanvas.width = 512;
    this.cidCanvas.height = 256;
    this.cidCtx = this.cidCanvas.getContext('2d');
    this.cidTexture = new THREE.CanvasTexture(this.cidCanvas);
    this.cidTexture.colorSpace = THREE.SRGBColorSpace;
    this.cidTexture.minFilter = THREE.LinearFilter;
    this.cidTexture.magFilter = THREE.LinearFilter;
  }

  drawCrossedBox(ctx, x, y, w, h, loaded, label, isActive, inverted = false) {
    ctx.save();
    if (inverted) {
      ctx.fillStyle = loaded ? (isActive ? '#050505' : 'rgba(5,5,5,0.14)') : 'rgba(5,5,5,0.08)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#050505';
      ctx.lineWidth = isActive ? 7 : 4;
      ctx.strokeRect(x, y, w, h);
      if (loaded) {
        ctx.fillStyle = isActive ? '#FCBE00' : '#050505';
        ctx.font = 'bold 34px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + w / 2, y + h / 2);
      } else {
        ctx.beginPath();
        ctx.moveTo(x + 12, y + 12); ctx.lineTo(x + w - 12, y + h - 12);
        ctx.moveTo(x + w - 12, y + 12); ctx.lineTo(x + 12, y + h - 12);
        ctx.stroke();
      }
      if (isActive) {
        ctx.fillStyle = '#050505';
        ctx.fillRect(x, y + h + 10, w, 10);
      }
      ctx.restore();
      return;
    }

    if (loaded) {
      ctx.fillStyle = isActive ? '#227a2a' : '#1b5e20';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = isActive ? '#45e685' : '#2ecc71';
      ctx.fillRect(x + 6, y + 6, w - 12, h - 12);
      ctx.strokeStyle = isActive ? '#ffff00' : '#a3f7bf';
      ctx.lineWidth = isActive ? 7 : 4;
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = '#041b0c';
      ctx.font = 'bold 34px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h / 2);
    } else {
      ctx.fillStyle = '#2c3138';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = isActive ? '#ffff00' : '#7f8c8d';
      ctx.lineWidth = isActive ? 6 : 4;
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.moveTo(x + 12, y + 12); ctx.lineTo(x + w - 12, y + h - 12);
      ctx.moveTo(x + w - 12, y + 12); ctx.lineTo(x + 12, y + h - 12);
      ctx.stroke();
    }
    if (isActive) {
      ctx.fillStyle = '#ffff00';
      ctx.fillRect(x, y + h + 10, w, 10);
    }
    ctx.restore();
  }

  updateCIDTexture(c1Loaded, c2Loaded, batteryPct = 99, isSafe = true, activeCh = 1, isFunkMode = false, cycleCount = 0) {
    this.ensureCIDCanvas();
    const pct = Math.max(0, Math.min(100, Math.round(batteryPct)));
    const cycleSec = Math.max(0, Math.min(5, Math.round(Number(cycleCount) || 0)));
    const cacheKey = `${c1Loaded ? 1 : 0}|${c2Loaded ? 1 : 0}|${pct}|${isSafe ? 1 : 0}|${activeCh}|${isFunkMode ? 1 : 0}|${cycleSec}`;
    if (this._cidLastKey === cacheKey) return;
    this._cidLastKey = cacheKey;

    const ctx = this.cidCtx;
    const W = this.cidCanvas.width;
    const H = this.cidCanvas.height;

    if (pct <= 0) {
      ctx.fillStyle = '#040507';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 4;
      ctx.strokeRect(8, 8, W - 16, H - 16);
      ctx.fillStyle = '#e74c3c';
      ctx.font = 'bold 28px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('BATTERI 0% / UR', W / 2, H / 2);
      if (this.cidTexture) this.cidTexture.needsUpdate = true;
      return;
    }

    const battX = 338, battY = 28, battW = 68, battH = 30;

    if (isSafe) {
      ctx.fillStyle = '#070b11';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 8;
      ctx.strokeRect(8, 8, W - 16, H - 16);

      ctx.fillStyle = '#14532d';
      ctx.fillRect(26, 22, 165, 42);
      ctx.strokeStyle = '#2ecc71';
      ctx.lineWidth = 3;
      ctx.strokeRect(26, 22, 165, 42);
      ctx.fillStyle = '#4ade80';
      ctx.font = 'bold 26px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SÄKRAD', 108, 44);

      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 3;
      ctx.strokeRect(battX, battY, battW, battH);
      ctx.fillStyle = '#64748b';
      ctx.fillRect(battX + battW, battY + 7, 7, 16);
      ctx.fillStyle = pct > 20 ? '#2ecc71' : '#e74c3c';
      ctx.fillRect(battX + 4, battY + 4, Math.max(4, Math.round((battW - 8) * (pct / 100))), battH - 8);
      ctx.fillStyle = '#cbd5e1';
      ctx.font = 'bold 24px monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`${pct}%`, W - 26, 30);

      this.drawCrossedBox(ctx, 56, 94, 175, 108, !!c1Loaded, 'C1', false, false);
      this.drawCrossedBox(ctx, 281, 94, 175, 108, !!c2Loaded, 'C2', false, false);
      if (this.cidTexture) this.cidTexture.needsUpdate = true;
      return;
    }

    if (isFunkMode) {
      ctx.fillStyle = '#FCBE00';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#050505';
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, W - 10, H - 10);
      ctx.fillStyle = '#050505';
      ctx.font = 'bold 23px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('FUNK KONTROLL', 28, 30);
      ctx.strokeRect(battX, battY, battW, battH);
      ctx.fillRect(battX + battW, battY + 8, 7, 16);
      ctx.fillRect(battX + 5, battY + 5, Math.max(4, Math.round((battW - 10) * (pct / 100))), battH - 10);
      ctx.font = 'bold 24px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${pct}%`, W - 26, 30);

      if (cycleSec > 0) {
        ctx.fillStyle = '#050505';
        ctx.fillRect(40, 84, W - 80, 128);
        ctx.fillStyle = '#FCBE00';
        ctx.font = 'bold 34px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`5 SEK CYKEL`, W / 2, 126);
        ctx.font = 'bold 50px monospace';
        ctx.fillText(`${cycleSec} / 5 SEK`, W / 2, 176);
      } else {
        this.drawCrossedBox(ctx, 56, 88, 175, 112, !!c1Loaded, 'C1', activeCh === 1, true);
        this.drawCrossedBox(ctx, 281, 88, 175, 112, !!c2Loaded, 'C2', activeCh === 2, true);
      }
      if (this.cidTexture) this.cidTexture.needsUpdate = true;
      return;
    }

    ctx.fillStyle = '#FCBE00';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#06080b';
    ctx.fillRect(14, 14, W - 28, H - 28);

    ctx.fillStyle = '#7f1d1d';
    ctx.fillRect(26, 22, 165, 42);
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth = 3;
    ctx.strokeRect(26, 22, 165, 42);
    ctx.fillStyle = '#ff6b81';
    ctx.font = 'bold 25px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('OSÄKRAD', 108, 44);

    ctx.strokeStyle = '#FCBE00';
    ctx.lineWidth = 4;
    ctx.strokeRect(battX, battY, battW, battH);
    ctx.fillStyle = '#FCBE00';
    ctx.fillRect(battX + battW, battY + 7, 7, 16);
    ctx.fillStyle = pct > 20 ? '#2ecc71' : '#e74c3c';
    ctx.fillRect(battX + 5, battY + 5, Math.max(4, Math.round((battW - 10) * (pct / 100))), battH - 10);

    ctx.fillStyle = '#FCBE00';
    ctx.font = 'bold 25px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${pct}%`, W - 26, 30);

    if (cycleSec > 0) {
      ctx.fillStyle = '#0b192c';
      ctx.fillRect(42, 82, W - 84, 132);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 5;
      ctx.strokeRect(42, 82, W - 84, 132);
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 28px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`⚡ ELCHOCK / CYKEL ⚡`, W / 2, 118);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 52px monospace';
      ctx.fillText(`${cycleSec} / 5 SEK`, W / 2, 170);
      const barW = Math.round(((W - 116) * cycleSec) / 5);
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(58, 198, barW, 8);
    } else {
      this.drawCrossedBox(ctx, 56, 88, 175, 112, !!c1Loaded, 'C1', activeCh === 1, false);
      this.drawCrossedBox(ctx, 281, 88, 175, 112, !!c2Loaded, 'C2', activeCh === 2, false);
    }
    if (this.cidTexture) this.cidTexture.needsUpdate = true;
  }

  createDetailedTaser7Weapon() {
    const group = new THREE.Group();
    group.name = 'Taser7_DetailedChassis';

    const blackPolymer = new THREE.MeshStandardMaterial({ color: 0x161920, roughness: 0.56, metalness: 0.22 });
    const matteTrim = new THREE.MeshStandardMaterial({ color: 0x262b35, roughness: 0.48, metalness: 0.35 });
    const taserYellow = new THREE.MeshStandardMaterial({ color: 0xFCBE00, roughness: 0.42, metalness: 0.14 });
    const chromeMetal = new THREE.MeshStandardMaterial({ color: 0xd0d7e2, roughness: 0.22, metalness: 0.92 });
    const darkLens = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.18, metalness: 0.7 });

    // 1. Övre mantel / stomme (Slide)
    const upperSlide = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.041, 0.148), blackPolymer);
    upperSlide.position.set(0, 0.025, -0.014);
    group.add(upperSlide);

    // Fasade sidopaneler på manteln
    const sideAccentL = new THREE.Mesh(new THREE.BoxGeometry(0.039, 0.015, 0.115), matteTrim);
    sideAccentL.position.set(0, 0.029, -0.008);
    group.add(sideAccentL);

    // Topp-sikte (främre fiber grön, bakre vit/gul)
    const rearSight = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.006, 0.012), matteTrim);
    rearSight.position.set(0, 0.048, 0.046);
    group.add(rearSight);
    const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.006, 0.012), new THREE.MeshBasicMaterial({ color: 0x2ecc71 }));
    frontSight.position.set(0, 0.048, -0.076);
    group.add(frontSight);

    // 2. Gul ergonomisk kolv / grepp + Batteripack i botten
    const gripUpper = new THREE.Mesh(new THREE.BoxGeometry(0.033, 0.088, 0.041), taserYellow);
    gripUpper.position.set(0, -0.036, 0.034);
    gripUpper.rotation.x = 0.25;
    group.add(gripUpper);

    const gripBackstrap = new THREE.Mesh(new THREE.BoxGeometry(0.029, 0.082, 0.016), blackPolymer);
    gripBackstrap.position.set(0, -0.037, 0.050);
    gripBackstrap.rotation.x = 0.25;
    group.add(gripBackstrap);

    const batteryBase = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.019, 0.046), blackPolymer);
    batteryBase.position.set(0, -0.080, 0.045);
    batteryBase.rotation.x = 0.25;
    group.add(batteryBase);

    // 3. Varbygel & Avtryckare
    const triggerGuardBottom = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.005, 0.038), blackPolymer);
    triggerGuardBottom.position.set(0, -0.012, -0.004);
    group.add(triggerGuardBottom);
    const triggerGuardFront = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.022, 0.006), blackPolymer);
    triggerGuardFront.position.set(0, -0.001, -0.021);
    group.add(triggerGuardFront);
    const triggerBlade = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.016, 0.009), matteTrim);
    triggerBlade.position.set(0, -0.001, 0.001);
    triggerBlade.rotation.x = -0.25;
    group.add(triggerBlade);

    // 4. Dubbel C1 / C2 kassett framtill (Bay + patronlock + laser/lampa)
    const cartridgeBay = new THREE.Mesh(new THREE.BoxGeometry(0.039, 0.044, 0.046), taserYellow);
    cartridgeBay.position.set(0, 0.023, -0.097);
    group.add(cartridgeBay);

    const cartridgeFace = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.040, 0.005), darkLens);
    cartridgeFace.position.set(0, 0.023, -0.119);
    group.add(cartridgeFace);

    // Underbarrel taktisk LED + laserlins
    const ledPod = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.008, 0.036, 12), matteTrim);
    ledPod.rotation.x = Math.PI / 2;
    ledPod.position.set(0, -0.002, -0.082);
    group.add(ledPod);

    // 5. Främre ljusbågselektroder (vänster/höger metallspetsar)
    const elecGeo = new THREE.CylinderGeometry(0.0024, 0.0028, 0.014, 10);
    const elecL = new THREE.Mesh(elecGeo, chromeMetal);
    elecL.rotation.x = Math.PI / 2;
    elecL.position.set(-0.015, 0.034, -0.121);
    group.add(elecL);

    const elecR = new THREE.Mesh(elecGeo, chromeMetal);
    elecR.rotation.x = Math.PI / 2;
    elecR.position.set(0.015, 0.034, -0.121);
    group.add(elecR);

    // 6. Rörlig Säkringsspak (SÄKRAD / OSÄKRAD) på båda sidor + baktill
    const safetyMat = new THREE.MeshStandardMaterial({ color: 0x2ecc71, emissive: 0x0b3d1e, roughness: 0.35, metalness: 0.2 });
    const safetyLever = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.007, 0.016), safetyMat);
    safetyLever.position.set(0, 0.010, 0.044);
    group.add(safetyLever);
    this._safetyLeverMesh = safetyLever;

    // 7. Ljusbågsgrupp mellan elektroderna + PointLight
    this.weaponArcGroup = new THREE.Group();
    this.weaponArcGroup.position.set(0, 0.034, -0.124);
    this.weaponArcGroup.visible = false;
    group.add(this.weaponArcGroup);

    this.weaponArcLight = new THREE.PointLight(0x55b6ff, 0, 1.5, 2.0);
    this.weaponArcLight.position.set(0, 0.005, -0.01);
    this.weaponArcGroup.add(this.weaponArcLight);

    this.weaponArcCurvePoints = [];
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      this.weaponArcCurvePoints.push(new THREE.Vector3(-0.015 + 0.03 * t, 0, 0));
    }
    const initCurve = new THREE.CatmullRomCurve3(this.weaponArcCurvePoints);
    this.weaponArcTubeMesh = new THREE.Mesh(
      new THREE.TubeGeometry(initCurve, 12, 0.0022, 6, false),
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.weaponArcGroup.add(this.weaponArcTubeMesh);

    this.weaponArcCoreMesh = new THREE.Mesh(
      new THREE.TubeGeometry(initCurve, 12, 0.0009, 6, false),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.98, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    this.weaponArcGroup.add(this.weaponArcCoreMesh);

    const glowMat = new THREE.SpriteMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    this.weaponArcSprites = [-0.015, 0.015].map((ex) => {
      const sp = new THREE.Sprite(glowMat.clone());
      sp.position.set(ex, 0, 0);
      sp.scale.set(0.016, 0.016, 0.016);
      this.weaponArcGroup.add(sp);
      return sp;
    });

    return group;
  }

  startWeaponArcEffect() {
    this.weaponArcActive = true;
    if (this.weaponArcGroup && this.weaponGroup?.visible) {
      this.weaponArcGroup.visible = true;
    }
  }

  stopWeaponArcEffect() {
    this.weaponArcActive = false;
    if (this.weaponArcGroup) this.weaponArcGroup.visible = false;
    if (this.weaponArcLight) this.weaponArcLight.intensity = 0;
  }

  updateWeaponArcEffect() {
    if (!this.weaponArcGroup) return;
    const active = !!this.weaponArcActive && !!(this.weaponGroup && this.weaponGroup.visible);
    this.weaponArcGroup.visible = active;
    if (!active) {
      if (this.weaponArcLight) this.weaponArcLight.intensity = 0;
      return;
    }

    const pts = this.weaponArcCurvePoints;
    for (let i = 1; i < pts.length - 1; i++) {
      const t = i / (pts.length - 1);
      pts[i].set(
        -0.015 + 0.03 * t + (Math.random() - 0.5) * 0.0025,
        (Math.random() - 0.5) * 0.007,
        (Math.random() - 0.5) * 0.005
      );
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    if (this.weaponArcTubeMesh) {
      if (this.weaponArcTubeMesh.geometry) this.weaponArcTubeMesh.geometry.dispose();
      this.weaponArcTubeMesh.geometry = new THREE.TubeGeometry(curve, 12, 0.0021, 6, false);
    }
    if (this.weaponArcCoreMesh) {
      if (this.weaponArcCoreMesh.geometry) this.weaponArcCoreMesh.geometry.dispose();
      this.weaponArcCoreMesh.geometry = new THREE.TubeGeometry(curve, 12, 0.0009, 6, false);
    }
    if (this.weaponArcLight) {
      this.weaponArcLight.intensity = 1.8 + Math.random() * 2.6;
    }
    if (this.weaponArcSprites) {
      this.weaponArcSprites.forEach((sp) => {
        const s = 0.012 + Math.random() * 0.010;
        sp.scale.set(s, s, s);
      });
    }
  }

  initTaser3DWeapon() {
    if (this.weaponInitialized || !this.scene || !this.scene.taserModel) return;
    this.weaponInitialized = true;

    this.weaponGroup = new THREE.Group();
    this.weaponGroup.name = 'Taser7_WeaponMount';
    this.weaponGroup.visible = false;
    window.weaponGroup = this.weaponGroup;
    this.scene.taserModel.add(this.weaponGroup);

    const targetWeapon = this.createDetailedTaser7Weapon();
    this.weaponMesh = targetWeapon;
    window.weaponMesh = targetWeapon;
    this.weaponGroup.add(targetWeapon);

    // Bakre CID-skärm (vänd direkt mot skytten på manteln)
    this.ensureCIDCanvas();
    this.updateCIDTexture(true, true, 99, true, 1, false, 0);
    const cidMat = new THREE.MeshBasicMaterial({ map: this.cidTexture, side: THREE.DoubleSide, toneMapped: false });
    this.cidMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.032, 0.016), cidMat);
    this.cidMesh.position.set(0, 0.032, 0.0615);
    this.cidMesh.rotation.set(-0.22, 0, 0);
    this.cidMesh.renderOrder = 25;
    targetWeapon.add(this.cidMesh);

    // Kassettoverlays framtill (visar avfyrat X på C1/C2)
    const overlayGeo = new THREE.CircleGeometry(0.008, 16);
    this.chamber1Overlay = new THREE.Mesh(overlayGeo, new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.DoubleSide }));
    this.chamber1Overlay.position.set(0, 0.031, -0.1225);
    this.chamber1Overlay.visible = false;
    targetWeapon.add(this.chamber1Overlay);

    this.chamber2Overlay = new THREE.Mesh(overlayGeo.clone(), new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.DoubleSide }));
    this.chamber2Overlay.position.set(0, 0.013, -0.1225);
    this.chamber2Overlay.visible = false;
    targetWeapon.add(this.chamber2Overlay);

    // MuzzlePoint i lokal -Z riktning för dynamiska lasrar och catenary-trådar
    this.muzzlePoint = new THREE.Object3D();
    this.muzzlePoint.position.set(0, 0.023, -0.123);
    targetWeapon.add(this.muzzlePoint);
    window.muzzlePoint = this.muzzlePoint;
    this.scene.muzzlePoint = this.muzzlePoint;

    this.computeFallbackPose();
    this.handCurrentPos.copy(this._fallbackTargetPos);
    this.handCurrentQuat.copy(this._fallbackTargetQuat);
    this.handDetected = !this.isLiveAIRunning();
    window.handDetected = this.handDetected;
    this.weaponGroup.visible = this.handDetected;
    this.weaponGroup.position.copy(this.handCurrentPos);
    this.weaponGroup.quaternion.copy(this.handCurrentQuat);
    this.weaponGroup.scale.setScalar(0.88);
    this.weaponGroup.updateMatrixWorld(true);
    this.syncWeaponOverlays(this.fsm, this._cidActiveCycleCount || 0);
  }

  startHandTracking(videoEl) {
    if (this.isLiveAIRunning() || this.isSyntheticPassthrough || typeof window.Hands !== 'function') {
      this.stopHandTracking();
      return;
    }
    if (this.handLoopActive) return;
    this.handLoopActive = true;

    const pump = async (now) => {
      if (!this.handLoopActive || this.isLiveAIRunning()) {
        this.stopHandTracking();
        return;
      }
      requestAnimationFrame(pump);

      // Pausa inferens när användaren låst vapnet i höft-/siktläge
      if (this.weaponLockMode === 'locked_fallback') return;

      const v = videoEl || document.getElementById('camera-feed-left');
      if (!v || v.readyState < 2 || v.videoWidth <= 0 || v.paused) return;

      if (!this.handsInstance) {
        try {
          this.handsInstance = new window.Hands({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
          });
          this.handsInstance.setOptions({
            maxNumHands: 2,
            modelComplexity: 0,
            minDetectionConfidence: 0.55,
            minTrackingConfidence: 0.5
          });
          this.handsInstance.onResults((results) => {
            if (this.isLiveAIRunning() || this.weaponLockMode === 'locked_fallback') {
              this._consecutiveHandFrames = 0;
              return;
            }
            const landmarksList = (results && Array.isArray(results.multiHandLandmarks)) ? results.multiHandLandmarks : [];
            if (landmarksList.length > 0) {
              const handednessList = Array.isArray(results.multiHandedness) ? results.multiHandedness : [];
              let chosenIdx = 0;
              if (this.handPreference === 'right' || this.handPreference === 'left') {
                const want = this.handPreference === 'right' ? 'right' : 'left';
                const matchIdx = handednessList.findIndex((h) => String(h?.label || '').toLowerCase() === want);
                if (matchIdx >= 0) {
                  chosenIdx = matchIdx;
                } else {
                  this._consecutiveHandFrames = 0;
                  return;
                }
              }

              const lm = landmarksList[chosenIdx];
              const hLabel = handednessList[chosenIdx]?.label;
              if (hLabel) this.detectedHandedness = hLabel;

              // 3 kritiska landmarks: handled (0), pekfingrets knoge (5), lillfingrets knoge (17)
              const wrist = lm[0];
              const indexMcp = lm[5];
              const pinkyMcp = lm[17];
              if (!wrist || !indexMcp || !pinkyMcp) {
                this._consecutiveHandFrames = 0;
                return;
              }

              // Projektion från 2D kamera-rymd (FOV 78°) till 3D-kamerans lokala koordinatsystem
              const width = this.scene?.container?.clientWidth || window.innerWidth || 1;
              const height = this.scene?.container?.clientHeight || window.innerHeight || 1;
              const fullAspect = width / Math.max(1, height);
              const activeAspect = (this.isStereoVR && !(this.scene?.renderer?.xr?.isPresenting))
                ? Math.max(0.45, fullAspect * 0.5)
                : fullAspect;
              const tanHalfFov = Math.tan(THREE.MathUtils.degToRad((this.vrFov || VR_CAMERA_FOV) * 0.5));

              const palmSpan = Math.hypot(indexMcp.x - wrist.x, indexMcp.y - wrist.y);
              const knuckleSpan = Math.hypot(indexMcp.x - pinkyMcp.x, indexMcp.y - pinkyMcp.y);
              const apparentSize = Math.max(0.06, Math.min(0.45, palmSpan * 0.7 + knuckleSpan * 0.6));
              const targetZ = Math.max(-0.92, Math.min(-0.44, -0.78 + (apparentSize - 0.16) * 0.85));

              const anchorX = wrist.x * 0.35 + indexMcp.x * 0.65;
              const anchorY = wrist.y * 0.35 + indexMcp.y * 0.65;
              const ndcX = (anchorX - 0.5) * 2.0;
              const ndcY = -(anchorY - 0.5) * 2.0;

              const distAbs = Math.abs(targetZ);
              const halfH = distAbs * tanHalfFov;
              const halfW = halfH * activeAspect;

              this.handTargetPos.set(
                THREE.MathUtils.clamp(ndcX * halfW, -0.58, 0.58),
                THREE.MathUtils.clamp(ndcY * halfH - 0.04, -0.38, 0.28),
                targetZ
              );

              // Beräkna full 3D-orientering (pitch, yaw, roll) från handled (0) -> pekfinger (5) & lillfinger (17)
              const fwd = this._handFwd.set(
                (indexMcp.x - wrist.x) * 1.45,
                -(indexMcp.y - wrist.y) * 1.45,
                -Math.max(0.24, 0.44 + ((wrist.z || 0) - (indexMcp.z || 0)) * 1.25)
              );
              if (fwd.lengthSq() < 0.0001) fwd.set(0, 0, -1);
              fwd.normalize();

              const upRaw = this._handUp.set(
                indexMcp.x - pinkyMcp.x,
                -(indexMcp.y - pinkyMcp.y),
                -((indexMcp.z || 0) - (pinkyMcp.z || 0)) * 0.35
              );
              if (upRaw.lengthSq() < 0.002) upRaw.set(0, 1, 0);

              const rightVec = this._handRight.crossVectors(fwd, upRaw);
              if (rightVec.lengthSq() < 0.0001) {
                rightVec.set(1, 0, 0);
              } else {
                rightVec.normalize();
              }
              const orthoUp = this._handUp.crossVectors(rightVec, fwd).normalize();
              const backVec = this._handBack.copy(fwd).negate();

              this._handBasis.makeBasis(rightVec, orthoUp, backVec);
              this.handTargetQuat.setFromRotationMatrix(this._handBasis);

              // Kräv minst 3 konsekutiva godkända frames vid återgång från FALLBACK_READY
              this._consecutiveHandFrames = Math.min(this.HAND_REACQUIRE_FRAMES + 1, (this._consecutiveHandFrames || 0) + 1);
              if (this.weaponTrackState === 'FALLBACK_READY') {
                if (this._consecutiveHandFrames >= this.HAND_REACQUIRE_FRAMES) {
                  this.lastHandSeenTime = performance.now();
                  this.weaponTrackState = 'HAND_TRACKED';
                  this._returnBlendRemaining = 0.4;
                }
              } else {
                this.lastHandSeenTime = performance.now();
                this.weaponTrackState = 'HAND_TRACKED';
              }
            } else {
              // Tappad hand i denna frame: nollställ bekräftelseräknaren; frys/fallback sköts av updateWeaponPose
              this._consecutiveHandFrames = 0;
            }
          });
        } catch (_) {
          this.handsInstance = null;
        }
      }

      if (!this.handsInstance || this.handSending || now - this.lastHandSendTime < 33) return;
      this.handSending = true;
      this.lastHandSendTime = now;
      try {
        await this.handsInstance.send({ image: v });
      } catch (_) {
      } finally {
        this.handSending = false;
      }
    };
    requestAnimationFrame(pump);
  }

  stopHandTracking() {
    this.handLoopActive = false;
    this.handSending = false;
    this._consecutiveHandFrames = 0;
    this.lastHandSeenTime = 0;
    this.weaponTrackState = 'FALLBACK_READY';
    this.updateWeaponTrackBadge();
  }

  updateWeaponPose(delta = 0.016) {
    if (!this.weaponGroup || !this.weaponMesh) return;

    const isLiveAR = this.isLiveAIRunning();
    const isVisible = !isLiveAR;
    this.weaponGroup.visible = isVisible;
    this.handDetected = isVisible;
    window.handDetected = isVisible;
    window.appMode = isVisible ? 'vr' : 'vr-headset';

    if (!isVisible) {
      if (this.weaponArcGroup) this.weaponArcGroup.visible = false;
      if (this.weaponArcLight) this.weaponArcLight.intensity = 0;
      return;
    }

    const now = performance.now();
    const dt = Math.min(Math.max(Number(delta) || 0.016, 0.001), 0.05);

    // 3-stegs tillståndsmaskin: HAND_TRACKED -> GRACE_FREEZE (0–800 ms) -> FALLBACK_READY (efter 800 ms)
    if (this.weaponLockMode === 'locked_fallback') {
      this.weaponTrackState = 'FALLBACK_READY';
    } else if (this.lastHandSeenTime > 0) {
      const elapsedLostMs = now - this.lastHandSeenTime;
      if (elapsedLostMs <= 140) {
        if (this.weaponTrackState !== 'HAND_TRACKED' && this._consecutiveHandFrames >= this.HAND_REACQUIRE_FRAMES) {
          this.weaponTrackState = 'HAND_TRACKED';
        }
      } else if (elapsedLostMs <= this.HAND_GRACE_MS) {
        if (this.weaponTrackState === 'HAND_TRACKED') {
          this.weaponTrackState = 'GRACE_FREEZE';
        }
      } else {
        this.weaponTrackState = 'FALLBACK_READY';
      }
    } else {
      this.weaponTrackState = 'FALLBACK_READY';
    }

    if (this.weaponTrackState === 'HAND_TRACKED') {
      // Under de första ~0.4 s vid återgång från FALLBACK_READY glider Tasern mjukt tillbaka till handen
      let smoothAlpha;
      if (this._returnBlendRemaining > 0) {
        this._returnBlendRemaining = Math.max(0, this._returnBlendRemaining - dt);
        smoothAlpha = 1 - Math.exp(-dt / this.FALLBACK_TRANSITION_TAU);
      } else {
        smoothAlpha = 1 - Math.pow(1 - this.HAND_SMOOTHING, dt * 60);
      }
      this.handCurrentPos.lerp(this.handTargetPos, smoothAlpha);
      this.handCurrentQuat.slerp(this.handTargetQuat, smoothAlpha);
    } else if (this.weaponTrackState === 'GRACE_FREEZE') {
      // Läge 2 (0–800 ms): Håll 3D-Tasern helt stilla på sin senaste kända 3D-position utan hopp eller fladder
    } else {
      // Läge 3 (FALLBACK_READY): Glid mjukt (~0.4 s) in till ergonomisk standardposition riktad mot siktlinjen
      this.computeFallbackPose();
      const fbAlpha = 1 - Math.exp(-dt / this.FALLBACK_TRANSITION_TAU);
      this.handCurrentPos.lerp(this._fallbackTargetPos, fbAlpha);
      this.handCurrentQuat.slerp(this._fallbackTargetQuat, fbAlpha);
    }

    this.weaponGroup.scale.setScalar(0.88);
    this.weaponGroup.position.copy(this.handCurrentPos);
    this.weaponGroup.quaternion.copy(this.handCurrentQuat);
    this.weaponMesh.rotation.set(0, 0, 0);

    // Spegla säkringsspaken visuellt på 3D-modellen
    if (this._safetyLeverMesh) {
      const isSafeNow = !!this.fsm?.isSafe;
      this._safetyLeverMesh.rotation.x = isSafeNow ? 0.0 : -0.58;
      if (this._safetyLeverMesh.material) {
        this._safetyLeverMesh.material.color.setHex(isSafeNow ? 0x2ecc71 : 0xff4757);
        this._safetyLeverMesh.material.emissive.setHex(isSafeNow ? 0x0b3d1e : 0x5c0a14);
      }
    }

    this.updateWeaponArcEffect();
    this.weaponGroup.updateMatrixWorld(true);
    this.updateWeaponTrackBadge();
  }

  syncActiveCartridgeFromFSM(fsm) {
    if (!fsm) return 1;
    const c1 = String(fsm.chamber1 || '').toLowerCase();
    const c2 = String(fsm.chamber2 || '').toLowerCase();
    let active = 0;
    if (c1 === 'fired' && c2 === 'loaded') active = fsm.isFiring ? 1 : 2;
    else if (c2 === 'fired' && c1 === 'loaded') active = fsm.isFiring ? 2 : 1;
    else if (c1 === 'loaded' && c2 === 'loaded') active = fsm.activeChamber === 2 ? 2 : 1;
    window.activeCartridge = active;
    if (window.state) window.state.activeCartridge = active;
    return active;
  }

  syncWeaponOverlays(fsm, cycleCount = null) {
    if (!fsm) return;
    const c1 = String(fsm.chamber1 || '').toLowerCase();
    const c2 = String(fsm.chamber2 || '').toLowerCase();
    if (this.chamber1Overlay) this.chamber1Overlay.visible = c1 === 'fired';
    if (this.chamber2Overlay) this.chamber2Overlay.visible = c2 === 'fired';
    const resolved = this.syncActiveCartridgeFromFSM(fsm);
    const activeCycle = cycleCount !== null ? cycleCount : (this.fsm?.cycleTimer ? (this._cidActiveCycleCount || 1) : 0);
    this.updateCIDTexture(c1 === 'loaded', c2 === 'loaded', fsm.hasBattery ? 99 : 0, !!fsm.isSafe, resolved, !!fsm.functionCheckMode, activeCycle);
  }

  onChamberFired(firedChamber, fsm) {
    if (firedChamber === 1 && this.chamber1Overlay) this.chamber1Overlay.visible = true;
    if (firedChamber === 2 && this.chamber2Overlay) this.chamber2Overlay.visible = true;
    this.syncWeaponOverlays(fsm);
  }

  resetWeaponPhase4(fsm) {
    this._cidActiveCycleCount = 0;
    window.activeCartridge = 1;
    window.isFiring = false;
    if (window.state) { window.state.activeCartridge = 1; window.state.isFiring = false; }
    if (this.chamber1Overlay) this.chamber1Overlay.visible = false;
    if (this.chamber2Overlay) this.chamber2Overlay.visible = false;
    this.stopWeaponArcEffect();
    this.updateCIDTexture(true, true, fsm?.hasBattery ? 99 : 0, fsm ? !!fsm.isSafe : true, 1, fsm ? !!fsm.functionCheckMode : false, 0);
  }

  // =========================================================================
  // 12. MAIN VR / STEREO / WEBXR RENDER LOOP
  // =========================================================================
  startRenderLoop() {
    const renderer = this.scene.renderer;
    const camera = this.scene.camera;

    renderer.setAnimationLoop((timestamp, frame) => {
      this.pollGamepad();
      if (renderer.xr.isPresenting && this.xr.xrSession) {
        this.handleWebXRControllers(this.xr.xrSession);
      }

      const activeCamera = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : camera;
      const nowPerf = performance.now();
      const rawDt = (nowPerf - (this._lastPlacementTickTs || nowPerf)) / 1000;
      this._lastPlacementTickTs = nowPerf;
      const moveDt = Math.min(0.05, Math.max(0.004, rawDt || 0.016));
      const delta = Math.min(this.scene.clock.getDelta(), 0.1);
      const isScenarioActive = this.fsm.isScenarioActive || this.isScenarioActive;
      const currentThreat = typeof window.threatLevel === 'number' ? window.threatLevel : this.threatLevel;

      this.scene.update(delta, {
        isScenarioActive,
        threatLevel: currentThreat,
        threatWeapon: this.threatWeapon
      });

      if (isScenarioActive && currentThreat >= 3 && !this.scene.figureFallen && !this.scene.isTased && !this.isTased && !this.isGameOver && this.scene.taserGroup && this.scene.taserGroup.visible) {
        if (this.scene.activeAction !== this.scene.actions['Walk']) {
          this.scene.setAnimation('Walk', 0.8);
        }
        if (!renderer.xr.isPresenting) {
          const toShooter = this.scene._v1.set(0 - this.scene.taserGroup.position.x, 0, 3.0 - this.scene.taserGroup.position.z);
          const distNow = toShooter.length();
          if (distNow > 0.4) {
            toShooter.normalize();
            const walkWeight = (this.scene.actions && this.scene.actions['Walk']) ? this.scene.actions['Walk'].getEffectiveWeight() : 0;
            this.scene.taserGroup.position.addScaledVector(toShooter, this.scene.walkSpeed * walkWeight * delta);
            this.currentDistance = Math.max(0.4, Math.hypot(this.scene.taserGroup.position.x, this.scene.taserGroup.position.z - 3.0));
            this.updateAimVisuals();
          }
        }
      } else if ((!isScenarioActive || currentThreat < 3) && !this.scene.figureFallen && !this.isGameOver) {
        if (this.scene.activeAction === this.scene.actions['Walk']) {
          this.scene.setAnimation('Idle', 0.8);
        }
      }

      // Fail check (< 0.8m)
      if (!this.isPlacementActive() && !this.scene.figureFallen && !this.scene.isTased && !this.isTased && !this.isGameOver) {
        if (!renderer.xr.isPresenting) {
          if (this.currentDistance <= 0.8) this.triggerFailState();
        } else if (this.xr.figureLocked && this.scene.taserGroup && this.scene.taserGroup.visible) {
          const chestPos = this.scene._v1.set(this.scene.taserGroup.position.x, this.scene.taserGroup.position.y + 1.35, this.scene.taserGroup.position.z);
          if (activeCamera.position.distanceToSquared(chestPos) <= 0.64) this.triggerFailState();
        }
      }

      if (renderer.xr.isPresenting) {
        this.xr.handleXRFrame(timestamp, frame, activeCamera);
        if (this.xr.figureLocked && !this.isPlacementActive() && this.scene.taserGroup && this.scene.taserGroup.visible) {
          const chestPos = this.scene._v1.set(this.scene.taserGroup.position.x, this.scene.taserGroup.position.y + 1.35, this.scene.taserGroup.position.z);
          const rawDist = activeCamera.position.distanceTo(chestPos);
          if (!isNaN(rawDist) && rawDist > 0.1) {
            this.currentDistance = Math.max(0.4, rawDist);
            this.updateAimVisuals();
          }
        }
      }

      // Styr 3D-dummyn & golvmarkören med D-pad / styrspak / piltangenter i placeringsläge
      if (this.isPlacementActive()) {
        this.updatePlacementMovement(moveDt, activeCamera);
      } else if (this.scene.placementMarker && this.scene.placementMarker.visible) {
        this.scene.placementMarker.visible = false;
      }

      // ALWAYS keep scene background null & clear alpha 0 for transparent camera passthrough in VR
      if (this.scene.scene.background !== null) this.scene.scene.background = null;
      renderer.setClearColor(0x000000, 0);

      if (!renderer.xr.isPresenting) {
        if (camera.fov !== this.vrFov) {
          camera.fov = this.vrFov;
          camera.updateProjectionMatrix();
        }
        // Skyttens fasta position (0, 1.35, 3.0) så att dummyn flyttar sig visuellt i X/Z
        camera.position.set(0, 1.35, 3.0);
        const aimSpanDist = Math.max(1.5, this.currentDistance || 3.0);
        const lookTarget = this.scene._v2.set(
          (this.aimX - 50) * 0.022 * aimSpanDist,
          1.35 + (this.aimY - 50) * 0.022 * aimSpanDist,
          3.0 - aimSpanDist
        );
        camera.lookAt(lookTarget);
      }

      this.scene.updateWarningArc(activeCamera);
      this.updateWeaponPose(delta);
      if (this.weaponGroup && this.weaponGroup.visible) {
        // Dölj kameramonterad fallback-båge när 3D-handvapnets egna elektrodbågar & PointLight är aktiva
        if (this.scene.warningArcTubeMesh) this.scene.warningArcTubeMesh.visible = false;
        if (this.scene.warningArcCoreTubeMesh) this.scene.warningArcCoreTubeMesh.visible = false;
        if (this.scene.muzzleModel) this.scene.muzzleModel.visible = false;
        if (this.scene.arcSpriteGroup) this.scene.arcSpriteGroup.visible = false;
        if (this.scene.warningArcLight) this.scene.warningArcLight.intensity = 0;
      }
      this.scene.updateWireDynamics(activeCamera, delta);

      const currentCartridge = typeof window.activeCartridge === 'number'
        ? window.activeCartridge
        : ((this.fsm.chamber1 === ChamberState.LOADED || this.fsm.chamber2 === ChamberState.LOADED) ? this.fsm.activeChamber : 0);
      const isLiveARLoop = this.isLiveAIRunning();
      const flashlightOn = !this.fsm.isSafe && this.fsm.hasBattery && !this.fsm.stealthMode;
      const lasersOn = isLiveARLoop ? flashlightOn : (flashlightOn && currentCartridge > 0);

      // Hide DOM #live-target-overlay when Stereo split-screen is active (hud-canvas draws per-eye instead)
      const liveDomOverlay = document.getElementById('live-target-overlay');
      if (liveDomOverlay && isLiveARLoop && this.isStereoVR && !renderer.xr.isPresenting) {
        liveDomOverlay.style.display = 'none';
      }

      this.drawHudCanvas(flashlightOn, lasersOn);

      const isPlacingNow = this.isPlacementActive();
      const shouldShow3DLasers = lasersOn && !isLiveARLoop && !isPlacingNow;
      const aimNDC = this.scene._v3.set(0, 0, 0);

      const laserHit = this.scene.updateDynamicLaserRaycast(
        activeCamera,
        aimNDC,
        currentCartridge,
        (d, ch) => this.ballistics.calculateSpread(d, ch),
        shouldShow3DLasers,
        this.currentDistance || 3.0,
        null
      );

      if (laserHit && laserHit.hit && !isPlacingNow && !isLiveARLoop && (renderer.xr.isPresenting || (this.weaponGroup && this.weaponGroup.visible)) && !isNaN(laserHit.distance) && laserHit.distance > 0.1) {
        this.currentDistance = Math.max(0.4, laserHit.distance);
        this.updateAimVisuals();
      }

      if (this.isStereoVR && !renderer.xr.isPresenting && this.stereoEffect) {
        this.renderStereo(this.scene.scene, activeCamera);
      } else {
        renderer.render(this.scene.scene, activeCamera);
      }
    });
  }

  renderStereo(scene, camera) {
    if (!this.stereoEffect || !this.scene || !this.scene.renderer || !camera) return;
    const width = this.scene.container?.clientWidth || window.innerWidth || 1;
    const height = this.scene.container?.clientHeight || window.innerHeight || 1;
    const fullAspect = width / Math.max(1, height);
    const targetFov = this.vrFov || VR_CAMERA_FOV;

    // StereoCamera.update() multiplicerar redan camera.aspect med 0.5 för varje öga
    if (camera.fov !== targetFov || Math.abs(camera.aspect - fullAspect) > 0.001) {
      camera.fov = targetFov;
      camera.aspect = fullAspect;
      camera.updateProjectionMatrix();
    }

    this.stereoEffect.render(scene, camera);
  }

  enableStereoVR() {
    if (!this.scene || !this.scene.renderer) return;
    if (!this.stereoEffect) {
      this.stereoEffect = new StereoEffect(this.scene.renderer);
      this.stereoEffect.setEyeSeparation(0.064);
    }
    this.isStereoVR = true;
    this.scene.onResize();
    this.applyVRCameraProjection();
    const w = this.scene.container?.clientWidth || window.innerWidth;
    const h = this.scene.container?.clientHeight || window.innerHeight;
    if (w > 0 && h > 0) this.stereoEffect.setSize(w, h);
  }

  disableStereoVR() {
    this.isStereoVR = false;
    if (this.scene && this.scene.renderer) {
      this.scene.renderer.setScissorTest(false);
      this.scene.onResize();
    }
    this.applyVRCameraProjection();
  }

  startWarningArcHaptics() {
    this.stopWarningArcHaptics();
    if (!navigator.vibrate) return;
    const pulsePattern = [20, 30, 20, 30, 20, 30, 20, 30, 20];
    try { navigator.vibrate(pulsePattern); } catch (_) {}
    this.warningHapticInterval = setInterval(() => {
      if (this.scene && this.scene.warningArcActive && navigator.vibrate) {
        try { navigator.vibrate(pulsePattern); } catch (_) {}
      } else {
        this.stopWarningArcHaptics();
      }
    }, 250);
  }

  stopWarningArcHaptics() {
    if (this.warningHapticInterval) {
      clearInterval(this.warningHapticInterval);
      this.warningHapticInterval = null;
    }
    if (navigator.vibrate) {
      try { navigator.vibrate(0); } catch (_) {}
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new TaserVRApp();
});
