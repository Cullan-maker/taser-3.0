/**
 * TASER 7 WebXR, Gyroscope & AR Manager
 * Handles immersive-ar sessions, floor hit-tests, scenario behavior, and mobile sensors.
 */

import * as THREE from 'three';

export class TaserXR {
  constructor(taserScene, callbacks = {}) {
    this.taserScene = taserScene;
    this.callbacks = callbacks;

    this.xrSession = null;
    this.xrHitTestSource = null;
    this.xrRefSpace = null;
    this.hitTestSourceRequested = false;

    this.scenario = 'static'; // 'static', 'moving', 'charging'
    this.placeMode = false;
    this.figureLocked = true;

    // Camera video feed fallback
    this.useCamera = false;
    this.videoStream = null;

    // Mobile Gyroscope aim & tilt
    this.gyroEnabled = false;
    this.calibAlpha = null;
    this.calibBeta = null;
    this.lastTiltTime = 0;
    this.tiltState = 'neutral'; // 'neutral' | 'left' | 'right'

    // Pre-cache WebXR immersive-ar support asynchronously to avoid blocking gesture turn
    this.xrSupported = null;
    if (this.isWebXRSupported() && typeof navigator.xr.isSessionSupported === 'function') {
      navigator.xr.isSessionSupported('immersive-ar')
        .then((supported) => {
          this.xrSupported = supported;
        })
        .catch(() => {
          this.xrSupported = false;
        });
    }
  }

  isWebXRSupported() {
    return typeof navigator !== 'undefined' && 'xr' in navigator;
  }

  async checkXRSupport() {
    if (!this.isWebXRSupported()) return false;
    if (this.xrSupported !== null) return this.xrSupported;
    try {
      this.xrSupported = await navigator.xr.isSessionSupported('immersive-ar');
      return this.xrSupported;
    } catch (e) {
      this.xrSupported = false;
      return false;
    }
  }

