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
import { TaserFSM, ChamberState } from './fsm.js';
import { TaserAudio } from './audio.js';
import { TaserBallistics } from './ballistics.js';
import { TaserScene } from './scene.js?v=6';
import { TaserXR } from './xr.js';
import { TaserPWA } from './pwa.js';
import { TaserVoice } from './voice.js';
import { TaserAIPose } from './pose.js';

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

    this.pwa = new TaserPWA();

    // AI-Based Person Pose & Dynamic Hitbox Engine
    this.aiPose = new TaserAIPose(this.scene, this.scene.camera, {
      videoElement: document.getElementById('camera-feed'),
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
    this.tilt = 0; // degrees (-25 to +25)

    // Threat escalation & Verbal warnings
    this.threatLevel = 0;
    this.threatWeapon = 'KNIFE'; // 'KNIFE' | 'BATON' | 'FISTS'
    this.threatInterval = null;
    this.nmiTimer = null;
    this.warningGiven = false;
    this.isScenarioActive = false;
    this.isTased = false;
    this.isGameOver = false;

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
      // Smoothly request gyro permission during startup on iOS if not yet granted
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function' && !this.xr.gyroEnabled) {
        this.initGyro();
      }
      const res = this.fsm.toggleBattery();
      this.updateDisplay();
      return res;
    };
    window.toggleCassette = () => {
      const res = this.fsm.toggleCassette();
      this.updateDisplay();
      return res;
    };
    window.toggleSafety = () => {
      // Omedelbar rensning av alla inverterade varningsfärger vid säkringsinteraktion
      const dEl = document.getElementById('taser-display');
      if (dEl) {
        dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
      }
      const res = this.fsm.toggleSafety();
      this.updateDisplay();
      return res;
    };
    window.tiltWeapon = () => this.fsm.tiltWeapon();
    window.activateStealth = () => this.fsm.activateStealth();
    window.toggleClothing = () => this.fsm.toggleClothing();
    window.toggleScenario = () => this.toggleScenario();
    window.startScenario = () => this.startScenario();
    window.stopScenario = () => this.stopScenario();
    window.pressSingleWarning = () => {
      this.animateWarningButtons();
      return this.fsm.pressSingleWarning();
    };
    window.pressDualWarning = () => {
      this.animateWarningButtons();
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
        if (fsm.chamber1 === ChamberState.EMPTY) {
          this.scene.clearWiresAndDarts();
          this.scene.resetTarget();
          this.stopScenario();
        }
        this.updateDisplay();
      } else if (event === 'SAFETY_CHANGED') {
        const dEl = document.getElementById('taser-display');
        if (dEl) {
          dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
        }
        const sSwitch = document.getElementById('safety-switch');
        const sLabel = document.getElementById('safety-label');
        const secControls = document.getElementById('secondary-controls');

        if (sSwitch) sSwitch.classList.toggle('unsafe', !fsm.isSafe);
        if (sLabel) sLabel.textContent = fsm.isSafe ? 'SÄKRAD' : 'OSÄKRAD';
        if (secControls) secControls.style.display = 'block';

        this.updateDisplay();
      } else if (event === 'CHAMBER_CHANGED') {
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
          // EXKLUSIVT funktionskontroll får gul inverterad skärm
          const isFunk = payload.isFunk && (this.fsm.isFunkLocked || this.fsm.displayState === 'FUNK_MODE') && !this.fsm.isSafe;
          if (isFunk) {
            dEl.classList.add('oled-inverted', 'funk-mode', 'inverted');
          } else {
            dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
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
        this.hideNMIOverlay();
        this.scene.stopWarningArc();
        this.stopWarningArcHaptics();
        this.currentDistance = 3.0;
        this.aimX = 50;
        this.aimY = 50;
        this.tilt = 0;
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
    // Auto-engage gyro immediately on devices without explicit permission barrier
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission !== 'function' &&
      !this.xr.gyroEnabled
    ) {
      this.initGyro(true);
    }

    // Unlock AudioContext and silent MediaSession loop on first touch/click
    const unlockAudio = () => {
      this.audio.init();
      if (this.audio.silentAudioEl) {
        this.audio.silentAudioEl.play().catch(() => {});
      }
      if (!this.xr.gyroEnabled) {
        this.initGyro(true);
      }
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('touchstart', unlockAudio, { once: true, passive: true });

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
    this.setupTactileButton('btn-tilt', () => this.fsm.tiltWeapon());
    this.setupTactileButton('btn-warn', () => window.pressDualWarning());
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
    // Primär WebXR-knapp: öppnar scenariomenyn omedelbart vid tryck (0ms) utan att behöva hållas in
    this.setupTactileButton('btn-webxr', toggleWebXRModalOrEnd);
    this.setupTactileButton('webxr-btn', toggleWebXRModalOrEnd);
    this.setupTactileButton('btn-place', () => this.togglePlaceMode());
    this.setupTactileButton('btn-info', () => this.openModal('info-modal'));
    this.setupTactileButton('warn-left', () => window.pressSingleWarning());
    this.setupTactileButton('warn-right', () => window.pressSingleWarning());
    this.setupTactileButton('safety-switch', () => window.toggleSafety());
    this.setupTactileButton('btn-confirm', () => this.confirmPlacement());
    this.setupTactileButton('btn-cancel-scenario', () => this.closeModal('scenario-modal'));
    this.setupTactileButton('btn-close-scenario', () => this.closeModal('scenario-modal'));

    // Scenario modal buttons - startar WebXR/Kamera omedelbart vid snabb klick/pointerup med bibehållen user activation
    this.setupTactileButton('btn-start-real-person-xr', () => {
      this.closeModal('scenario-modal');
      this.startRealPersonAI();
    }, { useClick: true });
    this.setupTactileButton('btn-xr-static', () => {
      this.closeModal('scenario-modal');
      this.startWebXR('static');
    }, { useClick: true });
    this.setupTactileButton('btn-xr-moving', () => {
      this.closeModal('scenario-modal');
      this.startWebXR('moving');
    }, { useClick: true });
    this.setupTactileButton('btn-xr-charging', () => {
      this.closeModal('scenario-modal');
      this.startWebXR('charging');
    }, { useClick: true });

    // Stäng modal när man klickar på bakgrunden utanför modal-rutan
    document.querySelectorAll('.modal-overlay').forEach((modal) => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.closeModal(modal.id);
        }
      });
    });

    // Reticle placement tap in WebXR
    this.scene.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (this.xr.placeMode && this.xr.xrSession) {
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

  setupTactileButton(elementOrId, callback, options = {}) {
    const el = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!el) return;

    const useClick = options.useClick || options.triggerOn === 'click';
    let lastActionTs = 0;

    const clearPress = () => el.classList.remove('active-press');
    el.addEventListener('pointerup', clearPress);
    el.addEventListener('pointercancel', clearPress);
    el.addEventListener('pointerleave', clearPress);

    if (useClick) {
      let firedInCurrentGesture = false;

      const triggerAction = (e) => {
        const now = Date.now();
        if (now - lastActionTs < 280) return;
        lastActionTs = now;
        clearPress();

        if (this.audio) this.audio.init();
        if (navigator.vibrate) {
          try { navigator.vibrate(14); } catch (err) {}
        }

        try {
          callback(e);
        } catch (err) {
          console.error('Tactile button error on', el.id, err);
        }
      };

      el.addEventListener('pointerdown', () => {
        firedInCurrentGesture = false;
        el.classList.add('active-press');
      });

      // pointerup ger omedelbar respons vid snabb fingertapp och bär W3C user activation för WebXR
      el.addEventListener('pointerup', (e) => {
        if (!firedInCurrentGesture) {
          firedInCurrentGesture = true;
          triggerAction(e);
        }
      });

      // click-fallback för tangentbord och standardklick
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
      // Debounce window to prevent double invocation from pointerdown + synthetic click
      if (now - lastActionTs < 350) {
        if (e && e.cancelable) e.preventDefault();
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

      try {
        callback(e);
      } catch (err) {
        console.error('Tactile button error on', el.id, err);
      }

      if (e && e.cancelable && e.type !== 'click') {
        e.preventDefault();
      }
    };

    // Primary responsive event: pointerdown gives 0ms immediate response for weapon controls
    el.addEventListener('pointerdown', fireAction);

    // Click handler fallback with 400ms guard to ensure no double-fire
    el.addEventListener('click', (e) => {
      const now = Date.now();
      if (now - lastActionTs < 400) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      fireAction(e);
    });
  }

  handleTrigger() {
    if (this.isGameOver) {
      this.audio.init();
      if (typeof this.audio.playClickSound === 'function') {
        this.audio.playClickSound();
      }
      this.log("<span style='color:#e74c3c; font-weight:bold;'>AVTRYCKARE SPÄRRAD:</span> Angriparen har nått fram (< 0.8 m)! Tryck på Återställ för att börja om.");
      return;
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
      const { ndc1, ndc2, spreadInfo } = this.ballistics.calculateNdcCoordinates(
        this.currentDistance,
        firedChamber,
        vHeight
      );

      // Perform 3D raycast on mannequin or Live Target
      let hitResult = this.scene.fireDarts({ ndc1, ndc2, chamber: firedChamber });

      // Live AI-Targeting (Personspårning): Kontrollera om skotten överlappar med måltavlans zoner
      if (this.aiPose && this.aiPose.isActive && this.aiPose.isPersonDetected) {
        const liveHits = this.aiPose.checkScreenHit(this.aimX, this.aimY, spreadInfo.visualDropPx);
        if (liveHits) {
          hitResult = liveHits;
        }
      }

      // Evaluate NMI success
      const evalResult = this.ballistics.evaluateHit({
        hit1: hitResult.hit1,
        hit2: hitResult.hit2,
        hitWall1: hitResult.hitWall1,
        hitWall2: hitResult.hitWall2,
        currentDistance: this.currentDistance,
        heavyClothing: this.fsm.heavyClothing
      });

      if (evalResult.success) {
        this.isTased = true;
        this.log(`<span style='color:#2ecc71; font-weight:bold;'>NMI UPPNÅDD!</span> ${evalResult.reason}`);
        this.showNMIOverlay(true, evalResult.reason, evalResult.spreadCm);
        this.fsm.startCycle('NMI påbörjad...', 'DARTS');

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

    this.updateDisplay();
  }

  updateAimVisuals() {
    const spreadData = this.ballistics.calculateSpread(this.currentDistance, this.fsm.activeChamber);

    const distLabel = document.getElementById('dist-label');
    const spreadLabel = document.getElementById('spread-label');
    if (distLabel) distLabel.textContent = `${spreadData.distanceMeters.toFixed(1)} M`;
    if (spreadLabel) spreadLabel.textContent = `SPRIDNING: ${spreadData.spreadCm.toFixed(1)} CM`;

    const laserRed = document.getElementById('laser-red');
    if (laserRed) {
      laserRed.style.top = `calc(50% + ${spreadData.visualDropPx}px)`;
    }
  }

  updateProjectors() {
    const flashlight = document.getElementById('flashlight');
    const laserGreen = document.getElementById('laser-green');
    const laserRed = document.getElementById('laser-red');

    const shouldShow = !this.fsm.isSafe && this.fsm.hasBattery && !this.fsm.stealthMode;
    if (flashlight) flashlight.style.display = shouldShow ? 'block' : 'none';
    // Fas 4: 3D-lasrarna projiceras direkt från muzzlePoint i Three.js-scenen
    if (laserGreen) laserGreen.style.display = 'none';
    if (laserRed) laserRed.style.display = 'none';
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

    const dEl = document.getElementById('taser-display');
    if (!dEl) return;

    if (!this.fsm.hasBattery) {
      dEl.innerHTML = '';
      dEl.className = 'display-screen';
      dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
      this.updateProjectors();
      return;
    }

    dEl.classList.toggle('dimmed', this.fsm.stealthMode);

    // Stenhård isolering av Funktionskontroll:
    // Displayen ska EXKLUSIVT vara inverterad/gul om tillståndet är exakt FUNK_MODE och osäkrat
    const isFunkMode = (this.fsm.displayState === 'FUNK_MODE' || this.fsm.isFunkLocked) && !this.fsm.isSafe;

    if (isFunkMode) {
      // EXKLUSIVT FUNKTIONSKONTROLL: Gul bakgrund med svarta ikoner
      dEl.innerHTML = this.renderIconsHTML();
      dEl.classList.add('oled-inverted', 'funk-mode', 'inverted');
    } else {
      // I ALLA ANDRA FALL (DEFAULT): Svart OLED-bakgrund med lysande text/ikoner
      dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');

      if (this.fsm.displayState === 'BOOT') {
        dEl.innerHTML = 'v1.4.10<br>[||||] 94%';
      } else if (this.fsm.displayState === 'ACTIVE' || !this.fsm.isSafe) {
        // Skarpt osäkrat läge: Svart OLED med lysande gula symboler
        dEl.innerHTML = this.renderIconsHTML();
      } else {
        // Säkrat läge: Släckt skärm
        dEl.innerHTML = '';
      }
    }

    this.updateProjectors();

    const driveStunBtn = document.getElementById('btn-kontaktstot');
    if (driveStunBtn) {
      const bothFired = this.fsm.chamber1 === ChamberState.FIRED && this.fsm.chamber2 === ChamberState.FIRED;
      driveStunBtn.style.display = bothFired && !this.fsm.isSafe ? 'block' : 'none';
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
        this.xr.placeMode = false;
        this.xr.figureLocked = true;
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
          this.scene.taserGroup.lookAt(camPos.x, 0, camPos.z);
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

    const btn = document.getElementById('btn-scenario');
    if (btn) {
      btn.innerHTML = '🚨 STARTA ANGREPP';
      btn.classList.remove('active-attack');
    }

    const tLabel = document.getElementById('target-label');
    if (tLabel) {
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
    // Taktiska scenario triggers
    if (cmd === 'STARTA_ANGREPP') {
      this.startScenario();
      return;
    }
    if (cmd === 'STOPPA_ANGREPP') {
      this.stopScenario();
      return;
    }

    if (this.scene.figureFallen) {
      this.log("<span style='color:#bdc3c7'>Målet är redan neutraliserat / på marken.</span>");
      return;
    }

    // --- TAKTISK VARNING: ELCHOCKVAPEN & BEREDD ATT ANVÄNDA DET ---
    if (cmd === 'VARNING_FULL' || cmd === 'VARNING_ELCHOCKVAPEN' || cmd === 'VARNING_BEREDD') {
      const wasWarned = this.warningGiven;
      this.warningGiven = true;
      this.updateWarningUI();

      if (cmd === 'VARNING_FULL') {
        this.log("<span style='color:#f1c40f; font-weight:bold;'>📢 TAKTISK VARNING DELGIVEN:</span> <i>\"Jag har ett elchockvapen, jag är beredd att använda det!\"</i>");
      } else if (cmd === 'VARNING_ELCHOCKVAPEN') {
        this.log("<span style='color:#f1c40f; font-weight:bold;'>📢 TAKTISK VARNING DELGIVEN:</span> <i>\"Jag har ett elchockvapen!\"</i>");
      } else {
        this.log("<span style='color:#f1c40f; font-weight:bold;'>📢 TAKTISK VARNING DELGIVEN:</span> <i>\"Jag är beredd att använda det!\"</i>");
      }

      if (this.threatLevel >= 3) {
        if (!wasWarned) {
          this.suspectSpeak(Math.random() < 0.5 ? 'Tror du jag bryr mig om ditt elvapen?!' : 'Kom inte närmare, jag menar allvar!');
        } else {
          this.suspectSpeak('Jag hörde dig! Stick sa jag!');
        }
      } else {
        this.suspectSpeak('Vadå elchockvapen?! Ta det lugnt!');
      }
      return;
    }

    // --- KOMMANDO: SLÄPP KNIVEN / VAPNET ---
    if (cmd === 'SLAPP_KNIVEN') {
      const isArmed = this.threatLevel >= 3 || (this.scene.knifeMesh && this.scene.knifeMesh.visible) || (this.scene.batonMesh && this.scene.batonMesh.visible) || (this.threatWeapon === 'FISTS');
      if (isArmed) {
        // Taktisk sannolikhetsbedömning: 30% chans att målet lyder och släpper vapnet / sänker garden
        const obeys = Math.random() < 0.30;
        if (obeys) {
          if (this.threatInterval) clearInterval(this.threatInterval);
          this.threatLevel = 0;
          if (typeof window !== 'undefined') window.threatLevel = 0;

          // Sänk garden / släpp vapen och återgå mjukt till stillastående
          if (this.scene) {
            this.scene.armOverrideWeight = 0;
            this.scene.updateWeaponVisibility();
            this.scene.setAnimation('Idle', 0.4);
          }

          const tLabel = document.getElementById('target-label');
          if (tLabel) {
            tLabel.textContent = 'PERSON: GAV UPP';
            tLabel.classList.remove('armed');
          }

          const weaponName = this.threatWeapon === 'BATON' ? 'batongen' : (this.threatWeapon === 'KNIFE' ? 'kniven' : 'garden');
          this.log(`<span style='color:#2ecc71; font-weight:bold;'>✅ KOMMANDO LYCKADES (30% chans):</span> Målet släpper ${weaponName} och kapitulerar!`);
          this.suspectSpeak(this.threatWeapon === 'FISTS' ? 'Okej! Skjut inte, jag ger upp!' : `Okej! Skjut inte, jag släpper ${weaponName}!`);
        } else {
          // 70% risk: Målet vägrar och eskalerar
          const weaponName = this.threatWeapon === 'BATON' ? 'batongen' : (this.threatWeapon === 'KNIFE' ? 'kniven' : 'angreppet');
          this.log(`<span style='color:#e74c3c; font-weight:bold;'>⚠️ KOMMANDO IGNORERADES (70% risk):</span> Målet vägrar avbryta ${weaponName}! Fortsätter anfallet!`);
          this.suspectSpeak('Aldrig i livet! Kom hit då!');
          this.scene.setAnimation('Walk', 0.3);
        }
      } else {
        this.suspectSpeak('Jag har inget vapen! Vad glor du på?!');
        this.log("<span style='color:#f39c12'>Målet har ännu inte dragit något vapen.</span>");
      }
    } else if (cmd === 'STANNA') {
      if (this.threatLevel >= 3) {
        const pauses = Math.random() < 0.25;
        if (pauses) {
          this.suspectSpeak('Vad vill du mig?!');
          this.scene.setAnimation('Idle', 0.3);
          setTimeout(() => {
            if (!this.scene.figureFallen && this.threatLevel >= 3) {
              this.scene.setAnimation('Walk', 0.4);
            }
          }, 2500);
          this.log("<span style='color:#f1c40f; font-weight:bold;'>Målet tvekar och stannar tillfälligt!</span>");
        } else {
          this.suspectSpeak('Stoppa mig om du kan!');
          this.log("<span style='color:#e74c3c'>Målet ignorerar stanna-ordern.</span>");
        }
      } else {
        this.suspectSpeak('Jag står ju still!');
      }
    } else if (cmd === 'LAGG_DIG_NER') {
      const isArmed = this.threatLevel >= 3 || (this.scene.knifeMesh && this.scene.knifeMesh.visible) || (this.scene.batonMesh && this.scene.batonMesh.visible) || (this.threatWeapon === 'FISTS');
      if (isArmed) {
        // Taktisk eskalering med sannolikhetslogik:
        // Utan varning (warningGiven == false): endast 10% chans att figuren ger upp
        // Efter varning (warningGiven == true): ökar chansen till 40% att figuren avbryter anfallet
        const surrenderChance = this.warningGiven ? 0.40 : 0.10;
        const obeys = Math.random() < surrenderChance;

        if (obeys) {
          if (this.threatInterval) clearInterval(this.threatInterval);
          this.threatLevel = 0;
          if (typeof window !== 'undefined') window.threatLevel = 0;

          // Målet lägger sig ner på marken och släpper hot
          if (this.scene) {
            this.scene.armOverrideWeight = 0;
            this.scene.updateWeaponVisibility();
            this.scene.collapseTarget();
          }

          const tLabel = document.getElementById('target-label');
          if (tLabel) {
            tLabel.textContent = 'PERSON: GAV UPP';
            tLabel.classList.remove('armed');
          }

          const chanceInfo = this.warningGiven ? '40% chans efter formell varning' : '10% chans utan varning';
          const weaponDesc = this.threatWeapon === 'BATON' ? 'batongen' : (this.threatWeapon === 'KNIFE' ? 'kniven' : 'garden');
          this.log(`<span style='color:#2ecc71; font-weight:bold;'>✅ MÅLET GER UPP (${chanceInfo})!</span> Målet släpper ${weaponDesc} och lägger sig platt på marken.`);
          this.suspectSpeak('Okej! Jag lägger mig ner, skjut inte!');
        } else {
          const failInfo = this.warningGiven ? '60% risk trots delgiven varning' : '90% risk utan varning';
          this.log(`<span style='color:#e74c3c; font-weight:bold;'>⚠️ MÅLET VÄGRAR (${failInfo})!</span> Målet vägrar lägga sig ner och fortsätter anfallet!`);
          this.suspectSpeak(this.warningGiven ? 'Ditt elvapen skrämmer mig inte! Kom hit då!' : 'Aldrig i livet! Jag lägger mig inte!');
          this.scene.setAnimation('Walk', 0.3);
        }
      } else {
        this.suspectSpeak('Okej, jag lägger mig ner!');
        this.scene.collapseTarget();
        const tLabel = document.getElementById('target-label');
        if (tLabel) {
          tLabel.textContent = 'PERSON: PÅ MARKEN';
          tLabel.classList.remove('armed');
        }
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

  async startRealPersonAI() {
    this.closeModal('scenario-modal');
    const cameraFeed = document.getElementById('camera-feed');
    const btnCamera = document.getElementById('btn-camera');
    const viewport = document.getElementById('viewport');
    const tLabel = document.getElementById('target-label');

    // Immediate user feedback
    if (tLabel) tLabel.textContent = 'INITIERAR AI & KAMERA...';
    if (btnCamera) btnCamera.innerHTML = '⏳ Startar AI...';
    this.log("<span style='color:#f1c40f'>⏳ Initierar Mixed Reality (Kamera + BlazePose AI)...</span>");

    try {
      // STEG 1: Kamerabehörighet (MÅSTE anropas direkt vid användarklick för att behålla aktiv User Gesture)
      const isActive = await this.xr.toggleCameraAR(cameraFeed, viewport);

      if (!isActive) {
        // Om användaren klickade för att stänga av kameran
        document.body.classList.remove('ar-active', 'live-ai-active');
        document.documentElement.classList.remove('ar-active', 'live-ai-active');
        this.scene.disableARMode();
        if (btnCamera) {
          btnCamera.innerHTML = '🤖 Live AI (Kamera)';
          btnCamera.classList.remove('active-cam');
        }
        if (tLabel) tLabel.textContent = 'PERSON (3D)';
        this.aiPose.stop();
        this.currentDistance = 3.0;
        this.updateAimVisuals();
        this.log('Kamera avstängd. Återgått till 3D-mål.');
        this.stopScenario();
        return;
      }

      // Aktivera helskärms-AR och Live-AI klasser samt Three.js transparent bakgrund
      document.body.classList.add('ar-active', 'live-ai-active');
      document.documentElement.classList.add('ar-active', 'live-ai-active');
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

      if (isSimulated) {
        this.log("<span style='color:#f1c40f; font-weight:bold;'>ℹ️ SIMULERAD AI-KAMERA:</span> Fysisk kamera är blockerad av webbläsarens iframe-säkerhet. Kör med simulerad person för full AI- och ballistikträning!");
      } else {
        this.log("<span style='color:#2ecc71; font-weight:bold;'>✅ LIVE AI AKTIV:</span> Riktar kameran mot en levande människa för dynamiska träffzoner.");
      }
    } catch (err) {
      console.warn('[STARTUP SEQUENCE NOTICE] Faller tillbaka till simulerad AI-person:', err);
      document.body.classList.add('ar-active', 'live-ai-active');
      document.documentElement.classList.add('ar-active', 'live-ai-active');
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
      this.log("<span style='color:#f1c40f;'>Kamera ej tillgänglig. Startat i simulerat AI-läge för test och verifiering.</span>");
    }
  }

  async toggleCameraAR() {
    return this.startRealPersonAI();
  }

  async startWebXR(type = 'static') {
    this.closeModal('scenario-modal');
    try {
      const res = await this.xr.startXR(type);
      if (res && res.success === false) {
        this.startVirtualScenario(type);
      }
    } catch (err) {
      console.warn('[WEBXR NOTICE] Växlar automatiskt till simulerat AR-scenario:', err.message);
      this.startVirtualScenario(type);
    }
  }

  startVirtualScenario(type = 'static') {
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
    document.body.classList.add('ar-active', 'webxr-mode', 'ar-combat-mode');
    document.documentElement.classList.add('ar-active', 'webxr-mode', 'ar-combat-mode');
    const mainContainer = document.getElementById('main-container');
    if (mainContainer) mainContainer.classList.add('ar-combat-mode');
    const simControls = document.querySelector('.sim-controls');
    if (simControls) simControls.classList.add('ar-combat-mode');
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
    this.log(`WebXR startad i scenario: ${scenario}`);
  }

  onXRSessionEnd() {
    document.body.classList.remove('ar-active', 'webxr-mode', 'ar-combat-mode');
    document.documentElement.classList.remove('ar-active', 'webxr-mode', 'ar-combat-mode');
    const mainContainer = document.getElementById('main-container');
    if (mainContainer) mainContainer.classList.remove('ar-combat-mode');
    const simControls = document.querySelector('.sim-controls');
    if (simControls) simControls.classList.remove('ar-combat-mode');
    this.scene.disableARMode();

    const btnWebXR = document.getElementById('btn-webxr') || document.getElementById('webxr-btn');
    if (btnWebXR) {
      btnWebXR.textContent = '🌐 WebXR Scenarier';
      btnWebXR.style.backgroundColor = '';
    }

    if (this.xr.placeMode) this.confirmPlacement();
    this.scene.resetTarget();
    this.stopScenario();
    this.updateDisplay();
    this.log('WebXR-session avslutad.');
  }

  togglePlaceMode() {
    this.xr.placeMode = true;
    this.xr.figureLocked = false;
    const stdEl = document.getElementById('standard-controls');
    if (stdEl) stdEl.style.display = 'none';
    const plcEl = document.getElementById('placement-controls');
    if (plcEl) plcEl.style.display = 'block';

    this.scene.set3DVisibility(false);
    if (this.scene.placementMarker) this.scene.placementMarker.visible = true;

    const hint = document.getElementById('place-hint');
    if (hint) {
      hint.innerHTML = this.xr.xrSession ? 'Peka mot golvet och vänta på markör' : 'Klicka på golvet';
      hint.classList.add('visible');
    }
    this.log('Sök efter golvet och bekräfta...');
  }

  confirmPlacement() {
    const marker = this.scene.placementMarker;
    if (this.xr.xrSession && (!marker || !marker.visible)) {
      const xrCam = this.scene.renderer.xr.getCamera(this.scene.camera);
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
        this.scene.taserGroup.lookAt(xrCam.position.x, 0, xrCam.position.z);
        this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
        this.scene.taserGroup.visible = true;
      }
      this.log("<span style='color:#f39c12'>Standardposition vald (3m rakt framför dig).</span>");
    } else if (this.scene.taserGroup && marker && marker.visible) {
      this.scene.taserGroup.position.copy(marker.position);
      this.scene.taserGroup.visible = true;
      this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
    }

    this.xr.placeMode = false;
    this.xr.figureLocked = true;

    this.scene.set3DVisibility(true);
    if (marker) marker.visible = false;

    const hint = document.getElementById('place-hint');
    if (hint) hint.classList.remove('visible');

    const stdEl = document.getElementById('standard-controls');
    if (stdEl) stdEl.style.display = 'block';
    const plcEl = document.getElementById('placement-controls');
    if (plcEl) plcEl.style.display = 'none';

    this.log("<span style='color:#2ecc71'><b>🔒 Figuren är fastlåst!</b> Redo för insats.</span>");
    this.stopScenario();
  }

  initGyro(silent = false) {
    this.audio.init();
    this.xr.initGyro(
      (aimX, aimY) => {
        this.aimX = aimX;
        this.aimY = aimY;
        this.updateAimVisuals();
      },
      (direction, gamma) => {
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
          this.log(`📱 <span style='color:#3498db; font-weight:bold;'>GYRO-SNÄRT (${direction.toUpperCase()} ${Math.round(gamma)}°):</span> Växlar till kammare ${this.fsm.activeChamber} (${this.fsm.activeChamber === 1 ? '12°' : '3.5°'})!`);
        }
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
        this.log("<span style='color:#bdc3c7'>Enheten saknar hårdvarugyroskop. Använd '🔄 Vinkla (Tilt)' knappen.</span>");
      }
    });
  }

  resetSimulator() {
    this.audio.init();
    const dEl = document.getElementById('taser-display');
    if (dEl) {
      dEl.classList.remove('oled-inverted', 'funk-mode', 'inverted');
    }
    this.fsm.reset();
    this.isTased = false;
    this.isGameOver = false;
    this.hideFailOverlay();
    if (this.scene && this.scene.mixer) {
      this.scene.mixer.timeScale = 1.0;
    }
    this.scene.clearWiresAndDarts();
    this.scene.resetTarget();
    if (typeof window !== 'undefined' && typeof window.resetWeaponPhase4 === 'function') {
      window.resetWeaponPhase4(this.fsm);
    }
    this.updateDisplay();
    this.updateWarningUI();
    this.stopScenario();
    this.log("♻️ <span style='color:#2ecc71; font-weight:bold;'>Simulator återställd: Nya kassetter laddade (2/2 skarpa), mål och kablar rensade.</span>");
  }

  openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'flex';
  }

  closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
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

      if (this.scene.scene.background !== null) {
        this.scene.scene.background = null;
      }
      renderer.setClearColor(0x000000, 0);

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

      // Dynamic First-Person TASER 7 3D Weapon Pose, Convergence & Tilt update (uppdaterar muzzlePoint matrixWorld)
      if (typeof window !== 'undefined' && typeof window.updateWeaponPose === 'function') {
        window.updateWeaponPose(this);
      }

      // Dynamic Copper Wire updates anchored to muzzlePoint
      this.scene.updateWireDynamics(activeCamera);

      // 4. Dynamisk Raycasting för 3D-Lasercylindrar & Laserpunkter från muzzlePoint
      const currentCartridge = (typeof window !== 'undefined' && typeof window.activeCartridge === 'number')
        ? window.activeCartridge
        : (this.fsm.activeChamber === 2 ? 2 : 1);
      const weaponVisible = (typeof window !== 'undefined' && window.weaponMesh)
        ? !!window.weaponMesh.visible
        : false;
      if (typeof window !== 'undefined' && window.state) {
        window.state.isSafe = !!this.fsm.isSafe;
      }
      const isSafeState = (typeof window !== 'undefined' && window.state && typeof window.state.isSafe === 'boolean')
        ? window.state.isSafe
        : !!this.fsm.isSafe;
      const shouldShowLasers = weaponVisible && !isSafeState && this.fsm.hasBattery && !this.fsm.stealthMode && currentCartridge > 0;
      const aimNDC = renderer.xr.isPresenting
        ? this.scene._v3.set(0, 0, 0)
        : this.scene._v3.set((this.aimX / 100) * 2 - 1, -(this.aimY / 100) * 2 + 1, 0);

      const laserHit = this.scene.updateDynamicLaserRaycast(
        activeCamera,
        aimNDC,
        currentCartridge,
        (d, ch) => this.ballistics.calculateSpread(d, ch),
        shouldShowLasers
      );

      if (laserHit && laserHit.hit) {
        if (renderer.xr.isPresenting && !isNaN(laserHit.distance) && laserHit.distance > 0.1) {
          this.currentDistance = Math.max(0.4, laserHit.distance);
          this.updateAimVisuals();
        }
      }

      // Render the scene (Stereoscopic Side-by-Side 3D or Standard / WebXR)
      if (this.isStereoVR && !renderer.xr.isPresenting && this.stereoEffect) {
        this.stereoEffect.render(this.scene.scene, activeCamera);
      } else {
        renderer.render(this.scene.scene, activeCamera);
      }
    });
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
