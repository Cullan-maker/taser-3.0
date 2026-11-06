/**
 * TASER 7 Elite Tactical Simulator - Main Application Coordinator
 * High-performance mobile portrait layout, WebXR, Three.js, Media Session API & PWA.
 */

import { TaserFSM, ChamberState } from './fsm.js';
import { TaserAudio } from './audio.js';
import { TaserBallistics } from './ballistics.js';
import { TaserScene } from './scene.js';
import { TaserXR } from './xr.js';
import { TaserPWA } from './pwa.js';

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

    // Aim and Tracking State
    this.currentDistance = 3.0; // meters
    this.aimX = 50; // percentage
    this.aimY = 50; // percentage
    this.invertMouseY = false;

    // Threat escalation
    this.threatLevel = 0;
    this.threatInterval = null;
    this.nmiTimer = null;

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
    window.toggleBattery = () => this.fsm.toggleBattery();
    window.toggleCassette = () => this.fsm.toggleCassette();
    window.toggleSafety = () => this.fsm.toggleSafety();
    window.tiltWeapon = () => this.fsm.tiltWeapon();
    window.activateStealth = () => this.fsm.activateStealth();
    window.toggleClothing = () => this.fsm.toggleClothing();
    window.pressSingleWarning = () => this.fsm.pressSingleWarning();
    window.pressDualWarning = () => this.fsm.pressDualWarning();
    window.pressTrigger = () => this.handleTrigger();
    window.performKontaktstot = () => this.fsm.performKontaktstot();
    window.resetSimulator = () => this.resetSimulator();

    window.toggleCamera = () => this.toggleCameraAR();
    window.openScenarioModal = () => this.openModal('scenario-modal');
    window.startXR = (type) => this.startWebXR(type);
    window.togglePlaceMode = () => this.togglePlaceMode();
    window.confirmPlacement = () => this.confirmPlacement();
    window.initGyro = () => this.initGyro();
    window.toggleInvertMouse = () => this.toggleInvertMouse();
    window.openModal = (id) => this.openModal(id);
    window.closeModal = (id) => this.closeModal(id);
    window.promptInstall = () => this.pwa.promptInstall();
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
        this.scene.resetTarget();
        this.updateDisplay();
        this.startThreatEscalation();
      }
    });
  }

  initInputs() {
    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (e.code === 'Space') {
        e.preventDefault();
        this.handleTrigger();
      } else if (k === 'c' || e.key === 'Shift') {
        e.preventDefault();
        this.fsm.pressSingleWarning();
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
        this.scene.placementRaycaster.setFromCamera(new THREE.Vector2(x, y), this.scene.camera);
        const hits = this.scene.placementRaycaster.intersectObject(this.scene.placementGround, true);
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

  startThreatEscalation() {
    this.threatLevel = 0;
    if (this.scene.knifeMesh) this.scene.knifeMesh.visible = false;
    if (this.threatInterval) clearInterval(this.threatInterval);

    const tLabel = document.getElementById('target-label');
    if (tLabel) {
      tLabel.textContent = 'PERSON (3D)';
      tLabel.classList.remove('armed');
    }

    this.threatInterval = setInterval(() => {
      if (this.scene.figureFallen || !this.scene.taserGroup || !this.scene.taserGroup.visible) return;

      this.threatLevel++;
      if (this.threatLevel === 1) {
        this.suspectSpeak('Vad fan glor du på?! Backa!');
      } else if (this.threatLevel === 2) {
        this.suspectSpeak('Rör mig inte sa jag! Stick!');
      } else if (this.threatLevel === 3) {
        this.suspectSpeak('Jag sprättar dig! Jag svär!');
        if (this.scene.knifeMesh) this.scene.knifeMesh.visible = true;
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

  toggleCameraAR() {
    const cameraFeed = document.getElementById('camera-feed');
    const btnCamera = document.getElementById('btn-camera');
    const viewport = document.getElementById('viewport');
    const tLabel = document.getElementById('target-label');

    this.xr.toggleCameraAR(cameraFeed, viewport).then((isActive) => {
      if (isActive) {
        btnCamera.innerHTML = '📷 Avbryt AR';
        btnCamera.classList.add('active-cam');
        if (tLabel) tLabel.textContent = 'PERSON (LIVE)';
        this.log("<span style='color:#f1c40f'>Kamera AR aktiverad. 3D-figur dold.</span>");
      } else {
        btnCamera.innerHTML = '📷 Kamera (AR)';
        btnCamera.classList.remove('active-cam');
        if (tLabel) tLabel.textContent = 'PERSON (3D)';
        this.log('Återgått till mörk bakgrund. 3D-figur synlig.');
        this.startThreatEscalation();
      }
    }).catch((err) => {
      this.log(`<span style='color:red'>${err.message}</span>`);
    });
  }

  startWebXR(type) {
    this.closeModal('scenario-modal');
    this.xr.startXR(type).catch((err) => {
      this.log(`<span style='color:red'>WebXR fel: ${err.message}</span>`);
    });
  }

  onXRSessionStart(session, scenario) {
    document.body.classList.add('webxr-mode');
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

  onSessionEnd() {
    document.body.classList.remove('webxr-mode');
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

  initGyro() {
    this.audio.init();
    this.xr.initGyro(
      (aimX, aimY) => {
        this.aimX = aimX;
        this.aimY = aimY;
        this.updateAimVisuals();
      },
      (gamma) => {
        if (!this.fsm.isSafe && this.fsm.hasBattery) {
          this.fsm.tiltWeapon();
        }
      }
    ).then((granted) => {
      if (granted) {
        this.log('Rörelsesensor aktiverad!');
        const btn = document.getElementById('btn-gyro');
        if (btn) btn.style.display = 'none';
      } else {
        this.log('Kunde inte starta rörelsesensor.');
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
      } else {
        // Desktop / Mobile Non-XR Perspective Viewport Orbit
        if (this.xr.useCamera) {
          this.scene.scene.background = null;
        } else {
          this.scene.scene.background = new THREE.Color(0x0a0a0a);
        }

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
