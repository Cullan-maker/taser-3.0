/**
 * TASER 7 Elite Tactical Simulator - Main Application Coordinator
 * High-performance mobile portrait layout, WebXR, Three.js, Media Session API & PWA.
 */

import * as THREE from 'three';
if (typeof window !== 'undefined') window.THREE = THREE;
import { TaserFSM, ChamberState } from './fsm.js';
import { TaserAudio } from './audio.js';
import { TaserBallistics } from './ballistics.js';
import { TaserScene } from './scene.js';
import { TaserXR } from './xr.js';
import { TaserPWA } from './pwa.js';
import { TaserVoice } from './voice.js';
import { TaserAIPose } from './pose.js';

export class TaserApp {
  constructor() {
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
    this.invertMouseY = false;

    // Threat escalation & Verbal warnings
    this.threatLevel = 0;
    this.threatInterval = null;
    this.nmiTimer = null;
    this.warningGiven = false;

    this.initDOM();
    this.initFSMSubscriptions();
    this.initInputs();
    this.startRenderLoop();

    this.log("Simulator v7.47 (Tactical WebXR & PWA) startar... <span style='color:#f1c40f;'>Sätt i batteri!</span>");
    this.startThreatEscalation();
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
      return this.fsm.toggleBattery();
    };
    window.toggleCassette = () => this.fsm.toggleCassette();
    window.toggleSafety = () => this.fsm.toggleSafety();
    window.tiltWeapon = () => this.fsm.tiltWeapon();
    window.activateStealth = () => this.fsm.activateStealth();
    window.toggleClothing = () => this.fsm.toggleClothing();
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
    window.toggleInvertMouse = () => this.toggleInvertMouse();
    window.openModal = (id) => this.openModal(id);
    window.closeModal = (id) => this.closeModal(id);
    window.promptInstall = () => this.pwa.promptInstall();
    window.toggleVoice = () => this.voice.toggle();
    window.testVoiceCommand = (cmd) => this.voice.simulateCommand(cmd);

