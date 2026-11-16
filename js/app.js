/**
 * TASER 7 Elite Tactical Simulator - Main Application Coordinator
 * High-performance mobile portrait layout, WebXR, Three.js, Media Session API & PWA.
 */

import * as THREE from 'three';
import { StereoEffect } from 'three/addons/effects/StereoEffect.js';
if (typeof window !== 'undefined') {
  window.THREE = THREE;
  window.StereoEffect = StereoEffect;
}
import { TaserFSM, ChamberState } from './fsm.js?v=10';
import { TaserAudio } from './audio.js?v=10';
import { TaserBallistics } from './ballistics.js?v=10';
import { TaserScene } from './scene.js?v=10';
import { TaserXR } from './xr.js?v=10';
import { TaserPWA } from './pwa.js?v=10';
import { TaserVoice } from './voice.js?v=10';
import { TaserAIPose } from './pose.js?v=10';

export class TaserApp {
  constructor() {
    if (typeof window !== 'undefined') window.taserApp = this;
    this.isStereoVR = false;
    this.stereoEffect = null;

    this.fsm = new TaserFSM();
    this.audio = new TaserAudio(this.fsm);
    this.ballistics = new TaserBallistics();

    const viewportEl = document.getElementById('three-canvas');
    this.scene = new TaserScene(viewportEl);

    this.xr = new TaserXR(this.scene, {
      onSessionStart: this.onXRSessionStart.bind(this),
      onSessionEnd: this.onXRSessionEnd.bind(this)
    });
    this.scene.xrManager = this.xr;

    this.pwa = new TaserPWA();

    // AI-Based Person Pose & Dynamic Hitbox Engine
    this.aiPose = new TaserAIPose(this.scene, this.scene.camera, {
      videoElement: document.getElementById('camera-feed-left') || document.getElementById('camera-feed'),
      onStatusChange: (detected, label) => {
        const tLabel = document.getElementById('target-label');
        const dLabel = document.getElementById('dist-label');
        if (tLabel && this.xr.useCamera) {
          tLabel.textContent = detected ? 'MÄNNISKA (AI LÅST: LIVE)' : 'SÖKER PERSON (AI)...';
          tLabel.classList.toggle('armed', detected);
        }
        if (dLabel && this.xr.useCamera && detected) {
          dLabel.textContent = `${this.aiPose.estimatedDistance.toFixed(1)} M (AI)`;
          this.currentDistance = this.aiPose.estimatedDistance;
          this.updateAimVisuals();
        }
      }
    });
    this.scene.aiPose = this.aiPose;

    // Voice Command Engine ('sv-SE')
    this.voice = new TaserVoice({
      onCommand: this.handleVoiceCommand.bind(this),
      onStatusChange: (active, label) => {
        const btn = document.getElementById('btn-voice');
        if (btn) {
          btn.innerHTML = active ? `🎙️ Röst: ${label}` : `🎙️ Röst: ${label}`;
          btn.classList.toggle('listening', active);
        }
      },
      onLog: (msg) => this.log(msg)
    });

    // Aim and Tracking State
    this.currentDistance = 3.0; // meters
    this.aimX = 50; // percentage
    this.aimY = 50; // percentage
    this.tilt = 0; // degrees (-90 to +90)
    this._gyroContinuousRoll = 0;
    this._hasGyroRoll = false;
    this._hudVisualDropPx = null;
    this._hudTiltDeg = 0;
    this._lastModalOpenAt = 0;

    // Threat escalation & Verbal warnings
    this.threatLevel = 0;
    this.threatWeapon = 'KNIFE'; // 'KNIFE' | 'BATON' | 'FISTS'
    this.threatInterval = null;
    this.nmiTimer = null;
    this.warningGiven = false;
    this.isScenarioActive = false;
    this.isTased = false;
    this.isGameOver = false;
    this.isFiring = false;
    this.liveWires = [];
    this.liveARRoomCode = null;

    this.initDOM();
    this.initFSMSubscriptions();
    this.initInputs();
    this.startRenderLoop();

    this.log("Simulator v7.47 (Tactical WebXR & PWA) startar... <span style='color:#f1c40f;'>Sätt i batteri!</span>");
    this.stopScenario();
  }

  log(msg) {
    const logBox = document.getElementById('log');
    if (!logBox) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `> ${msg}`;
    logBox.prepend(entry);
  }