  async startXR(scenario = 'static') {
    this.scenario = scenario;
    if (!this.isWebXRSupported()) {
      const err = new Error('WebXR stöds inte i denna webbläsare (navigator.xr saknas).');
      console.error('[WEBXR ERROR]', err);
      throw err;
    }

    if (this.xrSupported === false) {
      const err = new Error('WebXR Immersive-AR stöds inte på denna enhet eller i denna webbläsare.');
      console.error('[WEBXR ERROR]', err);
      throw err;
    }

    // Release camera stream synchronously if held by WebRTC to prevent camera HAL hardware conflict
    if (this.useCamera && this.videoStream) {
      console.log('[WEBXR PREP] Frigör WebRTC-kameran synkront inför WebXR...');
      try {
        this.videoStream.getTracks().forEach((track) => track.stop());
      } catch (e) {}
      this.videoStream = null;
      this.useCamera = false;
    }

    // End existing session synchronously if active without delay
    if (this.xrSession) {
      try {
        this.xrSession.end();
      } catch (e) {}
      this.xrSession = null;
    }

    // Immediately invoke navigator.xr.requestSession within active transient user activation context
    try {
      const session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'camera-access', 'local-floor', 'local'],
        domOverlay: { root: document.body }
      });

      this.xrSession = session;
      this.hitTestSourceRequested = false;

      // Ensure Three.js WebGL context is transparent and clearColor is 0x000000 with alpha 0
      if (this.taserScene) {
        this.taserScene.enableARMode();
      }

      const renderer = this.taserScene.renderer;
      renderer.xr.enabled = true;
      try {
        renderer.xr.setReferenceSpaceType('local-floor');
      } catch (e) {
        try {
          renderer.xr.setReferenceSpaceType('local');
        } catch (e2) {}
      }
      await renderer.xr.setSession(session);

      session.addEventListener('end', this.onSessionEnded.bind(this));

      if (typeof this.callbacks.onSessionStart === 'function') {
        this.callbacks.onSessionStart(session, this.scenario);
      }

      console.log('[WEBXR] Immersive-AR session startad framgångsrikt i scenario:', this.scenario);
      return session;
    } catch (err) {
      console.error('[WEBXR ERROR] Misslyckades att initiera WebXR-session:', err);
      throw err;
    }
  }

  async endXRSession() {
    if (this.xrSession) {
      try {
        await this.xrSession.end();
      } catch (err) {
        console.warn('[WEBXR WARNING] Fel vid avslutande av XR-session:', err);
      }
    }
  }

  onSessionEnded() {
    this.xrSession = null;
    this.hitTestSourceRequested = false;
    this.xrHitTestSource = null;
    this.xrRefSpace = null;

    if (this.taserScene) {
      this.taserScene.disableARMode();
    }

    const renderer = this.taserScene.renderer;
    if (renderer) {
      renderer.xr.setSession(null);
      renderer.xr.enabled = false;
    }

    if (typeof this.callbacks.onSessionEnd === 'function') {
      this.callbacks.onSessionEnd();
    }
  }

  handleXRFrame(timestamp, frame, activeCamera) {
    if (!this.xrSession || !frame) return;

    const referenceSpace = this.taserScene.renderer.xr.getReferenceSpace();

    // Hit-testing for floor placement
    if (this.placeMode) {
      if (!this.hitTestSourceRequested) {
        this.xrSession.requestReferenceSpace('viewer').then((viewerSpace) => {
          this.xrSession.requestHitTestSource({ space: viewerSpace }).then((source) => {
            this.xrHitTestSource = source;
          });
        });
        this.hitTestSourceRequested = true;
      }

      if (this.xrHitTestSource) {
        const hitTestResults = frame.getHitTestResults(this.xrHitTestSource);
        if (hitTestResults.length > 0) {
          const hit = hitTestResults[0];
          const pose = hit.getPose(referenceSpace);
          if (pose && this.taserScene.placementMarker) {
            this.taserScene.placementMarker.visible = true;
            this.taserScene.placementMarker.position.set(
              pose.transform.position.x,
              pose.transform.position.y + 0.01,
              pose.transform.position.z
            );
          }
        } else if (this.taserScene.placementMarker) {
          this.taserScene.placementMarker.visible = false;
        }
      }
    }

    // Live Target Dynamic Scenarios
    const target = this.taserScene.taserGroup;
    if (target && target.visible && !this.taserScene.figureFallen) {
      if (this.scenario === 'moving') {
        const startX = target.userData.startPos ? target.userData.startPos.x : 0;
        target.position.x = startX + Math.sin(timestamp * 0.001) * 1.2;
        this.taserScene.setAnimation('Walk', 0.8);
      } else if (this.scenario === 'charging') {
        this.taserScene.setAnimation('Walk', 0.8);
        const dir = this.taserScene._v1.subVectors(activeCamera.position, target.position);
        dir.y = 0;
        if (dir.length() > 1.2) {
          dir.normalize();
          const walkWeight = (this.taserScene.actions && this.taserScene.actions['Walk'])
            ? this.taserScene.actions['Walk'].getEffectiveWeight()
            : 1.0;
          target.position.addScaledVector(dir, 0.014 * walkWeight);
        }
      }
    }
  }

  // --- Fallback Camera AR (WebRTC Mixed Reality) ---
  async toggleCameraAR(videoElement, viewportElement) {
    // If WebXR is running, end it first and allow mobile camera HAL to unbind
    if (this.xrSession) {
      console.log('[CAMERA PREP] Avslutar pågående WebXR-session före kameraåtkomst...');
      await this.endXRSession();
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!this.useCamera) {
      let stream = null;
      this.isSimulatedCamera = false;

      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          console.log('[CAMERA] Begär åtkomst till bakre miljö-kamera...');
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 }
            },
            audio: false
          });
        } catch (errEnv) {
          console.warn('[CAMERA WARNING] Bakre kamera nekades, försöker med generell videokamera:', errEnv);
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          } catch (errAny) {
            console.warn('[CAMERA INFO] Fysisk kamerabehörighet nekades eller blockeras av webbläsarens säkerhetspolicy (t.ex. iframe). Startar simulerad AI-kameraström.');
            this.isSimulatedCamera = true;
            stream = this.createSyntheticCameraStream();
          }
        }
      } else {
        console.warn('[CAMERA INFO] navigator.mediaDevices saknas i denna miljö. Startar simulerad AI-kameraström.');
        this.isSimulatedCamera = true;
        stream = this.createSyntheticCameraStream();
      }

      this.videoStream = stream;
      if (stream) {
        videoElement.srcObject = stream;
      }
      videoElement.style.display = 'block';

      // Robustly await video playback and first valid frame buffer
      await new Promise((resolve) => {
        let resolved = false;
        const checkReady = () => {
          if (resolved) return;
          if (videoElement.readyState >= 2 && videoElement.videoWidth > 0) {
            resolved = true;
            videoElement.removeEventListener('loadeddata', checkReady);
            videoElement.removeEventListener('playing', checkReady);
            resolve();
          }
        };

        videoElement.addEventListener('loadeddata', checkReady);
        videoElement.addEventListener('playing', checkReady);

        videoElement.play().then(checkReady).catch((playErr) => {
          console.warn('[CAMERA WARNING] video.play() väntar på användarinteraktion:', playErr);
        });

        // Safety fallback after 1.5s to not block execution indefinitely
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, 1500);
      });

      viewportElement.style.backgroundColor = 'transparent';
      this.useCamera = true;
      this.taserScene.set3DVisibility(false);
      const camType = this.isSimulatedCamera ? 'Simulerad AI-kamera' : 'Fysisk kamera';
      console.log(`[CAMERA] ${camType} aktiv (${videoElement.videoWidth || 640}x${videoElement.videoHeight || 480}) med transparent 3D-overlay.`);
      return true;
    } else {
      if (this.videoStream) {
        if (typeof this.videoStream._cleanup === 'function') {
          this.videoStream._cleanup();
        }
        if (this.videoStream.getTracks) {
          this.videoStream.getTracks().forEach((track) => track.stop());
        }
        this.videoStream = null;
      }
      videoElement.style.display = 'none';
      viewportElement.style.backgroundColor = '#0a0a0a';
      this.useCamera = false;
      this.isSimulatedCamera = false;
      this.taserScene.set3DVisibility(true);
      console.log('[CAMERA] Kamera avstängd. Återställt 3D-scen.');
      return false;
    }
  }

  createSyntheticCameraStream(width = 640, height = 480) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    let frame = 0;
    const draw = () => {
      frame++;
      // Dark tactical camera view
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, width, height);

      // Grid
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1;
      for (let x = 0; x < width; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      }
      for (let y = 0; y < height; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      }

      const t = frame * 0.04;
      const cx = width / 2 + Math.sin(t) * 20;
      const cy = height / 2 + 10;

      // Humanoid silhouette with natural skin/clothing contrast
      ctx.fillStyle = '#e2b170'; // Head
      ctx.beginPath();
      ctx.arc(cx, cy - 110, 24, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#334155'; // Torso jacket
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(cx - 32, cy - 82, 64, 88, 8);
      } else {
        ctx.rect(cx - 32, cy - 82, 64, 88);
      }
      ctx.fill();

      // Arms & Legs
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 12;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - 32, cy - 70); ctx.lineTo(cx - 50, cy - 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 32, cy - 70); ctx.lineTo(cx + 50, cy - 10); ctx.stroke();

      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 14;
      ctx.beginPath(); ctx.moveTo(cx - 16, cy + 6); ctx.lineTo(cx - 20, cy + 120); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 16, cy + 6); ctx.lineTo(cx + 20, cy + 120); ctx.stroke();

      // Watermark HUD
      ctx.fillStyle = '#2ecc71';
      ctx.font = 'bold 12px monospace';
      ctx.fillText('● LIVE AI KAMERA (SIMULERAD TESTPERSON)', 16, 26);
    };

    const interval = setInterval(draw, 33);
    draw();

    try {
      if (typeof canvas.captureStream === 'function') {
        const stream = canvas.captureStream(30);
        stream._cleanup = () => clearInterval(interval);
        return stream;
      }
    } catch (e) {
      console.warn('[CAMERA] canvas.captureStream ej tillgänglig:', e);
    }
    return null;
  }

  // --- Gyroscope Orientation & Tilt ---
  async initGyro(onOrientationChange, onPhysicalTilt) {
    if (this.gyroEnabled) {
      this.recalibrateGyro();
      return { success: true, alreadyEnabled: true };
    }

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission === 'granted') {
          this.enableGyro(onOrientationChange, onPhysicalTilt);
          return { success: true, permission: 'granted' };
        } else {
          return { success: false, permission: 'denied' };
        }
      } catch (e) {
        console.warn('[TaserXR] Gyro permission request error:', e);
        return { success: false, error: e };
      }
    } else if (typeof window !== 'undefined' && 'DeviceOrientationEvent' in window) {
      // Standard Android Chrome / mobile browser without permission barrier
      this.enableGyro(onOrientationChange, onPhysicalTilt);
      return { success: true, permission: 'granted' };
    } else {
      return { success: false, permission: 'unsupported' };
    }
  }

  recalibrateGyro() {
    this.calibAlpha = null;
    this.calibBeta = null;
    this.tiltState = 'neutral';
  }

  enableGyro(onOrientationChange, onPhysicalTilt) {
    if (this.gyroEnabled) return;
    this.calibAlpha = null;
    this.calibBeta = null;
    this.lastTiltTime = 0;
    this.tiltState = 'neutral';
    this.gyroEnabled = true;

    // Tactical Constants for Snärt / Wrist Tilt (TASER 7 Tilt Select)
    // Snärt med handleden når normalt 30-45 graders lutning (gamma) under 100-250ms
    const TILT_ANGLE_THRESHOLD = 32; // 32 graders vinkel för direkt tilt
    const NEUTRAL_RESET_THRESHOLD = 16; // Återgå till < 16 grader för att nollställa tillståndet
    const COOLDOWN_MS = 380; // 380ms cooldown för att förhindra studs

    let lastGamma = null;
    let lastGammaTime = 0;

    const handleOrientation = (event) => {
      // 1. NaN and Undefined Sanitizer
      const rawAlpha = typeof event.alpha === 'number' && !isNaN(event.alpha) ? event.alpha : null;
      const rawBeta = typeof event.beta === 'number' && !isNaN(event.beta) ? event.beta : null;
      const rawGamma = typeof event.gamma === 'number' && !isNaN(event.gamma) ? event.gamma : null;

      // 2. Physical Tilt Detection (Gamma axis = Roll i porträttläge)
      if (rawGamma !== null && typeof onPhysicalTilt === 'function') {
        const now = Date.now();
        const absGamma = Math.abs(rawGamma);
        const dt = lastGammaTime > 0 ? (now - lastGammaTime) / 1000 : 0.016;
        const angularVelocity = (lastGamma !== null && dt > 0.005) ? Math.abs(rawGamma - lastGamma) / dt : 0;

        lastGamma = rawGamma;
        lastGammaTime = now;

        // Snärt-detektering:
        // Antingen vinkling över 32 grader ELLER snabb snärt (vinkelhastighet > 80 deg/s och vinkel > 20 deg)
        const isFlick = (absGamma >= TILT_ANGLE_THRESHOLD) || (angularVelocity > 80 && absGamma >= 20);

        if (this.tiltState === 'neutral') {
          if (isFlick && (now - this.lastTiltTime > COOLDOWN_MS)) {
            const currentDir = rawGamma > 0 ? 'right' : 'left';
            this.tiltState = currentDir;
            this.lastTiltTime = now;
            onPhysicalTilt(currentDir, rawGamma);
          }
        } else {
          // Enheten har återgått till upprätt läge (< 16 grader): nollställ så nästa snärt kan registreras
          if (absGamma < NEUTRAL_RESET_THRESHOLD) {
            this.tiltState = 'neutral';
          }
        }
      }

      // 3. Sighting / Aim Tracking (Alpha & Beta)
      if (this.xrSession || rawAlpha === null || rawBeta === null) return;

      if (this.calibAlpha === null || this.calibBeta === null) {
        this.calibAlpha = rawAlpha;
        this.calibBeta = rawBeta;
      }

      let deltaX = rawAlpha - this.calibAlpha;
      if (deltaX > 180) deltaX -= 360;
      if (deltaX < -180) deltaX += 360;
      const deltaY = rawBeta - this.calibBeta;

      let aimX = 50 + deltaX * -1.0;
      let aimY = 50 + deltaY * -1.5;

      // NaN Sanitizer for viewport aim coordinates
      if (isNaN(aimX) || !isFinite(aimX)) aimX = 50;
      if (isNaN(aimY) || !isFinite(aimY)) aimY = 50;

      aimX = Math.max(10, Math.min(90, aimX));
      aimY = Math.max(10, Math.min(90, aimY));

      if (typeof onOrientationChange === 'function') {
        onOrientationChange(aimX, aimY);
      }
    };

    window.addEventListener('deviceorientation', handleOrientation);

    // Sekundär snärt-avkänning via devicemotion för omedelbar respons vid snabb handledssnärt
    if (typeof window !== 'undefined' && 'ondevicemotion' in window) {
      window.addEventListener('devicemotion', (e) => {
        if (!e.rotationRate || typeof onPhysicalTilt !== 'function') return;
        const rot = e.rotationRate;
        // Kraftig rotationssnärt runt telefonens längsgående axel
        const rate = Math.abs(rot.gamma || 0) + Math.abs(rot.alpha || 0);
        if (rate > 150 && this.tiltState === 'neutral') {
          const now = Date.now();
          if (now - this.lastTiltTime > COOLDOWN_MS) {
            const dir = (rot.gamma || 0) >= 0 ? 'right' : 'left';
            this.tiltState = dir;
            this.lastTiltTime = now;
            onPhysicalTilt(dir, lastGamma || 35);
          }
        }
      }, { passive: true });
    }
  }
}