    // Direct event listener for the real-person WebXR/AI button
    const btnRealPerson = document.getElementById('btn-start-real-person-xr');
    if (btnRealPerson) {
      btnRealPerson.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startRealPersonAI();
      });
    }
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
        this.updateDisplay();
      } else if (event === 'CASSETTE_CHANGED') {
        const cEl = document.getElementById('stat-cassette');
        if (cEl) {
          const hasLoaded = fsm.chamber1 === ChamberState.LOADED;
          cEl.textContent = hasLoaded ? '⏏️ Kassetter i' : '⏏️ Kassetter ur';
          cEl.classList.toggle('ok', hasLoaded);
        }
        if (fsm.chamber1 === ChamberState.EMPTY) {
          this.scene.clearWiresAndDarts();
          this.scene.resetTarget();
          this.startThreatEscalation();
        }
        this.updateDisplay();
      } else if (event === 'SAFETY_CHANGED') {
        const sSwitch = document.getElementById('safety-switch');
        const sLabel = document.getElementById('safety-label');
        const secControls = document.getElementById('secondary-controls');

        if (sSwitch) sSwitch.classList.toggle('unsafe', !fsm.isSafe);
        if (sLabel) sLabel.textContent = fsm.isSafe ? 'SÄKRAD' : 'OSÄKRAD';
        if (secControls) secControls.style.display = fsm.isSafe ? 'block' : 'none';

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
      } else if (event === 'CYCLE_STARTED') {
        this.log(`<span style='color:#3498db'>${payload.message} ⚡</span>`);
        const canvas = document.getElementById('three-canvas');
        if (payload.type === 'DARTS' || payload.type === 'DRIVE_STUN') {
          if (canvas) canvas.classList.add('flash');
          const lightning = document.getElementById('lightning');
          if (lightning) lightning.style.display = 'block';
        } else {
          const warnArc = document.getElementById('warning-arc');
          if (warnArc) warnArc.style.display = 'block';
        }
        this.audio.startElectricSound();
        this.updateDisplay();
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
        const warnArc = document.getElementById('warning-arc');
        if (warnArc) warnArc.style.display = 'none';

        this.audio.stopElectricSound();
        this.log('Strömcykel avslutad.');
        this.updateDisplay();
      } else if (event === 'RESET') {
        this.hideNMIOverlay();
        this.currentDistance = 3.0;
        this.aimX = 50;
        this.aimY = 50;
        this.warningGiven = false;
        this.updateWarningUI();
        this.scene.resetTarget();
        this.updateDisplay();
        this.startThreatEscalation();
      }
    });
  }

  initInputs() {
    // Unlock AudioContext and silent MediaSession loop on first touch/click
    const unlockAudio = () => {
      this.audio.init();
      if (this.audio.silentAudioEl) {
        this.audio.silentAudioEl.play().catch(() => {});
      }
      // On non-iOS devices where no explicit permission barrier exists, auto-engage gyro
      if (
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission !== 'function' &&
        !this.xr.gyroEnabled
      ) {
        this.initGyro(true);
      }
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // Keyboard Shortcuts & Physical Hardware Keys
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      // Physical Volume Keys / Media Keys mapped to Warning Arc
      if (
        k === 'audiovolumeup' || 
        k === 'audiovolumedown' || 
        k === 'volumeup' || 
        k === 'volumedown' ||
        e.code === 'AudioVolumeUp' ||
        e.code === 'AudioVolumeDown'
      ) {
        e.preventDefault();
        window.pressSingleWarning();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        this.handleTrigger();
      } else if (k === 'c' || e.key === 'Shift') {
        e.preventDefault();
        window.pressSingleWarning();
      } else if (k === 'z') {
        this.fsm.setChamber(1);
      } else if (k === 'x') {
        this.fsm.setChamber(2);
      }
    });

    // Viewport aiming with mouse or touch
    const viewport = document.getElementById('viewport');
    if (viewport) {
      viewport.addEventListener('mousedown', (e) => {
        if (this.xr.placeMode) return;
        if (e.button === 0) {
          e.preventDefault();
          this.handleTrigger();
        }
      });

      const handlePointerMove = (e) => {
        if (this.xr.gyroEnabled || this.xr.placeMode || this.xr.xrSession) return;
        const rect = viewport.getBoundingClientRect();
        this.aimX = ((e.clientX - rect.left) / rect.width) * 100;
        const yPct = ((e.clientY - rect.top) / rect.height) * 100;
        this.aimY = this.invertMouseY ? 100 - yPct : yPct;

        if (isNaN(this.aimX)) this.aimX = 50;
        if (isNaN(this.aimY)) this.aimY = 50;
        this.aimX = Math.max(0, Math.min(100, this.aimX));
        this.aimY = Math.max(0, Math.min(100, this.aimY));

        this.updateAimVisuals();
      };

      viewport.addEventListener('mousemove', handlePointerMove);
      viewport.addEventListener('touchmove', (e) => {
        if (e.touches && e.touches[0]) {
          handlePointerMove(e.touches[0]);
        }
      }, { passive: true });
    }

    // Reticle placement tap in WebXR
    this.scene.renderer.domElement.addEventListener('pointerdown', (e) => {
      if (this.xr.placeMode && this.xr.xrSession) {
        const rect = viewport.getBoundingClientRect();
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

  handleTrigger() {
    this.audio.init();
    const result = this.fsm.pressTrigger((firedChamber) => {
      this.audio.playPopSound();

      // Calculate ballistic coordinates
      const viewport = document.getElementById('viewport');
      const vHeight = viewport ? viewport.clientHeight : 320;
      const { ndc1, ndc2, spreadInfo } = this.ballistics.calculateNdcCoordinates(
        this.currentDistance,
        firedChamber,
        vHeight
      );

      // Perform 3D raycast on mannequin
      const hitResult = this.scene.fireDarts({ ndc1, ndc2, chamber: firedChamber });

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
        this.log(`<span style='color:#2ecc71; font-weight:bold;'>NMI UPPNÅDD!</span> ${evalResult.reason}`);
        this.showNMIOverlay(true, evalResult.reason, evalResult.spreadCm);
        this.fsm.startCycle('NMI påbörjad...', 'DARTS');

        if (this.threatInterval) clearInterval(this.threatInterval);
        const sub = document.getElementById('subtitle-overlay');
        if (sub) sub.style.display = 'none';
        this.audio.suspectSpeak('Aaaargh!');

        // Collapse mannequin to the floor
        this.scene.collapseTarget();
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
    if (laserGreen) laserGreen.style.display = shouldShow ? 'block' : 'none';

    if (laserRed) {
      const currentChamberState = this.fsm.activeChamber === 1 ? this.fsm.chamber1 : this.fsm.chamber2;
      laserRed.style.display = shouldShow && currentChamberState === ChamberState.LOADED ? 'block' : 'none';
    }
  }

  renderIconsHTML() {
    const getIconClass = (state) => {
      if (state === ChamberState.LOADED) return 'loaded';
      if (state === ChamberState.FIRED) return 'fired';
      return 'empty';
    };
    const line1 = this.fsm.activeChamber === 1 ? 'show' : '';
    const line2 = this.fsm.activeChamber === 2 ? 'show' : '';

    return `
      <div class="display-icons">
        <div class="chamber-col">
          <div class="icon-cassette ${getIconClass(this.fsm.chamber1)}"></div>
          <div class="active-line ${line1}"></div>
        </div>
        <div class="icon-battery-wrap full">
          <div class="batt-nub"></div>
          <div class="batt-body"></div>
        </div>
        <div class="chamber-col">
          <div class="icon-cassette ${getIconClass(this.fsm.chamber2)}"></div>
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
      this.updateProjectors();
      return;
    }

    dEl.classList.toggle('dimmed', this.fsm.stealthMode);

    if (this.fsm.displayState === 'BOOT') {
      dEl.innerHTML = 'v1.4.10<br>[||||] 94%';
      dEl.classList.remove('inverted');
    } else if (this.fsm.displayState === 'FUNK_MODE') {
      dEl.innerHTML = this.renderIconsHTML();
      dEl.classList.add('inverted');
    } else if (this.fsm.displayState === 'ACTIVE') {
      dEl.innerHTML = this.renderIconsHTML();
      dEl.classList.remove('inverted');
    } else {
      dEl.innerHTML = '';
      dEl.classList.remove('inverted');
    }

    this.updateProjectors();

    const driveStunBtn = document.getElementById('btn-kontaktstot');
    if (driveStunBtn) {
      const bothFired = this.fsm.chamber1 === ChamberState.FIRED && this.fsm.chamber2 === ChamberState.FIRED;
      driveStunBtn.style.display = bothFired && !this.fsm.isSafe ? 'block' : 'none';
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

  updateWarningUI() {
    const badge = document.getElementById('hud-warning');
    if (badge) {
      badge.style.display = this.warningGiven ? 'inline-block' : 'none';
      if (this.warningGiven) {
        badge.textContent = '⚠️ VARNING DELGIVEN';
      }
    }
  }

  startThreatEscalation() {
    this.threatLevel = 0;
    if (typeof window !== 'undefined') window.threatLevel = 0;
    if (this.scene.knifeMesh) this.scene.knifeMesh.visible = false;
    if (this.threatInterval) clearInterval(this.threatInterval);
    this.warningGiven = false;
    this.updateWarningUI();
    this.scene.setAnimation('Idle', 0.4);

    const tLabel = document.getElementById('target-label');
    if (tLabel) {
      tLabel.textContent = 'PERSON (3D)';
      tLabel.classList.remove('armed');
    }

    this.threatInterval = setInterval(() => {
      if (this.scene.figureFallen || !this.scene.taserGroup || !this.scene.taserGroup.visible) return;

      this.threatLevel++;
      if (typeof window !== 'undefined') window.threatLevel = this.threatLevel;

      if (this.threatLevel === 1) {
        this.suspectSpeak('Vad fan glor du på?! Backa!');
      } else if (this.threatLevel === 2) {
        this.suspectSpeak('Rör mig inte sa jag! Stick!');
      } else if (this.threatLevel === 3) {
        this.suspectSpeak('Jag sprättar dig! Jag svär!');
        if (this.scene.knifeMesh) this.scene.knifeMesh.visible = true;
        this.scene.setAnimation('Walk', 0.5);
        this.log("<span style='color:red; font-weight:bold;'>VARNING: Målet har dragit kniv! Omedelbar respons krävs!</span>");
        if (tLabel) {
          tLabel.textContent = 'PERSON: BEVÄPNAD';
          tLabel.classList.add('armed');
        }
      }
    }, 6000);
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

    // --- KOMMANDO: SLÄPP KNIVEN ---
    if (cmd === 'SLAPP_KNIVEN') {
      const isArmed = this.threatLevel >= 3 || (this.scene.knifeMesh && this.scene.knifeMesh.visible);
      if (isArmed) {
        // Taktisk sannolikhetsbedömning: 30% chans att målet lyder och släpper kniven
        const obeys = Math.random() < 0.30;
        if (obeys) {
          if (this.threatInterval) clearInterval(this.threatInterval);
          this.threatLevel = 0;
          if (typeof window !== 'undefined') window.threatLevel = 0;

          // Släpp kniven och återgå till stillastående
          if (this.scene.knifeMesh) this.scene.knifeMesh.visible = false;
          this.scene.setAnimation('Idle', 0.4);

          const tLabel = document.getElementById('target-label');
          if (tLabel) {
            tLabel.textContent = 'PERSON: GAV UPP';
            tLabel.classList.remove('armed');
          }

          this.log("<span style='color:#2ecc71; font-weight:bold;'>✅ KOMMANDO LYCKADES (30% chans):</span> Målet släpper kniven och kapitulerar!");
          this.suspectSpeak('Okej! Skjut inte, jag släpper den!');
        } else {
          // 70% risk: Målet vägrar och eskalerar
          this.log("<span style='color:#e74c3c; font-weight:bold;'>⚠️ KOMMANDO IGNORERADES (70% risk):</span> Målet vägrar släppa kniven! Fortsätter anfallet!");
          this.suspectSpeak('Aldrig i livet! Kom hit då!');
          this.scene.setAnimation('Walk', 0.3);
        }
      } else {
        this.suspectSpeak('Jag har ingen kniv! Vad glor du på?!');
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
      const isArmed = this.threatLevel >= 3 || (this.scene.knifeMesh && this.scene.knifeMesh.visible);
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

          // Målet släpper kniven och lägger sig ner på marken
          if (this.scene.knifeMesh) this.scene.knifeMesh.visible = false;
          this.scene.collapseTarget();

          const tLabel = document.getElementById('target-label');
          if (tLabel) {
            tLabel.textContent = 'PERSON: GAV UPP';
            tLabel.classList.remove('armed');
          }

          const chanceInfo = this.warningGiven ? '40% chans efter formell varning' : '10% chans utan varning';
          this.log(`<span style='color:#2ecc71; font-weight:bold;'>✅ MÅLET GER UPP (${chanceInfo})!</span> Målet släpper kniven och lägger sig platt på marken.`);
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
        if (btnCamera) {
          btnCamera.innerHTML = '🤖 Live AI (Kamera)';
          btnCamera.classList.remove('active-cam');
        }
        if (tLabel) tLabel.textContent = 'PERSON (3D)';
        this.aiPose.stop();
        this.currentDistance = 3.0;
        this.updateAimVisuals();
        this.log('Kamera avstängd. Återgått till 3D-mål.');
        this.startThreatEscalation();
        return;
      }

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

  async startWebXR(type) {
    this.closeModal('scenario-modal');
    try {
      await this.xr.startXR(type);
    } catch (err) {
      console.error('[WEBXR STARTUP ERROR]', err);
      this.showTacticalError('WebXR Fel', err.message || 'WebXR kunde inte startas.', 'WEBXR');
      this.log(`<span style='color:#e74c3c; font-weight:bold;'>WebXR fel:</span> ${err.message}`);
    }
  }

  onXRSessionStart(session, scenario) {
    document.body.classList.add('ar-active', 'webxr-mode');
    document.documentElement.classList.add('ar-active');
    this.scene.enableARMode();

    const btnWebXR = document.getElementById('btn-webxr');
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
    document.body.classList.remove('ar-active', 'webxr-mode');
    document.documentElement.classList.remove('ar-active');
    this.scene.disableARMode();

    const btnWebXR = document.getElementById('btn-webxr');
    if (btnWebXR) {
      btnWebXR.textContent = '🌐 WebXR';
      btnWebXR.style.backgroundColor = '#34495e';
    }

    if (this.xr.placeMode) this.confirmPlacement();
    this.scene.resetTarget();
    this.startThreatEscalation();
    this.updateDisplay();
    this.log('WebXR-session avslutad.');
  }

  togglePlaceMode() {
    this.xr.placeMode = true;
    this.xr.figureLocked = false;
    document.getElementById('standard-controls').style.display = 'none';
    document.getElementById('placement-controls').style.display = 'block';

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
    if (!marker || !marker.visible) {
      if (!this.xr.xrSession) {
        this.log("<span style='color:#f39c12'>Använder standardavstånd.</span>");
      } else {
        return;
      }
    }

    this.xr.placeMode = false;
    this.xr.figureLocked = true;

    if (this.scene.taserGroup && marker && marker.visible) {
      this.scene.taserGroup.position.copy(marker.position);
      this.scene.taserGroup.visible = true;
      this.scene.taserGroup.userData.startPos = this.scene.taserGroup.position.clone();
    }

    this.scene.set3DVisibility(true);
    if (marker) marker.visible = false;

    const hint = document.getElementById('place-hint');
    if (hint) hint.classList.remove('visible');

    document.getElementById('standard-controls').style.display = 'block';
    document.getElementById('placement-controls').style.display = 'none';

    this.log("<span style='color:#2ecc71'><b>🔒 Figuren är fastlåst!</b> Redo för insats.</span>");
    this.startThreatEscalation();
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
          this.log("<span style='color:#f39c12'>Sätt i batteri för att använda kammare.</span>");
          return;
        }
        if (this.fsm.isSafe) {
          this.log("<span style='color:#f39c12'>Vapnet är säkrat. Osäkra vapnet för att byta kammare med tilt.</span>");
          return;
        }
        if (this.fsm.chamber1 === ChamberState.EMPTY) {
          this.log("<span style='color:#f39c12'>Ladda kassetter för att byta kammare med tilt.</span>");
          return;
        }

        const switched = this.fsm.tiltWeapon();
        if (switched) {
          if (navigator.vibrate) {
            try { navigator.vibrate(40); } catch (e) {}
          }
          this.log(`📱 <span style='color:#3498db; font-weight:bold;'>GYRO-TILT (${direction.toUpperCase()} ${Math.round(gamma)}°):</span> Växlar till kammare ${this.fsm.activeChamber} (${this.fsm.activeChamber === 1 ? '12°' : '3.5°'})!`);
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
        this.log("<span style='color:#bdc3c7'>Enheten saknar hårdvarugyroskop. Använd '🔄 Tilt (Z/X)' knapparna.</span>");
      }
    });
  }

  toggleInvertMouse() {
    this.invertMouseY = !this.invertMouseY;
    this.log(`Inverterad mus/pekare: ${this.invertMouseY ? 'PÅ' : 'AV'}`);
  }

  resetSimulator() {
    this.audio.init();
    this.fsm.reset();
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
      const activeCamera = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : camera;

      // Skeletal Animation update & Threat Escalation movement
      const delta = Math.min(this.scene.clock.getDelta(), 0.1);
      this.scene.update(delta);

      const currentThreat = (typeof window !== 'undefined' && typeof window.threatLevel === 'number')
        ? window.threatLevel
        : this.threatLevel;

      if (currentThreat >= 3 && !this.scene.figureFallen && this.scene.taserGroup && this.scene.taserGroup.visible) {
        if (this.scene.activeAction !== this.scene.actions['Walk']) {
          this.scene.setAnimation('Walk', 0.5);
        }

        // Advance target slowly towards camera along Z-axis in non-XR mode
        if (!renderer.xr.isPresenting) {
          const minDistance = 1.1; // minimum standoff in meters
          const currentDist = (this.scene.taserGroup.userData.startPos ? this.scene.taserGroup.userData.startPos.z : 0) + 3.0 - this.scene.taserGroup.position.z;
          if (currentDist > minDistance) {
            // Modulate velocity by walk action weight to prevent foot sliding during weight transfer
            const walkWeight = (this.scene.actions['Walk'] && this.scene.activeAction === this.scene.actions['Walk'])
              ? this.scene.actions['Walk'].getEffectiveWeight()
              : 0;
            this.scene.taserGroup.position.z += this.scene.walkSpeed * walkWeight * delta;
            this.currentDistance = Math.max(minDistance, 3.0 - this.scene.taserGroup.position.z);
            this.updateAimVisuals();
          }
        }
      } else if (currentThreat < 3 && !this.scene.figureFallen) {
        if (this.scene.activeAction === this.scene.actions['Walk']) {
          this.scene.setAnimation('Idle', 0.5);
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
            this.currentDistance = Math.max(0.5, rawDist);
            this.updateAimVisuals();
          }
        }
      if (renderer.xr.isPresenting) {
        this.scene.scene.background = null;
      } else {
        // Desktop / Mobile Non-XR Perspective Viewport Orbit
        const isARActive = this.xr.useCamera || document.body.classList.contains('ar-active') || document.body.classList.contains('webxr-mode');
        this.scene.scene.background = isARActive ? null : this.scene.defaultBackground;

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
        const activeAimY = this.invertMouseY ? 100 - this.aimY : this.aimY;
        const panY = (activeAimY - 50) * 0.015 * this.currentDistance;

        lookTarget.y += panY;
        lookTarget.x -= panX;
        camera.lookAt(lookTarget);
      }

      // Dynamic Wire updates
      this.scene.updateWireDynamics(activeCamera);

      // Render the scene
      renderer.render(this.scene.scene, activeCamera);
    });
  }
}

// Auto-bootstrap on DOMContentLoaded
window.addEventListener('DOMContentLoaded', () => {
  new TaserApp();
});