  initDOM() {
    // Expose tactical methods to window for clean button handlers
    window.app = this;
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

    window.toggleCamera = () => this.toggleCameraAR();
    window.startRealPersonAI = () => this.startRealPersonAI();
    window.openScenarioModal = () => this.openModal('scenario-modal');
    window.startXR = (type) => this.startWebXR(type);
    window.togglePlaceMode = () => this.togglePlaceMode();
    window.confirmPlacement = () => this.confirmPlacement();
    window.initGyro = () => this.initGyro();
    window.openModal = (id) => this.openModal(id);
    window.closeModal = (id) => this.closeModal(id);
    window.promptInstall = () => this.pwa.promptInstall();
    window.toggleVoice = () => this.voice.toggle();
    window.testVoiceCommand = (cmd) => this.voice.simulateCommand(cmd);
    window.updateUI = () => this.updateDisplay();
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
        if (btnBatt) {
          btnBatt.style.borderColor = fsm.hasBattery ? '#2ecc71' : '';
        }
        this.updateDisplay();
      } else if (event === 'CASSETTE_CHANGED') {
        const cEl = document.getElementById('stat-cassette');
        const hasLoaded = fsm.chamber1 === ChamberState.LOADED;
        if (cEl) {
          cEl.textContent = hasLoaded ? '⏏️ Kassetter i' : '⏏️ Kassetter ur';
          cEl.classList.toggle('ok', hasLoaded);
        }
        const btnCass = document.getElementById('btn-cassette');
        if (btnCass) {
          btnCass.style.borderColor = hasLoaded ? '#2ecc71' : '';
        }
        if (fsm.chamber1 === ChamberState.EMPTY || (fsm.chamber1 === ChamberState.LOADED && fsm.chamber2 === ChamberState.LOADED && fsm.shotsFired === 0)) {
          this.liveWires = [];
          this.scene.clearWiresAndDarts();
          this.scene.resetTarget();
          this.stopScenario();
        }
        this.updateDisplay();
      } else if (event === 'SAFETY_CHANGED') {
        if (typeof window !== 'undefined' && window.state) {
          window.state.isSafe = !!fsm.isSafe;
        }
        const sSwitch = document.getElementById('safety-switch');
        const sLabel = document.getElementById('safety-label');
        const secControls = document.getElementById('secondary-controls');

        if (sSwitch) sSwitch.classList.toggle('unsafe', !fsm.isSafe);
        if (sLabel) sLabel.textContent = fsm.isSafe ? 'SÄKRAD' : 'OSÄKRAD';
        if (secControls) secControls.style.display = 'block';

        this.updateDisplay();
      } else if (event === 'FUNCTION_CHECK_CHANGED') {
        if (typeof window !== 'undefined' && window.state) {
          window.state.functionCheckMode = !!fsm.functionCheckMode;
        }
        const warnBtn = document.getElementById('btn-warn');
        if (warnBtn) {
          warnBtn.classList.toggle('active-funk', !!fsm.functionCheckMode);
          warnBtn.style.borderColor = fsm.functionCheckMode ? '#f1c40f' : '';
          warnBtn.style.boxShadow = fsm.functionCheckMode ? '0 0 10px rgba(241, 196, 15, 0.7), 0 3px 0 #0b0d10' : '';
        }
        this.updateDisplay();
      } else if (event === 'CHAMBER_CHANGED') {
        this.isFiring = !!fsm.isFiring;
        if (typeof window !== 'undefined' && typeof window.syncWeaponOverlays === 'function') {
          window.syncWeaponOverlays(this.fsm);
        } else if (typeof window !== 'undefined' && typeof window.syncActiveCartridgeFromFSM === 'function') {
          window.syncActiveCartridgeFromFSM(this.fsm);
        }
        this.updateAimVisuals();
        this.updateDisplay();
      } else if (event === 'DISPLAY_CHANGED') {
        this.updateDisplay();
      } else if (event === 'STEALTH_CHANGED') {
        const stBox = document.getElementById('stat-stealth');
        if (stBox) stBox.style.display = fsm.stealthMode ? 'block' : 'none';
        this.updateDisplay();
      } else if (event === 'CLOTHING_CHANGED') {
        const cBtn = document.getElementById('btn-clothing');
        if (cBtn) {
          cBtn.innerHTML = fsm.heavyClothing ? '🧥 Kläder: TJOCKA' : '🧥 Kläder: NORMAL';
          cBtn.style.borderColor = fsm.heavyClothing ? '#f1c40f' : '#1a252f';
        }
      } else if (event === 'SCENARIO_CHANGED') {
        this.isScenarioActive = payload.isScenarioActive;
        const btn = document.getElementById('btn-scenario');
        if (btn) {
          btn.innerHTML = this.isScenarioActive ? '⏸️ STOPPA ANGREPP' : '🚨 STARTA ANGREPP';
          btn.classList.toggle('active-attack', this.isScenarioActive);
        }
      } else if (event === 'CYCLE_STARTED') {
        this.log(`<span style='color:#3498db'>${payload.message} ⚡</span>`);
        const canvas = document.getElementById('three-canvas');
        if (payload.type === 'DARTS' || payload.type === 'DRIVE_STUN') {
          if (canvas) canvas.classList.add('flash');
          const lightning = document.getElementById('lightning');
          if (lightning) lightning.style.display = 'block';
        } else {
          // Warning Arc: Start Three.js 3D dynamic arc & pointlight, plus rhythmic pulse haptics
          this.scene.startWarningArc();
          this.startWarningArcHaptics();
        }
        this.audio.startElectricSound();
        const dEl = document.getElementById('taser-display');
        if (dEl) {
          // EXKLUSIVT funktionskontroll får gul inverterad skärm & gult gränssnitt
          const isFunk = payload.isFunk && (this.fsm.isFunkLocked || this.fsm.displayState === 'FUNK_MODE') && !this.fsm.isSafe;
          if (isFunk) {
            dEl.classList.add('oled-inverted', 'funk-mode', 'inverted');
          } else {
            dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
          }
          if (typeof document !== 'undefined') {
            document.body.classList.toggle('function-check-active', !!isFunk);
            document.documentElement.classList.toggle('function-check-active', !!isFunk);
          }
          dEl.innerHTML = `5 SEK<br>CYKEL: 1`;
        }
      } else if (event === 'CYCLE_TICK') {
        const dEl = document.getElementById('taser-display');
        if (dEl) {
          dEl.innerHTML = `5 SEK<br>CYKEL: ${payload.count}`;
        }
      } else if (event === 'CYCLE_ENDED') {
        const canvas = document.getElementById('three-canvas');
        if (canvas) canvas.classList.remove('flash');
        const lightning = document.getElementById('lightning');
        if (lightning) lightning.style.display = 'none';

        // Stop 3D Warning Arc and haptics
        this.scene.stopWarningArc();
        this.stopWarningArcHaptics();

        this.audio.stopElectricSound();
        this.log('Strömcykel avslutad.');

        const dEl = document.getElementById('taser-display');
        if (dEl && (!this.fsm.isFunkLocked || this.fsm.isSafe)) {
          dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
        }

        this.updateDisplay();
      } else if (event === 'RESET') {
        const dEl = document.getElementById('taser-display');
        if (dEl) {
          dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
        }
        if (typeof document !== 'undefined') {
          document.body.classList.remove('function-check-active');
          document.documentElement.classList.remove('function-check-active');
        }
        if (typeof window !== 'undefined' && window.state) {
          window.state.functionCheckMode = false;
          window.state.isSafe = !!fsm.isSafe;
        }
        const warnBtn = document.getElementById('btn-warn');
        if (warnBtn) {
          warnBtn.classList.remove('active-funk');
          warnBtn.style.borderColor = '';
          warnBtn.style.boxShadow = '';
        }
        this.hideNMIOverlay();
        this.isFiring = false;
        this.scene.stopWarningArc();
        this.stopWarningArcHaptics();
        this.currentDistance = 3.0;
        this.aimX = 50;
        this.aimY = 50;
        this.tilt = 0;
        if (typeof window !== 'undefined' && window.state) window.state.tilt = 0;
        this.warningGiven = false;
        this.updateWarningUI();
        this.scene.resetTarget();
        this.updateDisplay();
        this.stopScenario();
        if (typeof window !== 'undefined' && typeof window.syncWeaponOverlays === 'function') {
          window.syncWeaponOverlays(this.fsm);
        }
      }
    });
  }

  initInputs() {
    if (this.xr) {
      this.xr.onPhysicalTilt = (dir, gamma) => this.handlePhysicalTilt(dir, gamma);
    }

    // Auto-engage gyro immediately on devices without explicit permission barrier
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission !== 'function' &&
      !this.xr.gyroEnabled
    ) {
      this.initGyro(true);
    }

    // Unlock AudioContext and silent MediaSession loop on first pointer interaction
    const unlockAudio = () => {
      this.audio.init();
      if (this.audio.silentAudioEl) {
        this.audio.silentAudioEl.play().catch(() => {});
      }
      if (
        !this.xr.gyroEnabled &&
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission !== 'function'
      ) {
        this.initGyro(true);
      }
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });

    // Hardware/Bluetooth VR-joystick keydown-lyssnare hanteras globalt i index.html

    // Mobile Viewport Aiming via Touch
    const viewport = document.getElementById('viewport');
    if (viewport) {
      const handleTouchAim = (touch) => {
        if (this.xr.gyroEnabled || this.xr.placeMode || this.xr.xrSession) return;
        const rect = viewport.getBoundingClientRect();
        this.aimX = ((touch.clientX - rect.left) / rect.width) * 100;
        this.aimY = ((touch.clientY - rect.top) / rect.height) * 100;

        if (isNaN(this.aimX)) this.aimX = 50;
        if (isNaN(this.aimY)) this.aimY = 50;
        this.aimX = Math.max(0, Math.min(100, this.aimX));
        this.aimY = Math.max(0, Math.min(100, this.aimY));

        this.updateAimVisuals();
      };

      viewport.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) {
          handleTouchAim(e.touches[0]);
        }
      }, { passive: true });

      viewport.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches[0]) {
          handleTouchAim(e.touches[0]);
        }
      }, { passive: true });
    }

    // Touch- & pointer-optimized physical button bindings (0ms latency, haptics, mechanical depression)
    this.setupTactileButton('btn-trigger', () => this.handleTrigger());
    this.setupTactileButton('btn-kontaktstot', () => this.fsm.performKontaktstot());
    this.setupTactileButton('btn-scenario', () => this.toggleScenario());
    this.setupTactileButton('btn-cassette', () => window.toggleCassette());
    this.setupTactileButton('btn-battery', () => window.toggleBattery());
    this.setupTactileButton('btn-stealth', () => this.fsm.activateStealth());
    this.setupTactileButton('btn-warn', () => this.toggleFunctionCheck());
    this.setupTactileButton('btn-reset', () => this.resetSimulator());
    this.setupTactileButton('btn-fail-reset', () => this.resetSimulator());
    this.setupTactileButton('btn-clothing', () => this.fsm.toggleClothing());
    this.setupTactileButton('btn-voice', () => this.voice.toggle());
    this.setupTactileButton('btn-gyro', () => this.initGyro());

    const toggleWebXRModalOrEnd = () => {
      if (this.xr && this.xr.xrSession) {
        this.xr.endXRSession();
      } else {
        this.openModal('scenario-modal');
      }
    };
    // Primär WebXR-knapp: öppnar scenariomenyn omedelbart vid tryck (0ms) utan att bakgrundsklick råkar stänga modalen
    this.setupTactileButton('btn-webxr', toggleWebXRModalOrEnd, { preventDefaultOnDown: true });
    this.setupTactileButton('webxr-btn', toggleWebXRModalOrEnd, { preventDefaultOnDown: true });
    this.setupTactileButton('btn-place', () => this.togglePlaceMode(), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-info', () => this.openModal('info-modal'), { preventDefaultOnDown: true });
    this.setupTactileButton('warn-left', () => window.pressSingleWarning(), { preventDefaultOnDown: true });
    this.setupTactileButton('warn-right', () => window.pressSingleWarning(), { preventDefaultOnDown: true });
    this.setupTactileButton('safety-switch', () => window.toggleSafety(), { preventDefaultOnDown: true });
    const safetySwitchEl = document.getElementById('safety-switch');
    if (safetySwitchEl) {
      safetySwitchEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          window.toggleSafety();
        }
      });
    }
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
    this.setupTactileButton('btn-cancel-scenario', () => this.closeModal('scenario-modal'), { preventDefaultOnDown: true });
    this.setupTactileButton('btn-close-scenario', () => this.closeModal('scenario-modal'), { preventDefaultOnDown: true });

    // Scenario modal buttons - omedelbar visuell feedback ("⏳ STARTAR AR...") vid första touch + pålitlig aktivering för WebXR & kamera
    this.setupTactileButton('btn-start-real-person-xr', () => {
      this.startRealPersonAI();
    }, { xrAction: true, loadingText: '⏳ STARTAR LIVE AI...' });
    this.setupTactileButton('btn-xr-static', () => {
      this.startWebXR('static');
    }, { xrAction: true, loadingText: '⏳ STARTAR AR...' });
    this.setupTactileButton('btn-xr-moving', () => {
      this.startWebXR('moving');
    }, { xrAction: true, loadingText: '⏳ STARTAR AR...' });
    this.setupTactileButton('btn-xr-charging', () => {
      this.startWebXR('charging');
    }, { xrAction: true, loadingText: '⏳ STARTAR AR...' });

    // Stäng modal när man klickar på bakgrunden utanför modal-rutan (skyddad mot spökklick precis efter öppning)
    document.querySelectorAll('.modal-overlay').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          if (performance.now() - (this._lastModalOpenAt || 0) < 420) return;
          this.closeModal(modal.id);
        }
      });
    });

    // Reticle / floor placement tap in WebXR or Mobile Place mode
    const placementTarget = viewport || this.scene.renderer.domElement;
    if (placementTarget) {
      placementTarget.addEventListener('pointerdown', (e) => {
        if (!this.xr.isPlacing || !this.xr.placeMode) return;
        if (e.target && e.target.closest && e.target.closest('button')) return;

        if (this.xr.xrSession) {
          // I WebXR placeringsläge: tryck på skärmen låser måltavlan vid golvmarkören
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

    // Hindra WebXR DOM-overlay från att fånga tryck på vapnets knappar som XR-scen-select
    if (!this._beforeXrSelectBound && typeof document !== 'undefined') {
      this._beforeXrSelectBound = true;
      document.addEventListener('beforexrselect', (e) => {
        if (
          e.target &&
          e.target.closest &&
          e.target.closest('#main-container, .taser-device, .sim-controls, #btn-place-xr, #btn-back-menu, .modal-overlay, #fail-overlay, #tactical-error-banner, button, .action-btn, .safety-switch, .warning-btn')
        ) {
          e.preventDefault();
        }
      }, true);
    }
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
          try { navigator.vibrate(16); } catch (err) {}
        }

        try {
          callback(e);
        } catch (err) {
          console.error('Tactile button error on', el.id, err);
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
        if (e.pointerType !== 'touch') {
          onGestureDown(e.clientX || 0, e.clientY || 0);
        } else if (!pointerActive) {
          onGestureDown(e.clientX || 0, e.clientY || 0);
        }
      });

      // touchend bär giltig W3C user activation för både WebXR & getUserMedia och hindrar dubbeltriggning
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

      // Om webbläsaren avbryter pointer p.g.a. minimal mikrorörelse (<22px) inne i en modal, kör ändå direkt
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
        if (el.dataset.origHtml) {
          el.innerHTML = el.dataset.origHtml;
          el.classList.remove('is-loading');
        }
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
      if (now - lastActionTs < 200) {
        return;
      }
      lastActionTs = now;

      if (this.audio) {
        this.audio.init();
      }

      if (navigator.vibrate) {
        try { navigator.vibrate(14); } catch (err) {}
      }

      el.classList.add('active-press');
      setTimeout(clearPress, 160);

      try {
        callback(e);
      } catch (err) {
        console.error('Tactile button error on', el.id, err);
      }
    };

    // Enhetlig touch/pointerdown-hanterare + click-fallback om WebXR DOM-overlay sväljer pointerdown
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

  handleTrigger() {
    if (this.isFiring || this.fsm.isFiring || (typeof window !== 'undefined' && window.isFiring)) {
      return;
    }
    if (this.isGameOver) {
      this.audio.init();
      if (typeof this.audio.playClickSound === 'function') {
        this.audio.playClickSound();
      }
      this.showHudToast('⛔ Avtryckare spärrad — tryck Återställ', '#e74c3c');
      this.log("<span style='color:#e74c3c; font-weight:bold;'>AVTRYCKARE SPÄRRAD:</span> Angriparen har nått fram (< 0.8 m)! Tryck på Återställ för att börja om.");
      return;
    }
    if (!this.fsm.hasBattery) {
      this.audio.init();
      this.showHudToast('🔋 Sätt i batteri först!', '#f1c40f');
      this.log("<span style='color:#e74c3c'>Sätt i batteri först!</span>");
      return;
    }
    if (this.fsm.isSafe) {
      this.audio.init();
      this.showHudToast('🔒 Osäkra vapnet före avfyring!', '#f1c40f');
      this.log("<span style='color:#e74c3c'>Vapnet är säkrat. Osäkra vapnet först!</span>");
      return;
    }
    const chState = this.fsm.activeChamber === 1 ? this.fsm.chamber1 : this.fsm.chamber2;
    if (chState === ChamberState.EMPTY) {
      this.audio.init();
      if (typeof this.audio.playClickSound === 'function') this.audio.playClickSound();
      this.showHudToast('⏏️ Ladda kassett först!', '#f1c40f');
    }
    this.audio.init();
    const result = this.fsm.pressTrigger((firedChamber) => {
      this.audio.playPopSound();
      if (typeof window !== 'undefined' && typeof window.onChamberFired === 'function') {
        window.onChamberFired(firedChamber, this.fsm);
      }

      // Calculate ballistic coordinates
      const viewport = document.getElementById('viewport');
      const vHeight = viewport ? viewport.clientHeight : 320;
      const vWidth = viewport ? viewport.clientWidth : 320;
      const { ndc1, ndc2, spreadInfo } = this.ballistics.calculateNdcCoordinates(
        this.currentDistance,
        firedChamber,
        vHeight,
        this.tilt,
        vWidth
      );

      // Detect Live-AR (kamera + AI personspårning)
      const isLiveARActive = !!(
        (this.aiPose && typeof this.aiPose.isLiveARModeActive === 'function' && this.aiPose.isLiveARModeActive()) ||
        (typeof document !== 'undefined' && (
          document.body.classList.contains('live-ar-active') ||
          document.body.classList.contains('live-ai-active')
        ))
      );

      let hitResult;
      if (isLiveARActive) {
        const liveDist = (this.aiPose && this.aiPose.isPersonDetected && typeof this.aiPose.estimatedDistance === 'number')
          ? this.aiPose.estimatedDistance
          : (this.currentDistance || 3.0);
        const liveDropPx = this.ballistics.calculateLiveSpreadPx(liveDist, firedChamber, vHeight);
        const activeTiltDeg = this.getEffectiveTiltDeg();
        const liveHits = this.aiPose
          ? this.aiPose.checkScreenHit(this.aimX, this.aimY, liveDropPx, activeTiltDeg)
          : null;
        hitResult = liveHits || { hit1: null, hit2: null, hitWall1: true, hitWall2: true };
        this.spawnLiveARWires(firedChamber, hitResult, liveDropPx);
      } else {
        // Perform 3D raycast on mannequin or WebXR room surface (wall/floor/furniture)
        hitResult = this.scene.fireDarts({
          ndc1,
          ndc2,
          chamber: firedChamber,
          distance: this.currentDistance,
          tiltDeg: this.getEffectiveTiltDeg()
        });
      }

      // Evaluate NMI success
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

        // Skicka realtidsträff till ansluten Markör i Firestore om Live AR är aktivt
        if (isLiveARActive && this.liveARRoomCode && typeof window !== 'undefined' && window.taserFirebase && typeof window.taserFirebase.reportLiveHit === 'function') {
          window.taserFirebase.reportLiveHit(this.liveARRoomCode).then((ok) => {
            if (ok) {
              this.log(`<span style='color:#2ecc71; font-weight:bold;'>📡 Markör-träff skickad (Kod ${this.liveARRoomCode})!</span>`);
            }
          });
          const badgeEl = document.getElementById('live-ar-room-badge');
          if (badgeEl) {
            badgeEl.classList.add('hit-sent');
            setTimeout(() => badgeEl.classList.remove('hit-sent'), 2500);
          }
        }

        if (this.threatInterval) clearInterval(this.threatInterval);
        const sub = document.getElementById('subtitle-overlay');
        if (sub) sub.style.display = 'none';
        this.audio.suspectSpeak('Aaaargh!');

        // 1. & 2. Trigger NMI Stiff Fall: freeze pose in place and rotate stiffly like a falling tree
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
    this.updateAimVisuals();
  }

  toggleFunctionCheck() {
    const active = this.fsm.toggleFunctionCheck();
    if (typeof window !== 'undefined') {
      window.state = window.state || { tilt: 0, isSafe: !!this.fsm.isSafe, functionCheckMode: false };
      window.state.functionCheckMode = active;
    }
    this.updateDisplay();
    if (active) {
      if (!this.fsm.hasBattery) {
        this.showHudToast('⚠️ Funk. Kontroll vald (Sätt i batteri & osäkra)', '#FCBE00');
      } else if (this.fsm.isSafe) {
        this.showHudToast('⚠️ Funk. Kontroll vald — osäkra vapnet!', '#FCBE00');
      } else {
        this.showHudToast('⚡ FUNKTIONSKONTROLL AKTIV', '#FCBE00');
      }
    } else {
      this.showHudToast('Funktionskontroll AV', '#bdc3c7');
    }
    return active;
  }

  showHudToast(message, accentColor = '#f1c40f') {
    if (typeof document === 'undefined') return;
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

  toggleCartridge() {
    if (this.fsm.chamber1 === ChamberState.EMPTY && this.fsm.chamber2 === ChamberState.EMPTY) {
      const loaded = this.fsm.toggleCassette();
      this.updateDisplay();
      return loaded;
    }
    const switched = this.fsm.toggleCartridge();
    if (typeof window !== 'undefined' && typeof window.syncActiveCartridgeFromFSM === 'function') {
      window.syncActiveCartridgeFromFSM(this.fsm);
    }
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
    const isLiveAR = typeof document !== 'undefined' && (
      document.body.classList.contains('live-ar-active') ||
      document.body.classList.contains('live-ai-active') ||
      !!(this.aiPose && this.aiPose.isActive)
    );
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

  spawnLiveARWires(chamber, hitResult, dropPx) {
    const hudCanvas = document.getElementById('hud-canvas');
    const vp = document.getElementById('viewport');
    const w = (hudCanvas && hudCanvas.clientWidth) || (vp && vp.clientWidth) || window.innerWidth || 360;
    const h = (hudCanvas && hudCanvas.clientHeight) || (vp && vp.clientHeight) || window.innerHeight || 640;

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
        screenX: px,
        screenY: py,
        isHit: !!hitObj,
        isApproved: !!(hitObj && hitObj.isApproved),
        firedAt: performance.now()
      };
    };

    const probe1 = buildProbe(d1X, d1Y, hitResult ? hitResult.hit1 : null, 'top');
    const probe2 = buildProbe(d2X, d2Y, hitResult ? hitResult.hit2 : null, 'bottom');

    this.liveWires.push({
      chamber,
      firedAt: performance.now(),
      probes: [probe1, probe2]
    });
  }

  updateProjectors() {
    const flashlight = document.getElementById('flashlight');
    const laserGreen = document.getElementById('laser-green');
    const laserRed = document.getElementById('laser-red');

    const isLiveAR = typeof document !== 'undefined' && (
      document.body.classList.contains('live-ar-active') ||
      document.body.classList.contains('live-ai-active') ||
      !!(this.aiPose && this.aiPose.isActive)
    );
    const isXRPresenting = !!(this.scene && this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting);
    const isVRMode = !isLiveAR && (typeof window !== 'undefined') && (window.appMode === 'vr' || document.body.classList.contains('vr-active'));

    const hasCartridge = (this.fsm.chamber1 === ChamberState.LOADED || this.fsm.chamber2 === ChamberState.LOADED);
    const flashlightOn = !this.fsm.isSafe && this.fsm.hasBattery && !this.fsm.stealthMode;
    const shouldShow = isLiveAR ? flashlightOn : (flashlightOn && hasCartridge);

    if (isLiveAR && !isXRPresenting) {
      // Live-AR: #hud-canvas (z-index: 9999) ritar ficklampa, grön/röd laser, trådar och träffblixtar ovanpå video och AI-spårning
      if (flashlight) flashlight.style.display = 'none';
      if (laserGreen) laserGreen.style.display = 'none';
      if (laserRed) laserRed.style.display = 'none';
    } else if (isVRMode || isXRPresenting) {
      // VR & WebXR: 3D-laserpunkterna projiceras direkt i Three.js-scenen
      if (flashlight) flashlight.style.display = flashlightOn ? 'block' : 'none';
      if (laserGreen) laserGreen.style.display = 'none';
      if (laserRed) laserRed.style.display = 'none';
    } else {
      // Mobil/Handhållet standardläge: visa ficklampa och siktespunkter i 2D-HUD när vapnet är osäkrat och kassett är i
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

    const isLiveAR = typeof document !== 'undefined' && (
      document.body.classList.contains('live-ar-active') ||
      document.body.classList.contains('live-ai-active') ||
      !!(this.aiPose && this.aiPose.isActive)
    );
    const isXRPresenting = !!(this.scene && this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting);

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

    const hasWires = Array.isArray(this.liveWires) && this.liveWires.length > 0;
    if (!isLiveAR || isXRPresenting || (!flashlightOn && !lasersOn && !hasWires)) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const aimPctX = (typeof this.aimX === 'number' && !isNaN(this.aimX)) ? this.aimX : 50;
    const aimPctY = (typeof this.aimY === 'number' && !isNaN(this.aimY)) ? this.aimY : 50;
    const cx = (aimPctX / 100) * w;
    const cy = (aimPctY / 100) * h;

    if (flashlightOn) {
      const beamRadius = Math.max(160, Math.min(w, h) * 0.44);
      const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, beamRadius);
      grad.addColorStop(0.0, 'rgba(255, 255, 240, 0.34)');
      grad.addColorStop(0.45, 'rgba(255, 255, 255, 0.11)');
      grad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
      ctx.save();
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, beamRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    if (lasersOn) {
      const activeCh = this.fsm.activeChamber || 1;
      const liveDist = (this.aiPose && this.aiPose.isPersonDetected && typeof this.aiPose.estimatedDistance === 'number')
        ? this.aiPose.estimatedDistance
        : (this.currentDistance || 3.0);
      const targetDrop = this.ballistics.calculateLiveSpreadPx(liveDist, activeCh, h);
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

      // Övre grön laserpunkt (#00ff00)
      ctx.save();
      ctx.shadowColor = '#00ff00';
      ctx.shadowBlur = 16;
      ctx.fillStyle = 'rgba(0, 255, 0, 0.42)';
      ctx.beginPath();
      ctx.arc(cx, cy, 9.5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#00ff00';
      ctx.beginPath();
      ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Undre röd laserpunkt (#ff0000) som roterar och skalas mjukt i realtid utifrån avstånd & lutning
      const pulse = 0.65 + 0.35 * Math.sin(performance.now() * 0.025);
      const rx = cx + dx;
      const ry = cy + dy;

      ctx.save();
      ctx.shadowColor = '#ff0000';
      ctx.shadowBlur = 16;
      ctx.fillStyle = `rgba(255, 0, 0, ${(0.42 * pulse).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(rx, ry, 9.5 * (0.9 + 0.15 * pulse), 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(255, 24, 24, ${pulse.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(rx, ry, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 2D-trådar, sonder och träffblixtar synkade mot AI:ns bounding box i Live-AR
    if (hasWires) {
      const now = performance.now();
      const canvasRect = hudCanvas.getBoundingClientRect();
      const taserSightEl = document.querySelector('.taser-device .sights') || document.querySelector('.taser-device');
      let muzzleBaseX = w * 0.5;
      let muzzleBaseY = h - 24;
      if (taserSightEl && canvasRect.width > 0) {
        const sr = taserSightEl.getBoundingClientRect();
        if (sr.width > 0 && sr.top > 0 && sr.top < canvasRect.bottom) {
          muzzleBaseX = (sr.left + sr.width * 0.5) - canvasRect.left;
          muzzleBaseY = Math.max(20, (sr.top - canvasRect.top) + 4);
        }
      }

      const liveBox = (this.aiPose && typeof this.aiPose.getCurrentScreenBox === 'function')
        ? this.aiPose.getCurrentScreenBox()
        : null;
      const cycleActive = !!this.fsm.cycleTimer;

      for (let wIdx = 0; wIdx < this.liveWires.length; wIdx++) {
        const wireSet = this.liveWires[wIdx];
        const ageMs = now - wireSet.firedAt;
        const resolvedPts = [];

        for (let pIdx = 0; pIdx < wireSet.probes.length; pIdx++) {
          const p = wireSet.probes[pIdx];
          let tx = p.screenX;
          let ty = p.screenY;

          if (p.attachedToBox && liveBox && liveBox.width > 0 && liveBox.height > 0) {
            tx = liveBox.left + p.relX * liveBox.width;
            ty = liveBox.top + p.relY * liveBox.height;
          }
          resolvedPts.push({ tx, ty, probe: p });

          const chamberOffX = wireSet.chamber === 1 ? -11 : 11;
          const slotOffY = p.slot === 'top' ? -4 : 4;
          const ox = muzzleBaseX + chamberOffX;
          const oy = muzzleBaseY + slotOffY;

          // Koppartråd från vapnets mynning längst ner till målpunkten
          const midX = (ox + tx) * 0.5 + (p.slot === 'top' ? -8 : 8);
          const midY = (oy + ty) * 0.5 + 22;

          ctx.save();
          ctx.lineWidth = 1.8;
          ctx.strokeStyle = 'rgba(212, 132, 62, 0.92)';
          ctx.shadowColor = 'rgba(184, 115, 51, 0.6)';
          ctx.shadowBlur = 3;
          ctx.beginPath();
          ctx.moveTo(ox, oy);
          ctx.quadraticCurveTo(midX, midY, tx, ty);
          ctx.stroke();

          // Metallspets/sond på träffpunkten
          ctx.shadowBlur = 0;
          ctx.fillStyle = '#e2e8f0';
          ctx.beginPath();
          ctx.arc(tx, ty, 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1;
          ctx.stroke();

          // Initial träffblixt (impact flash) ~520 ms vid avfyrning
          if (ageMs < 520) {
            const flashAlpha = Math.max(0, 1 - ageMs / 520);
            const radius = 14 + (1 - flashAlpha) * 24;
            const flashGrad = ctx.createRadialGradient(tx, ty, 1, tx, ty, radius);
            if (p.isHit) {
              flashGrad.addColorStop(0.0, `rgba(255, 255, 255, ${flashAlpha.toFixed(3)})`);
              flashGrad.addColorStop(0.35, `rgba(112, 214, 255, ${(0.95 * flashAlpha).toFixed(3)})`);
              flashGrad.addColorStop(1.0, 'rgba(56, 189, 248, 0)');
            } else {
              flashGrad.addColorStop(0.0, `rgba(255, 245, 200, ${flashAlpha.toFixed(3)})`);
              flashGrad.addColorStop(0.4, `rgba(255, 170, 0, ${(0.85 * flashAlpha).toFixed(3)})`);
              flashGrad.addColorStop(1.0, 'rgba(255, 170, 0, 0)');
            }
            ctx.fillStyle = flashGrad;
            ctx.beginPath();
            ctx.arc(tx, ty, radius, 0, Math.PI * 2);
            ctx.fill();

            // Gniststrålar
            ctx.strokeStyle = p.isHit
              ? `rgba(165, 243, 252, ${flashAlpha.toFixed(3)})`
              : `rgba(253, 224, 71, ${flashAlpha.toFixed(3)})`;
            ctx.lineWidth = 1.6;
            for (let s = 0; s < 6; s++) {
              const ang = (s / 6) * Math.PI * 2 + (ageMs * 0.015);
              const r1 = 5;
              const r2 = 12 + flashAlpha * 14;
              ctx.beginPath();
              ctx.moveTo(tx + Math.cos(ang) * r1, ty + Math.sin(ang) * r1);
              ctx.lineTo(tx + Math.cos(ang) * r2, ty + Math.sin(ang) * r2);
              ctx.stroke();
            }
          }
          ctx.restore();
        }

        // Kontinuerlig elektrisk ljusbåge och träffglöd mellan sonderna under aktiv 5-sekunderscykel
        if (cycleActive && resolvedPts.length === 2 && resolvedPts[0].probe.isHit && resolvedPts[1].probe.isHit) {
          const pA = resolvedPts[0];
          const pB = resolvedPts[1];
          ctx.save();
          ctx.strokeStyle = '#70d6ff';
          ctx.shadowColor = '#38bdf8';
          ctx.shadowBlur = 12;
          ctx.lineWidth = 2.0;
          ctx.beginPath();
          ctx.moveTo(pA.tx, pA.ty);
          const steps = 6;
          for (let st = 1; st < steps; st++) {
            const t = st / steps;
            const jx = (Math.random() - 0.5) * 14;
            const jy = (Math.random() - 0.5) * 10;
            ctx.lineTo(pA.tx + (pB.tx - pA.tx) * t + jx, pA.ty + (pB.ty - pA.ty) * t + jy);
          }
          ctx.lineTo(pB.tx, pB.ty);
          ctx.stroke();

          // Elektriska kontaktblixtar vid båda sonder under strömcykeln
          [pA, pB].forEach((pt) => {
            const pulseR = 9 + Math.random() * 6;
            const g = ctx.createRadialGradient(pt.tx, pt.ty, 1, pt.tx, pt.ty, pulseR);
            g.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
            g.addColorStop(0.45, 'rgba(112, 214, 255, 0.65)');
            g.addColorStop(1, 'rgba(56, 189, 248, 0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(pt.tx, pt.ty, pulseR, 0, Math.PI * 2);
            ctx.fill();
          });
          ctx.restore();
        }
      }
    }
  }

  renderIconsHTML() {
    const renderBaySVG = (chamberState, chamberNum, isActive) => {
      const activeGlow = isActive ? 'active-bay' : '';
      if (chamberState === ChamberState.LOADED) {
        return `
          <svg class="cassette-svg loaded ${activeGlow}" viewBox="0 0 24 24" width="22" height="22">
            <rect x="2" y="2" width="20" height="20" rx="2" class="box" />
          </svg>
        `;
      } else if (chamberState === ChamberState.FIRED) {
        // Spent / fired: box with distinct X cross
        return `
          <svg class="cassette-svg fired ${activeGlow}" viewBox="0 0 24 24" width="22" height="22">
            <rect x="2" y="2" width="20" height="20" rx="2" class="box" />
            <line x1="5" y1="5" x2="19" y2="19" class="cross" />
            <line x1="19" y1="5" x2="5" y2="19" class="cross" />
          </svg>
        `;
      } else {
        // Empty bay: tactical dashed box with diagonal slash (/)
        return `
          <svg class="cassette-svg empty ${activeGlow}" viewBox="0 0 24 24" width="22" height="22">
            <rect x="2" y="2" width="20" height="20" rx="2" class="box dashed" />
            <line x1="5" y1="19" x2="19" y2="5" class="slash" />
          </svg>
        `;
      }
    };

    const isCh1Active = this.fsm.activeChamber === 1;
    const isCh2Active = this.fsm.activeChamber === 2;
    const line1 = isCh1Active ? 'show' : '';
    const line2 = isCh2Active ? 'show' : '';

    return `
      <div class="display-icons">
        <div class="chamber-col">
          ${renderBaySVG(this.fsm.chamber1, 1, isCh1Active)}
          <div class="active-line ${line1}"></div>
        </div>
        <div class="icon-battery-wrap full">
          <div class="batt-nub"></div>
          <div class="batt-body"></div>
        </div>
        <div class="chamber-col">
          ${renderBaySVG(this.fsm.chamber2, 2, isCh2Active)}
          <div class="active-line ${line2}"></div>
        </div>
      </div>
    `;
  }

  updateDisplay() {
    if (this.fsm.cycleTimer) return;
    this.updateAimVisuals();

    if (typeof window !== 'undefined') {
      window.state = window.state || { tilt: 0, isSafe: true, functionCheckMode: false };
      window.state.isSafe = !!this.fsm.isSafe;
      window.state.functionCheckMode = !!this.fsm.functionCheckMode;
    }

    const dEl = document.getElementById('taser-display');
    if (!dEl) return;

    // CID-skärmen ska ALLTID vara helt släckt/svart när vapnet saknar batteri eller är säkrat
    if (!this.fsm.hasBattery || this.fsm.isSafe) {
      dEl.innerHTML = '';
      dEl.className = 'display-screen';
      dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted', 'dimmed');
      if (typeof document !== 'undefined') {
        document.body.classList.remove('function-check-active');
        document.documentElement.classList.remove('function-check-active');
      }
      const driveStunBtn = document.getElementById('btn-kontaktstot');
      if (driveStunBtn) driveStunBtn.style.display = 'none';
      this.updateProjectors();
      if (typeof window !== 'undefined' && typeof window.syncWeaponOverlays === 'function') {
        window.syncWeaponOverlays(this.fsm);
      }
      return;
    }

    dEl.classList.toggle('dimmed', this.fsm.stealthMode);

    // Inverterat Funktionskontroll-läge när functionCheckMode är aktivt och vapnet är osäkrat
    const isFunkMode = !!this.fsm.functionCheckMode || (typeof window !== 'undefined' && window.state && !!window.state.functionCheckMode);
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('function-check-active', isFunkMode);
      document.documentElement.classList.toggle('function-check-active', isFunkMode);
    }

    if (isFunkMode) {
      // FUNKTIONSKONTROLL: Taser-gul bakgrund med svarta ikoner/text
      dEl.innerHTML = this.renderIconsHTML();
      dEl.classList.add('oled-inverted', 'funk-mode', 'inverted');
    } else {
      // Skarpt osäkrat läge: Svart OLED-bakgrund med lysande gula symboler
      dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
      dEl.innerHTML = this.renderIconsHTML();
    }

    this.updateProjectors();

    const driveStunBtn = document.getElementById('btn-kontaktstot');
    if (driveStunBtn) {
      const isLiveARNow = typeof document !== 'undefined' && (
        document.body.classList.contains('live-ar-active') ||
        document.body.classList.contains('live-ai-active')
      );
      const bothFired = this.fsm.chamber1 === ChamberState.FIRED && this.fsm.chamber2 === ChamberState.FIRED;
      driveStunBtn.style.display = (!isLiveARNow && bothFired && !this.fsm.isSafe) ? 'block' : 'none';
    }

    if (typeof window !== 'undefined' && typeof window.syncWeaponOverlays === 'function') {
      window.syncWeaponOverlays(this.fsm);
    }
  }

  animateWarningButtons() {
    const leftBtn = document.getElementById('warn-left');
    const rightBtn = document.getElementById('warn-right');
    if (leftBtn) leftBtn.classList.add('active-press');
    if (rightBtn) rightBtn.classList.add('active-press');
    setTimeout(() => {
      if (leftBtn) leftBtn.classList.remove('active-press');
      if (rightBtn) rightBtn.classList.remove('active-press');
    }, 200);
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

    // 1. Halt scenario & advance
    this.isScenarioActive = false;
    this.fsm.isScenarioActive = false;
    if (this.threatInterval) {
      clearInterval(this.threatInterval);
      this.threatInterval = null;
    }

    // 2. Freeze animation mixer completely (stop walking cycle and motion)
    if (this.scene && this.scene.mixer) {
      this.scene.mixer.timeScale = 0.0;
    }

    // 3. Audio & tactile warning
    this.audio.init();
    if (typeof this.audio.playClickSound === 'function') {
      this.audio.playClickSound();
    }
    if (typeof this.audio.suspectSpeak === 'function') {
      this.audio.suspectSpeak("Fick dig!");
    }
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([250, 100, 250]);
    }

    // 4. Show full-screen fail overlay
    this.showFailOverlay();

    // 5. Update UI buttons and log
    const btn = document.getElementById('btn-scenario');
    if (btn) {
      btn.innerHTML = '🚨 ANGREPP AVBRÖTS';
      btn.classList.remove('active-attack');
    }

    this.log("<span style='color:#e74c3c; font-weight:bold;'>ÖVNING AVBRUTEN:</span> Angriparen nådde fram (&lt; 0.8 m)! Taser-avtryckaren har spärrats. Tryck Återställ för att starta om.");
  }

  showFailOverlay() {
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
      if (this.warningGiven) {
        badge.textContent = '⚠️ VARNING DELGIVEN';
      }
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
    if (roll < 0.40) {
      this.threatWeapon = 'KNIFE'; // 40% Kniv
    } else if (roll < 0.70) {
      this.threatWeapon = 'BATON'; // 30% Batong / tillhygge
    } else {
      this.threatWeapon = 'FISTS'; // 30% Knytnävar / obeväpnad
    }
    if (this.scene) {
      if (typeof this.scene.setThreatWeapon === 'function') {
        this.scene.setThreatWeapon(this.threatWeapon);
      } else {
        this.scene.activeThreatWeapon = this.threatWeapon;
        if (typeof this.scene.updateWeaponVisibility === 'function') {
          this.scene.updateWeaponVisibility();
        }
      }
    }
    return this.threatWeapon;
  }

  startScenario() {
    this.isScenarioActive = true;
    this.fsm.isScenarioActive = true;

    // Slumpa hotvapen (Kniv, Batong eller Knytnävar) för detta angrepp
    this.rollThreatWeapon();

    // 1. Explicitly restore 3D figure visibility (procedure phase exit / scenario start)
    this.scene.set3DVisibility(true);
    if (this.scene.taserGroup) {
      this.scene.taserGroup.visible = true;

      // 2. If figure had fallen in previous engagement, reset upright position and animations
      if (this.scene.figureFallen) {
        this.scene.resetTarget();
      }

      // 3. Standoff distance & Z-axis coordinates
      if (this.xr && this.xr.xrSession) {
        // In WebXR AR space
        this.xr.isPlacing = false;
        this.xr.placeMode = false;
        this.xr.figureLocked = true;
        if (typeof window !== 'undefined') window.isPlacing = false;
        document.body.classList.remove('xr-placing');
        document.documentElement.classList.remove('xr-placing');
        const btnPlaceXr = document.getElementById('btn-place-xr');
        if (btnPlaceXr) btnPlaceXr.style.display = 'none';
        const plcCtrl = document.getElementById('placement-controls');
        if (plcCtrl) plcCtrl.style.display = 'none';
        const stdCtrl = document.getElementById('standard-controls');
        if (stdCtrl) stdCtrl.style.display = 'block';
        const hint = document.getElementById('place-hint');
        if (hint) hint.classList.remove('visible');
        if (this.scene.placementMarker) this.scene.placementMarker.visible = false;

        const cam = this.scene.renderer.xr.getCamera(this.scene.camera);
        const camPos = cam.position;
        const currentPos = this.scene.taserGroup.position;
        const distToCam = currentPos.distanceTo(camPos);

        // If at world origin (0,0,0) or behind/inside camera frustum, spawn 3.0m in front along gaze
        if (!this.scene.taserGroup.userData.startPos || distToCam < 0.8 || (currentPos.x === 0 && currentPos.y === 0 && currentPos.z === 0)) {
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
          forward.y = 0;
          if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
          forward.normalize().multiplyScalar(3.0);

          this.scene.taserGroup.position.set(
            camPos.x + forward.x,
            0, // ground level
            camPos.z + forward.z
          );
          this.scene.taserGroup.rotation.set(0, 0, 0);
          this.scene.taserGroup.quaternion.identity();
          if (this.scene.glbDummy) {
            this.scene.glbDummy.rotation.set(0, 0, 0);
            this.scene.glbDummy.quaternion.identity();
          }
          this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
        }
      } else {
        // Standard 3D perspective viewport
        if (!this.scene.taserGroup.userData.startPos) {
          this.scene.taserGroup.userData.startPos = new THREE.Vector3(0, 0, 0);
        }
        this.scene.taserGroup.position.copy(this.scene.taserGroup.userData.startPos);
        this.scene.taserGroup.rotation.set(0, 0, 0);
        this.currentDistance = 3.0;
        this.updateAimVisuals();
      }
    }

    if (this.scene) {
      this.scene.armOverrideWeight = 0;
      this.scene.updateWeaponVisibility();
    }
    this.scene.setAnimation('Idle', 0.2);

    this.log("<span style='color:#e74c3c; font-weight:bold;'>🚨 SCENARIOFAS STARTAD:</span> Hotet aktiverat! Var beredd!");

    const btn = document.getElementById('btn-scenario');
    if (btn) {
      btn.innerHTML = '⏸️ STOPPA ANGREPP';
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
    if (typeof window !== 'undefined') window.threatLevel = 0;

    this.threatWeapon = 'KNIFE';
    if (this.scene) {
      if (typeof this.scene.setThreatWeapon === 'function') {
        this.scene.setThreatWeapon('KNIFE');
      } else {
        this.scene.activeThreatWeapon = 'KNIFE';
      }
      this.scene.armOverrideWeight = 0;
      if (typeof this.scene.updateWeaponVisibility === 'function') {
        this.scene.updateWeaponVisibility();
      }
    }
    this.warningGiven = false;
    this.updateWarningUI();

    const isLiveARRunning = !!(
      (this.aiPose && this.aiPose.isActive) ||
      document.body.classList.contains('live-ar-active') ||
      document.body.classList.contains('live-ai-active')
    );

    if (isLiveARRunning) {
      this.scene.set3DVisibility(false);
    } else {
      // Ensure 3D figure remains visible in procedural phase (never disappear)
      this.scene.set3DVisibility(true);
      if (this.scene.taserGroup) this.scene.taserGroup.visible = true;

      // Smoothly ensure figure is strictly in Idle animation
      if (!this.scene.figureFallen) {
        this.scene.setAnimation('Idle', 0.5);
      }

      // Reset Z position to initial standoff
      if (this.scene.taserGroup && this.scene.taserGroup.userData.startPos) {
        this.scene.taserGroup.position.copy(this.scene.taserGroup.userData.startPos);
        this.currentDistance = 3.0;
        this.updateAimVisuals();
      }
    }

    const btn = document.getElementById('btn-scenario');
    if (btn) {
      btn.innerHTML = '🚨 STARTA ANGREPP';
      btn.classList.remove('active-attack');
    }

    const tLabel = document.getElementById('target-label');
    if (tLabel && !isLiveARRunning) {
      tLabel.textContent = 'PERSON (3D): PROCEDURFAS';
      tLabel.classList.remove('armed');
    }

    const sub = document.getElementById('subtitle-overlay');
    if (sub) sub.style.display = 'none';

    this.log("<span style='color:#3498db; font-weight:bold;'>🛠️ PROCEDURFAS AKTIV:</span> Hotet fryst i Idle. Träna laddning och funktionskontroll i lugn och ro.");
  }

  startThreatEscalation() {
    this.threatLevel = 0;
    if (typeof window !== 'undefined') window.threatLevel = 0;
    if (this.scene) {
      this.scene.armOverrideWeight = 0;
      this.scene.updateWeaponVisibility();
    }
    if (this.threatInterval) clearInterval(this.threatInterval);
    this.warningGiven = false;
    this.updateWarningUI();
    this.scene.setAnimation('Idle', 0.4);

    // Initial suspect vocalization at 700ms so user receives rapid feedback
    setTimeout(() => {
      if (this.isScenarioActive && !this.scene.figureFallen) {
        this.threatLevel = 1;
        if (typeof window !== 'undefined') window.threatLevel = this.threatLevel;
        this.suspectSpeak('Vad fan glor du på?! Backa!');
      }
    }, 700);

    this.threatInterval = setInterval(() => {
      if (!this.isScenarioActive || this.scene.figureFallen || !this.scene.taserGroup || !this.scene.taserGroup.visible) return;

      this.threatLevel++;
      if (typeof window !== 'undefined') window.threatLevel = this.threatLevel;

      const tLabel = document.getElementById('target-label');
      if (this.threatLevel === 2) {
        this.suspectSpeak('Rör mig inte sa jag! Stick!');
      } else if (this.threatLevel === 3) {
        // Hotfull eskalering: armarna intar attackpose och figuren avancerar
        if (typeof this.scene.setThreatWeapon === 'function') {
          this.scene.setThreatWeapon(this.threatWeapon);
        } else {
          this.scene.activeThreatWeapon = this.threatWeapon;
          if (typeof this.scene.updateWeaponVisibility === 'function') {
            this.scene.updateWeaponVisibility();
          }
        }
        this.scene.setAnimation('Walk', 0.5);

        if (this.threatWeapon === 'KNIFE') {
          this.suspectSpeak('Jag sprättar dig! Jag svär!');
          this.log("<span style='color:red; font-weight:bold;'>VARNING: Målet har dragit kniv! Omedelbar respons krävs!</span>");
          if (tLabel) {
            tLabel.textContent = 'PERSON: BEVÄPNAD (KNIV)';
            tLabel.classList.add('armed');
          }
        } else if (this.threatWeapon === 'BATON') {
          this.suspectSpeak('Jag slår ihjäl dig! Backa!');
          this.log("<span style='color:red; font-weight:bold;'>VARNING: Målet har dragit en batong! Omedelbar respons krävs!</span>");
          if (tLabel) {
            tLabel.textContent = 'PERSON: BEVÄPNAD (BATONG)';
            tLabel.classList.add('armed');
          }
        } else {
          this.suspectSpeak('Jag ska spöa skiten ur dig!');
          this.log("<span style='color:red; font-weight:bold;'>VARNING: Målet intar hotfull boxargard (knytnävar)!</span>");
          if (tLabel) {
            tLabel.textContent = 'PERSON: ANGREPP (KNYTNÄVAR)';
            tLabel.classList.add('armed');
          }
        }
      }
    }, 4500);
  }

  suspectSpeak(text) {
    const subtitle = document.getElementById('subtitle-overlay');
    if (subtitle) {
      subtitle.textContent = `MÅL: "${text}"`;
      subtitle.style.display = 'block';
      setTimeout(() => {
        subtitle.style.display = 'none';
      }, 4000);
    }
    this.audio.suspectSpeak(text);
  }

  handleVoiceCommand(cmd, transcript) {
    // --- 1. VAPENKOMMANDON VIA RÖST (Fungerar alltid oavsett målets status) ---
    if (cmd === 'VAPEN_OSAKRA') {
      if (!this.fsm.hasBattery) {
        this.showHudToast('🔋 Sätt i batteri först!', '#f1c40f');
        this.log("<span style='color:#e74c3c'>Röstkommando 'Osäkra': Sätt i batteri först!</span>");
        return;
      }
      if (!this.fsm.isSafe) {
        this.showHudToast('Vapnet är redan osäkrat', '#f1c40f');
        this.log('Vapnet är redan osäkrat.');
        return;
      }
      window.toggleSafety();
      this.log("<span style='color:#2ecc71; font-weight:bold;'>🎙️ RÖSTKOMMANDO: Osäkra!</span>");
      return;
    }

    if (cmd === 'VAPEN_SAKRA') {
      if (!this.fsm.hasBattery) {
        this.showHudToast('🔋 Vapnet saknar batteri', '#bdc3c7');
        return;
      }
      if (this.fsm.isSafe) {
        this.showHudToast('Vapnet är redan säkrat', '#bdc3c7');
        this.log('Vapnet är redan säkrat.');
        return;
      }
      window.toggleSafety();
      this.log("<span style='color:#2ecc71; font-weight:bold;'>🎙️ RÖSTKOMMANDO: Säkra!</span>");
      return;
    }

    if (cmd === 'VAPEN_AVFYRA') {
      this.showHudToast('🎙️ Röst: AVFYRA!', '#e74c3c');
      this.log("<span style='color:#e74c3c; font-weight:bold;'>🎙️ RÖSTKOMMANDO: Avfyra!</span>");
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
        this.showHudToast(`🔄 Röst: Växlat till K${this.fsm.activeChamber}`, '#3498db');
      } else {
        this.showHudToast('📥 Kassetter redan laddade (2/2)', '#2ecc71');
        this.log('Kassetter är redan fulladdade (2/2).');
      }
      return;
    }

    // --- 2. TAKTISKA SCENARIO TRIGGERS ---
    if (cmd === 'STARTA_ANGREPP') {
      this.startScenario();
      return;
    }
    if (cmd === 'STOPPA_ANGREPP') {
      this.stopScenario();
      return;
    }

    // --- 3. VARNINGSROP FÖRE SKOTT ("El, el, el!" + elchockvapen + beredd) ---
    if (cmd === 'VARNING_EL' || cmd === 'VARNING_FULL' || cmd === 'VARNING_ELCHOCKVAPEN' || cmd === 'VARNING_BEREDD') {
      const wasWarned = this.warningGiven;
      this.warningGiven = true;
      this.updateWarningUI();

      if (cmd === 'VARNING_EL') {
        this.showHudToast('📢 VARNING DELGIVEN: "El, el, el!"', '#f1c40f');
        this.log("<span style='color:#f1c40f; font-weight:bold;'>📢 TAKTISK VARNING DELGIVEN:</span> <i>\"El, el, el!\"</i>");
      } else if (cmd === 'VARNING_FULL') {
        this.showHudToast('📢 VARNING DELGIVEN (Elchockvapen)', '#f1c40f');
        this.log("<span style='color:#f1c40f; font-weight:bold;'>📢 TAKTISK VARNING DELGIVEN:</span> <i>\"Jag har ett elchockvapen, jag är beredd att använda det!\"</i>");
      } else if (cmd === 'VARNING_ELCHOCKVAPEN') {
        this.showHudToast('📢 VARNING DELGIVEN (Elchockvapen)', '#f1c40f');
        this.log("<span style='color:#f1c40f; font-weight:bold;'>📢 TAKTISK VARNING DELGIVEN:</span> <i>\"Jag har ett elchockvapen!\"</i>");
      } else {
        this.showHudToast('📢 VARNING DELGIVEN (Beredd)', '#f1c40f');
        this.log("<span style='color:#f1c40f; font-weight:bold;'>📢 TAKTISK VARNING DELGIVEN:</span> <i>\"Jag är beredd att använda det!\"</i>");
      }

      if (!this.scene.figureFallen) {
        if (this.threatLevel >= 3 || (this.xr && this.xr.xrSession && (this.xr.scenario === 'moving' || this.xr.scenario === 'charging'))) {
          if (!wasWarned) {
            this.suspectSpeak(Math.random() < 0.5 ? 'Tror du jag bryr mig om ditt elvapen?!' : 'Kom inte närmare, jag menar allvar!');
          } else {
            this.suspectSpeak('Jag hörde dig! Stick sa jag!');
          }
        } else {
          this.suspectSpeak('Vadå elchockvapen?! Ta det lugnt!');
        }
      }
      return;
    }

    if (this.scene.figureFallen) {
      this.log("<span style='color:#bdc3c7'>Målet är redan neutraliserat / på marken.</span>");
      return;
    }

    const isXRActiveScenario = !!(this.xr && this.xr.xrSession && (this.xr.scenario === 'moving' || this.xr.scenario === 'charging') && !this.xr.targetSurrendered);
    const isThreatActive = this.threatLevel >= 3 || isXRActiveScenario;
    const isArmed = isThreatActive || (this.scene.knifeMesh && this.scene.knifeMesh.visible) || (this.scene.batonMesh && this.scene.batonMesh.visible) || (this.threatWeapon === 'FISTS');

    const applySurrenderStop = (labelText) => {
      if (this.threatInterval) {
        clearInterval(this.threatInterval);
        this.threatInterval = null;
      }
      this.threatLevel = 0;
      if (typeof window !== 'undefined') window.threatLevel = 0;
      this.isScenarioActive = false;
      this.fsm.isScenarioActive = false;
      if (this.xr && typeof this.xr.surrenderScenario === 'function') {
        this.xr.surrenderScenario();
      }
      if (this.scene) {
        this.scene.armOverrideWeight = 0;
        if (typeof this.scene.updateWeaponVisibility === 'function') {
          this.scene.updateWeaponVisibility();
        }
        this.scene.setAnimation('Idle', 0.4);
      }
      const tLabel = document.getElementById('target-label');
      if (tLabel) {
        tLabel.textContent = labelText || 'PERSON: GAV UPP';
        tLabel.classList.remove('armed');
      }
    };

    // --- 4. BEFALLNINGAR SOM PÅVERKAR / STOPPAR SCENARIOT ---
    if (cmd === 'SLAPP_KNIVEN' || cmd === 'SLAPP_VAPNET') {
      const cmdDesc = cmd === 'SLAPP_VAPNET' ? 'Släpp vapnet!' : 'Släpp kniven!';
      if (isArmed) {
        const obeyChance = this.warningGiven ? 0.50 : 0.35;
        const obeys = Math.random() < obeyChance;
        if (obeys) {
          applySurrenderStop('PERSON: GAV UPP');
          const weaponName = this.threatWeapon === 'BATON' ? 'batongen' : (this.threatWeapon === 'KNIFE' ? 'kniven' : 'vapnet');
          this.showHudToast(`✅ Målet lyder: "${cmdDesc}"`, '#2ecc71');
          this.log(`<span style='color:#2ecc71; font-weight:bold;'>✅ KOMMANDO LYCKADES:</span> Målet släpper ${weaponName} och kapitulerar!`);
          this.suspectSpeak(this.threatWeapon === 'FISTS' ? 'Okej! Skjut inte, jag ger upp!' : `Okej! Skjut inte, jag släpper ${weaponName}!`);
        } else {
          const weaponName = this.threatWeapon === 'BATON' ? 'batongen' : (this.threatWeapon === 'KNIFE' ? 'kniven' : 'angreppet');
          this.showHudToast('⚠️ Målet vägrar släppa!', '#e74c3c');
          this.log(`<span style='color:#e74c3c; font-weight:bold;'>⚠️ KOMMANDO IGNORERADES:</span> Målet vägrar avbryta ${weaponName}! Fortsätter anfallet!`);
          this.suspectSpeak('Aldrig i livet! Kom hit då!');
          this.scene.setAnimation('Walk', 0.3);
        }
      } else {
        this.suspectSpeak('Jag har inget vapen! Vad glor du på?!');
        this.log("<span style='color:#f39c12'>Målet har ännu inte dragit något vapen.</span>");
      }
    } else if (cmd === 'HANDERNA_UPP') {
      if (isThreatActive) {
        const obeyChance = this.warningGiven ? 0.45 : 0.25;
        if (Math.random() < obeyChance) {
          applySurrenderStop('PERSON: HÄNDERNA UPPE');
          this.showHudToast('✅ Målet stannar & ger upp!', '#2ecc71');
          this.log("<span style='color:#2ecc71; font-weight:bold;'>✅ KOMMANDO LYCKADES (\"Händerna upp!\"):</span> Målet avbryter och visar händerna!");
          this.suspectSpeak('Okej, mina händer är uppe! Skjut inte!');
        } else {
          if (this.xr && typeof this.xr.pauseScenario === 'function') this.xr.pauseScenario(1600);
          this.showHudToast('⚠️ Målet tvekar!', '#f1c40f');
          this.suspectSpeak('Gå bort från mig!');
          this.log("<span style='color:#e74c3c'>Målet tvekar kort men lyder inte ordern fullt ut.</span>");
        }
      } else {
        this.showHudToast('✅ Målet visar händerna', '#2ecc71');
        this.suspectSpeak('Okej, jag har händerna uppe!');
        this.log("<span style='color:#2ecc71'>Målet står stilla och håller upp händerna.</span>");
      }
    } else if (cmd === 'BACKA') {
      if (this.xr && typeof this.xr.retreatTarget === 'function') {
        this.xr.retreatTarget(0.8);
      } else if (this.scene && this.scene.taserGroup) {
        this.scene.taserGroup.position.z -= 0.7;
        this.currentDistance = Math.min(7.5, (this.currentDistance || 3.0) + 0.7);
        this.updateAimVisuals();
      }
      if (isThreatActive) {
        this.scene.setAnimation('Idle', 0.35);
        this.showHudToast('⏸️ Målet backar & tvekar!', '#f1c40f');
        this.suspectSpeak('Okej, jag tar det lugnt! Skjut inte!');
        this.log("<span style='color:#f1c40f; font-weight:bold;'>⏸️ KOMMANDO (\"Backa!\"):</span> Målet backar undan och tvekar tillfälligt.");
        setTimeout(() => {
          if (!this.scene.figureFallen && this.threatLevel >= 3 && !(this.xr && this.xr.targetSurrendered)) {
            this.scene.setAnimation('Walk', 0.4);
          }
        }, 3200);
      } else {
        this.showHudToast('↩️ Målet backar', '#2ecc71');
        this.suspectSpeak('Okej, jag backar!');
      }
    } else if (cmd === 'POLIS_STANNA' || cmd === 'STANNA') {
      const isPoliceCmd = cmd === 'POLIS_STANNA';
      if (isThreatActive) {
        const fullStopChance = isPoliceCmd ? (this.warningGiven ? 0.55 : 0.35) : 0.20;
        const roll = Math.random();
        if (roll < fullStopChance) {
          applySurrenderStop('PERSON: STANNADE');
          this.showHudToast(`✅ Målet stannar (${isPoliceCmd ? 'Polis, stanna!' : 'Stanna!'})`, '#2ecc71');
          this.suspectSpeak('Okej polis, jag stannar! Skjut inte!');
          this.log(`<span style='color:#2ecc71; font-weight:bold;'>✅ KOMMANDO LYCKADES:</span> Målet lyder "${isPoliceCmd ? 'Polis, stanna!' : 'Stanna!'}" och avbryter framryckningen!`);
        } else if (roll < fullStopChance + 0.45) {
          if (this.xr && typeof this.xr.pauseScenario === 'function') this.xr.pauseScenario(3000);
          this.suspectSpeak('Vad vill du mig?!');
          this.scene.setAnimation('Idle', 0.3);
          setTimeout(() => {
            if (!this.scene.figureFallen && this.threatLevel >= 3 && !(this.xr && this.xr.targetSurrendered)) {
              this.scene.setAnimation('Walk', 0.4);
            }
          }, 3000);
          this.showHudToast('⏸️ Målet tvekar och stannar kort!', '#f1c40f');
          this.log("<span style='color:#f1c40f; font-weight:bold;'>Målet tvekar och stannar tillfälligt!</span>");
        } else {
          this.showHudToast('⚠️ Målet ignorerar stanna-order!', '#e74c3c');
          this.suspectSpeak('Stoppa mig om du kan!');
          this.log("<span style='color:#e74c3c'>Målet ignorerar stanna-ordern.</span>");
        }
      } else {
        this.showHudToast('Målet står stilla', '#2ecc71');
        this.suspectSpeak('Jag står ju still!');
      }
    } else if (cmd === 'LAGG_DIG_NER') {
      if (isArmed) {
        const surrenderChance = this.warningGiven ? 0.45 : 0.15;
        const obeys = Math.random() < surrenderChance;

        if (obeys) {
          applySurrenderStop('PERSON: GAV UPP');
          if (this.scene) {
            this.scene.collapseTarget();
          }

          const chanceInfo = this.warningGiven ? 'efter formell varning' : 'utan varning';
          const weaponDesc = this.threatWeapon === 'BATON' ? 'batongen' : (this.threatWeapon === 'KNIFE' ? 'kniven' : 'garden');
          this.showHudToast('✅ Målet lägger sig ner!', '#2ecc71');
          this.log(`<span style='color:#2ecc71; font-weight:bold;'>✅ MÅLET GER UPP (${chanceInfo})!</span> Målet släpper ${weaponDesc} och lägger sig platt på marken.`);
          this.suspectSpeak('Okej! Jag lägger mig ner, skjut inte!');
        } else {
          const failInfo = this.warningGiven ? 'trots delgiven varning' : 'utan varning';
          this.showHudToast('⚠️ Målet vägrar lägga sig!', '#e74c3c');
          this.log(`<span style='color:#e74c3c; font-weight:bold;'>⚠️ MÅLET VÄGRAR (${failInfo})!</span> Målet vägrar lägga sig ner och fortsätter anfallet!`);
          this.suspectSpeak(this.warningGiven ? 'Ditt elvapen skrämmer mig inte! Kom hit då!' : 'Aldrig i livet! Jag lägger mig inte!');
          this.scene.setAnimation('Walk', 0.3);
        }
      } else {
        applySurrenderStop('PERSON: PÅ MARKEN');
        this.suspectSpeak('Okej, jag lägger mig ner!');
        this.scene.collapseTarget();
        this.showHudToast('✅ Målet på marken', '#2ecc71');
        this.log("<span style='color:#2ecc71; font-weight:bold;'>Målet lyder och lägger sig ner på marken.</span>");
      }
    }
  }

  showTacticalError(title, detail, type = 'SYSTEM') {
    console.error(`[TACTICAL ERROR: ${type}] ${title} - ${detail}`);
    const banner = document.getElementById('tactical-error-banner');
    const titleEl = document.getElementById('banner-title-text');
    const bodyEl = document.getElementById('banner-body-text');

    if (banner && titleEl && bodyEl) {
      titleEl.textContent = `${title} (${type})`;
      bodyEl.textContent = detail;
      banner.style.display = 'block';

      if (this._errorBannerTimer) clearTimeout(this._errorBannerTimer);
      this._errorBannerTimer = setTimeout(() => {
        banner.style.display = 'none';
      }, 8000);
    }
  }

  stopRealPersonAI(silent = false) {
    const cameraFeed = document.getElementById('camera-feed-left') || document.getElementById('camera-feed');
    const cameraFeedRight = document.getElementById('camera-feed-right');
    const btnCamera = document.getElementById('btn-camera');
    const tLabel = document.getElementById('target-label');

    const stopVideoTracks = (el) => {
      if (!el) return;
      const stream = el.srcObject;
      if (stream && typeof stream.getTracks === 'function') {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
      if (stream && typeof stream._cleanup === 'function') {
        try { stream._cleanup(); } catch (_) {}
      }
      try { el.pause(); } catch (_) {}
      el.srcObject = null;
    };
    stopVideoTracks(cameraFeed);
    stopVideoTracks(cameraFeedRight);

    if (this.xr) {
      if (this.xr.videoStream && typeof this.xr.videoStream.getTracks === 'function') {
        this.xr.videoStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
      if (this.xr.videoStream && typeof this.xr.videoStream._cleanup === 'function') {
        try { this.xr.videoStream._cleanup(); } catch (_) {}
      }
      this.xr.videoStream = null;
      this.xr.useCamera = false;
      this.xr.isSimulatedCamera = false;
    }

    const camContainer = document.getElementById('camera-container');
    if (camContainer) camContainer.style.display = 'none';

    document.body.classList.remove('ar-active', 'live-ai-active', 'live-ar-active', 'camera-active');
    document.documentElement.classList.remove('ar-active', 'live-ai-active', 'live-ar-active', 'camera-active');
    const mainContainer = document.getElementById('main-container');
    if (mainContainer) mainContainer.classList.remove('live-ar-active');
    const simControls = document.querySelector('.sim-controls');
    if (simControls) simControls.classList.remove('live-ar-active');

    this.liveWires = [];
    this.liveARRoomCode = null;
    const roomBadgeStop = document.getElementById('live-ar-room-badge');
    if (roomBadgeStop) {
      roomBadgeStop.style.display = 'none';
      roomBadgeStop.classList.remove('hit-sent');
    }
    if (this.aiPose) this.aiPose.stop();
    if (this.scene) {
      this.scene.disableARMode();
      this.scene.clearWiresAndDarts();
      this.scene.resetTarget();
      this.scene.set3DVisibility(true);
    }

    if (btnCamera) {
      btnCamera.innerHTML = '🤖 Live AI (Kamera)';
      btnCamera.classList.remove('active-cam');
    }
    if (tLabel) {
      tLabel.textContent = 'PERSON (3D)';
      tLabel.classList.remove('armed');
    }

    this.currentDistance = 3.0;
    this.aimX = 50;
    this.aimY = 50;
    this.stopScenario();
    this.updateAimVisuals();
    this.updateDisplay();
    this.updateProjectors();
    window.dispatchEvent(new Event('resize'));
    if (!silent) {
      this.log('Live AR avslutad. Återgått till 3D-mål.');
    }
  }

  async startRealPersonAI() {
    this.closeModal('scenario-modal');
    const cameraFeed = document.getElementById('camera-feed-left') || document.getElementById('camera-feed');
    const cameraFeedRight = document.getElementById('camera-feed-right');
    const btnCamera = document.getElementById('btn-camera');
    const viewport = document.getElementById('viewport');
    const tLabel = document.getElementById('target-label');

    const activateLiveARClasses = () => {
      document.body.classList.add('ar-active', 'live-ai-active', 'live-ar-active');
      document.documentElement.classList.add('ar-active', 'live-ai-active', 'live-ar-active');
      const mainContainer = document.getElementById('main-container');
      if (mainContainer) mainContainer.classList.add('live-ar-active');
      const simControls = document.querySelector('.sim-controls');
      if (simControls) simControls.classList.add('live-ar-active');
      this.aimX = 50;
      this.aimY = 50;
    };

    // Aktivera kompakt Live-AR gränssnitt direkt för omedelbar visuell feedback
    this.liveWires = [];
    activateLiveARClasses();
    this.updateDisplay();
    if (this.xr && !this.xr.gyroEnabled && (typeof DeviceMotionEvent === 'undefined' || typeof DeviceMotionEvent.requestPermission !== 'function')) {
      this.initGyro(true);
    }

    // Generera 4-siffrig rumskod för Markör-koppling och skapa session i Firestore
    const roomCode = String(Math.floor(1000 + Math.random() * 9000));
    this.liveARRoomCode = roomCode;
    const roomBadge = document.getElementById('live-ar-room-badge');
    if (roomBadge) {
      roomBadge.textContent = `🔗 KOD: ${roomCode}`;
      roomBadge.classList.remove('hit-sent');
      roomBadge.style.display = 'inline-flex';
    }
    if (typeof window !== 'undefined' && window.taserFirebase && typeof window.taserFirebase.createSession === 'function') {
      window.taserFirebase.createSession(roomCode).then((ok) => {
        if (ok) {
          this.log(`<span style='color:#2ecc71; font-weight:bold;'>🔗 Markör-rum skapat: ${roomCode}</span>`);
        }
      });
    }

    // Immediate user feedback
    if (tLabel) tLabel.textContent = 'INITIERAR AI & KAMERA...';
    if (btnCamera) btnCamera.innerHTML = '⏳ Startar AI...';
    this.log("<span style='color:#f1c40f'>⏳ Initierar Mixed Reality (Kamera + BlazePose AI)...</span>");

    try {
      // STEG 1: Kamerabehörighet (MÅSTE anropas direkt vid användarklick för att behålla aktiv User Gesture)
      const isActive = await this.xr.toggleCameraAR(cameraFeed, viewport);
      if (isActive && cameraFeedRight && cameraFeed && cameraFeed.srcObject) {
        cameraFeedRight.srcObject = cameraFeed.srcObject;
        cameraFeedRight.play().catch(() => {});
      }

      if (!isActive) {
        // Om användaren klickade för att stänga av kameran
        this.stopRealPersonAI();
        return;
      }

      // Aktivera helskärms-AR, Live-AI och kompakt .live-ar-active grepp-UI samt Three.js transparent bakgrund
      activateLiveARClasses();
      this.scene.enableARMode();

      const isSimulated = !!this.xr.isSimulatedCamera;
      this.aiPose.isSimulated = isSimulated;

      // STEG 2: Ladda och förbered ML-modellen i minnet (MediaPipe Pose WASM)
      if (!isSimulated) {
        if (tLabel) tLabel.textContent = 'LADDAR AI-MODELL...';
        await this.aiPose.ensureReady().catch((e) => {
          console.warn('[AI MODEL NOTICE] Förbereder fallback till simulerad person:', e.message);
          this.aiPose.isSimulated = true;
        });
      }

      // STEG 3: Koppla videoströmmen till AI-detektorn
      this.aiPose.start(cameraFeed);

      if (btnCamera) {
        btnCamera.innerHTML = isSimulated ? '🤖 Avbryt AI (Demo)' : '🤖 Avbryt Live AI';
        btnCamera.classList.add('active-cam');
      }
      if (tLabel) {
        tLabel.textContent = isSimulated ? 'MÄNNISKA (AI SIMULERAD)' : 'MÄNNISKA (AI SÖKER...)';
      }

      this.updateAimVisuals();
      this.updateDisplay();
      this.updateProjectors();
      window.dispatchEvent(new Event('resize'));

      if (isSimulated) {
        this.log("<span style='color:#f1c40f; font-weight:bold;'>ℹ️ SIMULERAD AI-KAMERA:</span> Fysisk kamera är blockerad av webbläsarens iframe-säkerhet. Kör med simulerad person för full AI- och ballistikträning!");
      } else {
        this.log("<span style='color:#2ecc71; font-weight:bold;'>✅ LIVE AI AKTIV:</span> Riktar kameran mot en levande människa för dynamiska träffzoner.");
      }
    } catch (err) {
      console.warn('[STARTUP SEQUENCE NOTICE] Faller tillbaka till simulerad AI-person:', err);
      activateLiveARClasses();
      this.scene.enableARMode();
      this.aiPose.isSimulated = true;
      this.aiPose.start(cameraFeed);
      if (btnCamera) {
        btnCamera.innerHTML = '🤖 Avbryt AI (Demo)';
        btnCamera.classList.add('active-cam');
      }
      if (tLabel) {
        tLabel.textContent = 'MÄNNISKA (AI SIMULERAD)';
      }
      this.updateAimVisuals();
      this.updateDisplay();
      this.updateProjectors();
      window.dispatchEvent(new Event('resize'));
      this.log("<span style='color:#f1c40f;'>Kamera ej tillgänglig. Startat i simulerat AI-läge för test och verifiering.</span>");
    }
  }

  async toggleCameraAR() {
    return this.startRealPersonAI();
  }

  async startWebXR(type = 'static') {
    const btnWebXR = document.getElementById('btn-webxr') || document.getElementById('webxr-btn');
    if (btnWebXR) {
      btnWebXR.textContent = '⏳ Startar AR...';
    }
    try {
      const res = await this.xr.startXR(type);
      this.closeModal('scenario-modal');
      if (res && res.success === false) {
        if (btnWebXR) btnWebXR.textContent = '🌐 WebXR';
        this.startVirtualScenario(type);
      }
    } catch (err) {
      console.warn('[WEBXR NOTICE] Växlar automatiskt till simulerat AR-scenario:', err.message);
      this.closeModal('scenario-modal');
      if (btnWebXR) btnWebXR.textContent = '🌐 WebXR';
      this.startVirtualScenario(type);
    }
  }

  startVirtualScenario(type = 'static') {
    if (this.aiPose && this.aiPose.isActive) {
      this.stopRealPersonAI(true);
    }
    const liveOverlayVirt = document.getElementById('live-target-overlay');
    if (liveOverlayVirt) liveOverlayVirt.style.display = 'none';

    this.selectedScenario = type;
    const tLabel = document.getElementById('target-label');

    // Säkerställ att 3D-figuren är synlig och återställd
    this.scene.resetTarget();
    this.scene.set3DVisibility(true);

    if (type === 'charging') {
      if (tLabel) tLabel.textContent = 'MÅL: FRAMSTORMANDE';
      this.threatLevel = 4;
      if (typeof window !== 'undefined') window.threatLevel = 4;
      this.log("<span style='color:#f39c12; font-weight:bold;'>🚨 SCENARIO: FRAMSTORMANDE MÅL!</span> Målet avancerar snabbt mot dig. Fäll målet med godkänd NMI-spridning innan det når fram!");
      this.startScenario();
    } else if (type === 'moving') {
      if (tLabel) tLabel.textContent = 'MÅL: RÖRLIGT';
      this.threatLevel = 3;
      if (typeof window !== 'undefined') window.threatLevel = 3;
      this.log("<span style='color:#3498db; font-weight:bold;'>🎯 SCENARIO: RÖRLIGT MÅL!</span> Målet rör sig i vinkel. Anpassa sikte och avfyra.");
      this.startScenario();
    } else {
      // 'static'
      if (tLabel) tLabel.textContent = 'MÅL: STATISKT';
      this.threatLevel = 1;
      if (typeof window !== 'undefined') window.threatLevel = 1;
      this.isScenarioActive = false;
      this.fsm.isScenarioActive = false;
      this.log("<span style='color:#2ecc71; font-weight:bold;'>🎯 SCENARIO: STATISKT MÅL!</span> Mål redo på 3.0 meters avstånd. Kontrollera laserspridning och osäkra för skott.");
    }

    this.currentDistance = 3.0;
    this.updateAimVisuals();
    this.updateDisplay();
  }

  onXRSessionStart(session, scenario) {
    if (this.aiPose && this.aiPose.isActive) {
      this.aiPose.stop();
    }
    const liveOverlayXR = document.getElementById('live-target-overlay');
    if (liveOverlayXR) liveOverlayXR.style.display = 'none';
    this.liveARRoomCode = null;
    const roomBadgeXR = document.getElementById('live-ar-room-badge');
    if (roomBadgeXR) {
      roomBadgeXR.style.display = 'none';
      roomBadgeXR.classList.remove('hit-sent');
    }
    document.body.classList.remove('live-ai-active', 'live-ar-active', 'camera-active');
    document.documentElement.classList.remove('live-ai-active', 'live-ar-active', 'camera-active');
    document.body.classList.add('ar-active', 'webxr-mode', 'ar-combat-mode');
    document.documentElement.classList.add('ar-active', 'webxr-mode', 'ar-combat-mode');
    const mainContainer = document.getElementById('main-container');
    if (mainContainer) {
      mainContainer.classList.remove('live-ar-active');
      mainContainer.classList.add('ar-combat-mode');
    }
    const simControls = document.querySelector('.sim-controls');
    if (simControls) {
      simControls.classList.remove('live-ar-active');
      simControls.classList.add('ar-combat-mode');
    }
    this.liveWires = [];
    this.scene.clearWiresAndDarts();
    this.scene.enableARMode();

    const btnWebXR = document.getElementById('btn-webxr') || document.getElementById('webxr-btn');
    if (btnWebXR) {
      btnWebXR.textContent = '⛔ Avsluta WebXR';
      btnWebXR.style.backgroundColor = '#e74c3c';
    }

    const tLabel = document.getElementById('target-label');
    if (tLabel) tLabel.textContent = `PERSON (${scenario.toUpperCase()})`;

    this.updateProjectors();
    this.togglePlaceMode();

    // Aktivera röstigenkänning automatiskt i WebXR-läget med full svensk terminologi
    if (this.voice && this.voice.isSupported) {
      if (!this.voice.isListening) {
        this.voice.start({ autoFromXR: true });
      } else {
        this.voice.ensureActive();
      }
    }

    this.log(`WebXR startad i scenario: ${scenario}`);
  }

  onXRSessionEnd() {
    document.body.classList.remove('ar-active', 'webxr-mode', 'ar-combat-mode', 'xr-placing');
    document.documentElement.classList.remove('ar-active', 'webxr-mode', 'ar-combat-mode', 'xr-placing');
    const mainContainer = document.getElementById('main-container');
    if (mainContainer) mainContainer.classList.remove('ar-combat-mode');
    const simControls = document.querySelector('.sim-controls');
    if (simControls) simControls.classList.remove('ar-combat-mode');
    this.scene.disableARMode();

    this.xr.isPlacing = false;
    this.xr.placeMode = false;
    if (typeof window !== 'undefined') window.isPlacing = false;
    if (this.scene && this.scene.placementMarker) {
      this.scene.placementMarker.visible = false;
    }

    const btnPlaceXr = document.getElementById('btn-place-xr');
    if (btnPlaceXr) btnPlaceXr.style.display = 'none';

    const btnWebXR = document.getElementById('btn-webxr') || document.getElementById('webxr-btn');
    if (btnWebXR) {
      btnWebXR.textContent = '🌐 WebXR';
      btnWebXR.style.backgroundColor = '';
    }

    this.scene.clearWiresAndDarts();
    this.scene.resetTarget();
    this.stopScenario();
    this.updateDisplay();
    this.log('WebXR-session avslutad.');
  }

  togglePlaceMode() {
    this.xr.isPlacing = true;
    this.xr.placeMode = true;
    this.xr.figureLocked = false;
    this.xr.hasHitTestPose = false;
    if (typeof window !== 'undefined') window.isPlacing = true;

    // Dölj hela kontrollpanelen under placering och visa endast placeringsknappen längst ner
    document.body.classList.add('xr-placing');
    document.documentElement.classList.add('xr-placing');

    const plcEl = document.getElementById('placement-controls');
    if (plcEl) plcEl.style.display = 'none';
    const btnPlaceXr = document.getElementById('btn-place-xr');
    if (btnPlaceXr) btnPlaceXr.style.display = 'inline-flex';

    this.scene.set3DVisibility(false);
    if (this.scene.placementMarker) {
      this.scene.placementMarker.rotation.set(0, 0, 0);
      this.scene.placementMarker.quaternion.identity();
      this.scene.placementMarker.visible = true;
    }

    const hint = document.getElementById('place-hint');
    if (hint) hint.classList.remove('visible');
    this.log('Sök efter golvet och fastställ position...');
  }

  confirmPlacement() {
    const marker = this.scene.placementMarker;
    if (this.xr.xrSession) {
      const xrCam = this.scene.renderer.xr.getCamera(this.scene.camera);
      if (marker && marker.visible && (this.xr.hasHitTestPose || marker.position.lengthSq() > 0.001)) {
        if (this.scene.taserGroup) {
          marker.updateMatrix();
          marker.updateMatrixWorld(true);
          this.scene.taserGroup.position.setFromMatrixPosition(marker.matrix);
          this.scene.taserGroup.position.y = Math.max(0, this.scene.taserGroup.position.y - 0.01);
          this.scene.taserGroup.rotation.set(0, 0, 0);
          this.scene.taserGroup.quaternion.identity();
          if (this.scene.glbDummy) {
            this.scene.glbDummy.rotation.set(0, 0, 0);
            this.scene.glbDummy.quaternion.identity();
          }
          this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
          this.scene.taserGroup.visible = true;
        }
      } else {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
        forward.y = 0;
        if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
        forward.normalize().multiplyScalar(3.0);
        if (this.scene.taserGroup) {
          this.scene.taserGroup.position.set(
            xrCam.position.x + forward.x,
            0,
            xrCam.position.z + forward.z
          );
          this.scene.taserGroup.rotation.set(0, 0, 0);
          this.scene.taserGroup.quaternion.identity();
          if (this.scene.glbDummy) {
            this.scene.glbDummy.rotation.set(0, 0, 0);
            this.scene.glbDummy.quaternion.identity();
          }
          this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
          this.scene.taserGroup.visible = true;
        }
        this.log("<span style='color:#f39c12'>Standardposition vald (3m rakt framför dig).</span>");
      }
    } else if (this.scene.taserGroup && marker && marker.visible) {
      marker.updateMatrix();
      marker.updateMatrixWorld(true);
      this.scene.taserGroup.position.setFromMatrixPosition(marker.matrix);
      this.scene.taserGroup.position.y = Math.max(0, this.scene.taserGroup.position.y - 0.01);
      this.scene.taserGroup.rotation.set(0, 0, 0);
      this.scene.taserGroup.quaternion.identity();
      if (this.scene.glbDummy) {
        this.scene.glbDummy.rotation.set(0, 0, 0);
        this.scene.glbDummy.quaternion.identity();
      }
      this.scene.taserGroup.visible = true;
      this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
    }

    this.xr.isPlacing = false;
    this.xr.placeMode = false;
    this.xr.figureLocked = true;
    if (typeof window !== 'undefined') window.isPlacing = false;

    document.body.classList.remove('xr-placing');
    document.documentElement.classList.remove('xr-placing');

    this.scene.set3DVisibility(true);
    if (marker) marker.visible = false;
    if (this.scene.reticle) this.scene.reticle.visible = false;

    const hint = document.getElementById('place-hint');
    if (hint) hint.classList.remove('visible');

    const btnPlaceXr = document.getElementById('btn-place-xr');
    if (btnPlaceXr) btnPlaceXr.style.display = 'none';

    const stdEl = document.getElementById('standard-controls');
    if (stdEl) stdEl.style.display = 'block';
    const plcEl = document.getElementById('placement-controls');
    if (plcEl) plcEl.style.display = 'none';

    this.log("<span style='color:#2ecc71'><b>🔒 Figuren är fastlåst!</b> Redo för insats.</span>");
    if (this.xr.xrSession && (this.xr.scenario === 'moving' || this.xr.scenario === 'charging')) {
      this.startScenario();
    } else {
      this.stopScenario();
    }
    this.updateAimVisuals();
    this.updateDisplay();
    if (this.voice && this.voice.isListening) {
      this.voice.ensureActive();
    }
  }

  handlePhysicalTilt(direction, gamma) {
    if (this.isFiring || (this.fsm && this.fsm.isFiring)) return;

    if (!this.fsm.hasBattery) {
      this.log("<span style='color:#f1c40f'>📱 Tilt/Snärt registrerad! Sätter i batteri och osäkrar vapnet...</span>");
      this.fsm.hasBattery = true;
      this.fsm.isSafe = false;
      this.fsm.chamber1 = ChamberState.LOADED;
      this.fsm.chamber2 = ChamberState.LOADED;
      this.fsm.displayState = 'ACTIVE';
      this.updateDisplay();
    } else if (this.fsm.isSafe) {
      this.log("<span style='color:#f1c40f'>📱 Tilt/Snärt registrerad! Osäkrar vapnet för aktiv insats...</span>");
      this.fsm.isSafe = false;
      this.fsm.displayState = 'ACTIVE';
      this.updateDisplay();
    } else if (this.fsm.chamber1 === ChamberState.EMPTY) {
      this.fsm.chamber1 = ChamberState.LOADED;
      this.fsm.chamber2 = ChamberState.LOADED;
      this.updateDisplay();
    }

    const switched = this.fsm.tiltWeapon();
    if (switched) {
      if (navigator.vibrate) {
        try { navigator.vibrate([40, 30, 40]); } catch (e) {}
      }
      this.updateDisplay();
      this.log(`📱 <span style='color:#3498db; font-weight:bold;'>GYRO-SNÄRT (${String(direction || '').toUpperCase()} ${Math.round(gamma || 0)}°):</span> Växlar till kammare ${this.fsm.activeChamber} (${this.fsm.activeChamber === 1 ? '12°' : '3.5°'})!`);
    }
  }

  initGyro(silent = false) {
    this.audio.init();
    this.xr.initGyro(
      (aimX, aimY) => {
        if (document.body.classList.contains('live-ar-active') || document.body.classList.contains('live-ai-active')) {
          this.aimX = 50;
          this.aimY = 50;
        } else {
          this.aimX = aimX;
          this.aimY = aimY;
        }
        this.updateAimVisuals();
      },
      (direction, gamma) => this.handlePhysicalTilt(direction, gamma),
      (continuousRollDeg) => {
        if (typeof continuousRollDeg !== 'number' || isNaN(continuousRollDeg)) return;
        this._hasGyroRoll = true;
        // Lågpassfilter som tar bort handdarrning men behåller mjuk 60 FPS-rotation
        const target = Math.max(-135, Math.min(135, continuousRollDeg));
        this._gyroContinuousRoll += (target - this._gyroContinuousRoll) * 0.28;
        this.updateAimVisuals();
      }
    ).then((res) => {
      const btn = document.getElementById('btn-gyro');
      if (res && res.success) {
        if (btn) {
          btn.innerHTML = '📱 Gyro: PÅ';
          btn.classList.add('active-gyro');
        }
        if (res.alreadyEnabled) {
          this.log("📱 <span style='color:#2ecc71'>Gyrosikte omkalibrerat till neutralt läge.</span>");
        } else if (!silent) {
          this.log("📱 <span style='color:#2ecc71; font-weight:bold;'>Rörelsesensor (Gyro) aktiverad!</span> Vrid handleden åt sidan för att byta kammare.");
        }
      } else if (res && res.permission === 'denied') {
        if (btn) btn.innerHTML = '📱 Gyro: NEKAD';
        this.log("<span style='color:#e74c3c; font-weight:bold;'>Rörelsesensor nekades.</span> Tillåt rörelse och riktning i Safari/webbläsarinställningar.");
      } else if (res && res.permission === 'unsupported' && !silent) {
        if (btn) btn.innerHTML = '📱 Gyro: EJ STÖD';
        this.log("<span style='color:#bdc3c7'>Enheten saknar hårdvarugyroskop. Använd '⏏️ Kassett' för att växla kammare.</span>");
      }
    });
  }

  resetSimulator() {
    this.audio.init();
    const dEl = document.getElementById('taser-display');
    if (dEl) {
      dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
    }
    if (typeof document !== 'undefined') {
      document.body.classList.remove('function-check-active');
      document.documentElement.classList.remove('function-check-active');
    }
    this.hideFailOverlay();
    this.isTased = false;
    this.isGameOver = false;
    this.isFiring = false;
    if (typeof window !== 'undefined') window.isFiring = false;
    if (this.threatInterval) {
      clearInterval(this.threatInterval);
      this.threatInterval = null;
    }
    this.threatLevel = 0;
    if (typeof window !== 'undefined') window.threatLevel = 0;

    if (this.scene && this.scene.mixer) {
      this.scene.mixer.timeScale = 1.0;
    }
    this.liveWires = [];
    this.scene.clearWiresAndDarts();
    this.fsm.reset();
    if (this.xr && typeof this.xr.resetScenarioState === 'function') {
      this.xr.resetScenarioState();
    }

    if (this.scene && this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting && this.scene.taserGroup) {
      const xrCam = this.scene.renderer.xr.getCamera(this.scene.camera);
      const distSq = xrCam.position.distanceToSquared(this.scene.taserGroup.position);
      if (distSq < 1.44) {
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
        forward.y = 0;
        if (forward.lengthSq() < 0.001) forward.set(0, 0, -1);
        forward.normalize().multiplyScalar(3.0);
        this.scene.taserGroup.userData.startPos = new THREE.Vector3(
          xrCam.position.x + forward.x,
          0,
          xrCam.position.z + forward.z
        );
      }
    } else if (this.scene && this.scene.taserGroup) {
      this.scene.taserGroup.userData.startPos = new THREE.Vector3(0, 0, 0);
    }

    this.scene.resetTarget();
    if (this.aiPose && this.aiPose.isActive) {
      this.scene.set3DVisibility(false);
    } else if (this.xr && this.xr.xrSession) {
      if (!this.fsm.hasBattery) this.fsm.hasBattery = true;
      this.scene.set3DVisibility(true);
    }
    this.currentDistance = 3.0;
    this.aimX = 50;
    this.aimY = 50;
    this.tilt = 0;
    if (typeof window !== 'undefined' && window.state) window.state.tilt = 0;

    if (typeof window !== 'undefined') {
      window.state = window.state || { tilt: 0, isSafe: !!this.fsm.isSafe, functionCheckMode: false };
      window.state.functionCheckMode = false;
      window.activeCartridge = 1;
      if (typeof window.resetWeaponPhase4 === 'function') {
        window.resetWeaponPhase4(this.fsm);
      }
    }
    const warnBtn = document.getElementById('btn-warn');
    if (warnBtn) {
      warnBtn.classList.remove('active-funk');
      warnBtn.style.borderColor = '';
      warnBtn.style.boxShadow = '';
    }
    if (this.xr && this.xr.xrSession && (this.xr.scenario === 'moving' || this.xr.scenario === 'charging')) {
      this.startScenario();
    } else {
      this.stopScenario();
    }
    this.updateAimVisuals();
    this.updateDisplay();
    this.updateWarningUI();
    this.log("♻️ <span style='color:#2ecc71; font-weight:bold;'>Simulator återställd: Nya kassetter laddade (2/2 skarpa), mål och kablar rensade.</span>");
  }

  openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    this._lastModalOpenAt = performance.now();
    // Återställ eventuell laddningstext på scenarieknappar när modalen öppnas
    modal.querySelectorAll('.scenario-btn').forEach((b) => {
      b.classList.remove('active-press', 'is-loading');
      if (b.dataset.origHtml) {
        b.innerHTML = b.dataset.origHtml;
      }
    });
    modal.style.display = 'flex';
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = 'none';
    modal.querySelectorAll('.scenario-btn').forEach((b) => {
      b.classList.remove('active-press', 'is-loading');
      if (b.dataset.origHtml) {
        b.innerHTML = b.dataset.origHtml;
      }
    });
  }

  startRenderLoop() {
    const renderer = this.scene.renderer;
    const camera = this.scene.camera;

    renderer.setAnimationLoop((timestamp, frame) => {
      if (typeof window !== 'undefined' && typeof window.pollGamepad === 'function') {
        window.pollGamepad();
      }
      const activeCamera = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : camera;

      // Skeletal Animation update & Threat Escalation movement
      const delta = Math.min(this.scene.clock.getDelta(), 0.1);

      const isScenarioActive = this.fsm.isScenarioActive || this.isScenarioActive;
      const currentThreat = (typeof window !== 'undefined' && typeof window.threatLevel === 'number')
        ? window.threatLevel
        : this.threatLevel;

      // Update base skeletal animation and apply Procedural Bone Manipulation (Late Update)
      this.scene.update(delta, {
        isScenarioActive,
        threatLevel: currentThreat,
        threatWeapon: this.threatWeapon
      });

      if (isScenarioActive && currentThreat >= 3 && !this.scene.figureFallen && !this.scene.isTased && !this.isTased && !this.isGameOver && this.scene.taserGroup && this.scene.taserGroup.visible) {
        if (this.scene.activeAction !== this.scene.actions['Walk']) {
          this.scene.setAnimation('Walk', 0.8);
        }

        // Advance target slowly towards camera along Z-axis only in active scenario
        if (!renderer.xr.isPresenting) {
          const minDistance = 0.4; // allow advancing down past 0.8m fail threshold
          const currentDist = (this.scene.taserGroup.userData.startPos ? this.scene.taserGroup.userData.startPos.z : 0) + 3.0 - this.scene.taserGroup.position.z;
          if (currentDist > minDistance && !this.isGameOver) {
            // Modulate forward displacement by walk action weight to eliminate foot skating during crossfade inertia
            const walkWeight = (this.scene.actions && this.scene.actions['Walk'])
              ? this.scene.actions['Walk'].getEffectiveWeight()
              : 0;
            this.scene.taserGroup.position.z += this.scene.walkSpeed * walkWeight * delta;
            this.currentDistance = Math.max(minDistance, 3.0 - this.scene.taserGroup.position.z);
            this.updateAimVisuals();
          }
        }
      } else if ((!isScenarioActive || currentThreat < 3) && !this.scene.figureFallen && !this.isGameOver) {
        if (this.scene.activeAction === this.scene.actions['Walk']) {
          this.scene.setAnimation('Idle', 0.8);
        }
      }

      // Fail state check: Attacker reaches closer than 0.8 meters and user has not completed NMI
      if (!this.scene.figureFallen && !this.scene.isTased && !this.isTased && !this.isGameOver) {
        if (!renderer.xr.isPresenting) {
          // Standard viewport: O(1) distance check
          if (this.currentDistance <= 0.8) {
            this.triggerFailState();
          }
        } else if (this.xr.figureLocked && this.scene.taserGroup && this.scene.taserGroup.visible) {
          // WebXR: zero-allocation distanceToSquared check (0.8^2 = 0.64)
          const chestPos = this.scene._v1.set(
            this.scene.taserGroup.position.x,
            this.scene.taserGroup.position.y + 1.35,
            this.scene.taserGroup.position.z
          );
          if (activeCamera.position.distanceToSquared(chestPos) <= 0.64) {
            this.triggerFailState();
          }
        }
      }

      // WebXR Frame logic & dynamic scenario updates
      if (renderer.xr.isPresenting) {
        this.xr.handleXRFrame(timestamp, frame, activeCamera);

        if (this.xr.figureLocked && this.scene.taserGroup && this.scene.taserGroup.visible) {
          const chestPos = this.scene._v1.set(
            this.scene.taserGroup.position.x,
            this.scene.taserGroup.position.y + 1.35,
            this.scene.taserGroup.position.z
          );
          const rawDist = activeCamera.position.distanceTo(chestPos);
          if (!isNaN(rawDist) && rawDist > 0.1) {
            this.currentDistance = Math.max(0.4, rawDist);
            this.updateAimVisuals();
          }
        }
      }

      const isVRMode = (typeof window !== 'undefined') && (
        window.appMode === 'vr' ||
        document.body.classList.contains('vr-active') ||
        document.body.classList.contains('vr-headset-mode')
      );
      const isTransparentPassThrough = isVRMode ||
        renderer.xr.isPresenting ||
        this.xr.useCamera ||
        document.body.classList.contains('ar-active') ||
        document.body.classList.contains('webxr-mode') ||
        document.body.classList.contains('live-ai-active') ||
        document.body.classList.contains('live-ar-active') ||
        document.body.classList.contains('camera-active');

      if (isTransparentPassThrough) {
        if (this.scene.scene.background !== null) {
          this.scene.scene.background = null;
        }
        renderer.setClearColor(0x000000, 0);
      } else {
        if (!this.scene.defaultBackground) {
          this.scene.defaultBackground = new THREE.Color(0x050505);
        }
        if (this.scene.scene.background !== this.scene.defaultBackground) {
          this.scene.scene.background = this.scene.defaultBackground;
        }
        renderer.setClearColor(0x050505, 1);
      }

      if (!renderer.xr.isPresenting) {
        // Desktop / Mobile Non-XR Perspective Viewport Orbit
        if (isNaN(this.currentDistance) || this.currentDistance < 0.5) this.currentDistance = 3.0;
        if (isNaN(this.aimX)) this.aimX = 50;
        if (isNaN(this.aimY)) this.aimY = 50;

        const targetPos = this.scene.taserGroup
          ? this.scene._v1.copy(this.scene.taserGroup.position)
          : this.scene._v1.set(0, 0, 0);
        targetPos.y += 1.35;

        const camZ = targetPos.z + this.currentDistance;
        const camX = targetPos.x;
        camera.position.set(camX, targetPos.y, camZ);

        const lookTarget = this.scene._v2.copy(targetPos);
        const panX = (50 - this.aimX) * 0.015 * this.currentDistance;
        const activeAimY = this.aimY;
        const panY = (activeAimY - 50) * 0.015 * this.currentDistance;

        lookTarget.y += panY;
        lookTarget.x -= panX;
        camera.lookAt(lookTarget);
      }

      // Dynamic High-Voltage Warning Arc updates (syncs taserModel to activeCamera)
      this.scene.updateWarningArc(activeCamera);

      // Dynamic First-Person TASER 7 3D Weapon Pose, Convergence & Tilt update (endast aktiv i VR-läget)
      if (typeof window !== 'undefined' && typeof window.updateWeaponPose === 'function') {
        window.updateWeaponPose(this);
      }

      // Dynamic Copper Wire updates anchored to muzzlePoint & probe world positions with gravity/sway physics
      this.scene.updateWireDynamics(activeCamera, delta);

      // 4. Dynamisk Raycasting för två laserpunkter (grön + röd) utan strålar genom luften
      const isHandDetected = (typeof window !== 'undefined') ? !!window.handDetected : false;
      const currentCartridge = (typeof window !== 'undefined' && typeof window.activeCartridge === 'number')
        ? window.activeCartridge
        : ((this.fsm.chamber1 === 'loaded' || this.fsm.chamber2 === 'loaded') ? (this.fsm.activeChamber === 2 ? 2 : 1) : 0);
      const weaponVisible = (typeof window !== 'undefined' && window.weaponGroup)
        ? !!window.weaponGroup.visible
        : ((typeof window !== 'undefined' && window.weaponMesh) ? !!window.weaponMesh.visible : false);
      if (typeof window !== 'undefined' && window.state) {
        window.state.isSafe = !!this.fsm.isSafe;
      }
      const isSafeState = (typeof window !== 'undefined' && window.state && typeof window.state.isSafe === 'boolean')
        ? window.state.isSafe
        : !!this.fsm.isSafe;

      const isLiveARLoop = (typeof document !== 'undefined') && (
        document.body.classList.contains('live-ar-active') ||
        document.body.classList.contains('live-ai-active') ||
        !!(this.aiPose && this.aiPose.isActive)
      );
      const currentAppMode = (typeof window !== 'undefined' && window.appMode)
        ? window.appMode
        : (isVRMode ? 'vr' : 'mobile');
      const flashlightOn = !isSafeState && this.fsm.hasBattery && !this.fsm.stealthMode;
      const lasersOn = isLiveARLoop
        ? flashlightOn
        : (flashlightOn && currentCartridge > 0 && (currentAppMode === 'mobile' || (isHandDetected && weaponVisible)));

      // Rita skarpa 2D-lasrar, ficklampa, 2D-trådar och träffblixtar på #hud-canvas (z-index: 9999) i Live-AR
      this.drawHudCanvas(flashlightOn, lasersOn);

      const aimNDC = this.scene._v3.set(0, 0, 0);
      let customNdcBottom = null;
      if (!isVRMode && !renderer.xr.isPresenting && lasersOn) {
        const vp = document.getElementById('viewport');
        const vH = vp ? vp.clientHeight : 320;
        const vW = vp ? vp.clientWidth : 320;
        const ballCoords = this.ballistics.calculateNdcCoordinates(
          this.currentDistance || 3.0,
          currentCartridge,
          vH,
          this.tilt || 0,
          vW
        );
        customNdcBottom = ballCoords.ndc2;
      }

      const isPlacingNow = !!(this.xr && (this.xr.isPlacing || this.xr.placeMode));
      const shouldShow3DLasers = lasersOn && !isLiveARLoop && !isPlacingNow;

      const laserHit = this.scene.updateDynamicLaserRaycast(
        activeCamera,
        aimNDC,
        currentCartridge,
        (d, ch) => this.ballistics.calculateSpread(d, ch),
        shouldShow3DLasers,
        this.currentDistance || 3.0,
        customNdcBottom
      );

      if (laserHit && laserHit.hit) {
        if (renderer.xr.isPresenting && !isNaN(laserHit.distance) && laserHit.distance > 0.1) {
          this.currentDistance = Math.max(0.4, laserHit.distance);
          this.updateAimVisuals();
        }
      }

      // Render the scene (Stereoscopic Side-by-Side 3D or Standard / WebXR)
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
    const prevAspect = camera.aspect;

    camera.fov = 80;
    camera.aspect = (width / 2) / height;
    camera.updateProjectionMatrix();

    this.stereoEffect.render(scene, camera);

    camera.fov = 45;
    camera.aspect = prevAspect || (width / height);
    camera.updateProjectionMatrix();
  }

  enableStereoVR() {
    if (!this.scene || !this.scene.renderer) return;
    if (!this.stereoEffect) {
      this.stereoEffect = new StereoEffect(this.scene.renderer);
      this.stereoEffect.setEyeSeparation(0.064);
    }
    this.isStereoVR = true;
    this.scene.onResize();
    const w = this.scene.container?.clientWidth || window.innerWidth;
    const h = this.scene.container?.clientHeight || window.innerHeight;
    if (w > 0 && h > 0) {
      this.stereoEffect.setSize(w, h);
    }
  }

  disableStereoVR() {
    this.isStereoVR = false;
    if (this.scene && this.scene.camera) {
      this.scene.camera.fov = 45;
      this.scene.camera.updateProjectionMatrix();
    }
    if (this.scene && this.scene.renderer) {
      this.scene.renderer.setScissorTest(false);
      this.scene.onResize();
    }
  }

  startWarningArcHaptics() {
    this.stopWarningArcHaptics();
    if (typeof navigator === 'undefined' || !navigator.vibrate) return;

    // Real TASER 7 discharges at 19-22 pulses/sec
    // Fast rhythmic pulse pattern: 20ms buzz, 30ms gap
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
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(0); } catch (_) {}
    }
  }
}

// Auto-bootstrap on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  new TaserApp();
});
