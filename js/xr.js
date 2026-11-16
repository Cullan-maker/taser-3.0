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
    this.isPlacing = false;
    this.placeMode = false;
    this.figureLocked = true;
    this.targetPausedUntil = 0;
    this.targetSurrendered = false;

    // Camera video feed fallback
    this.useCamera = false;
    this.videoStream = null;

    // Mobile Gyroscope aim & tilt
    this.gyroEnabled = false;
    this.calibAlpha = null;
    this.calibBeta = null;
    this.lastTiltTime = 0;
    this.tiltState = 'neutral'; // 'neutral' | 'left' | 'right'
    this.onPhysicalTilt = null;
    this.onContinuousTilt = null;
    this._hasMotionAccel = false;
    this._xrRightVec = new THREE.Vector3();
    this.latestEnvHit = null;
    this._envHitPos = new THREE.Vector3();
    this._envHitNormal = new THREE.Vector3();
    this._envHitQuat = new THREE.Quaternion();

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
    this.resetScenarioState();
    if (!this.isWebXRSupported() || this.xrSupported === false) {
      console.info('[WEBXR INFO] WebXR Immersive-AR stöds inte på denna enhet eller i denna webbläsare. Växlar till simulerat AR-scenario.');
      return { success: false, fallback: true, scenario, reason: 'not-supported' };
    }

    // Stop Live AI pose tracking and clear Live-AR classes when starting WebXR 3D-dummy mode
    if (this.taserScene && this.taserScene.aiPose && this.taserScene.aiPose.isActive) {
      try {
        this.taserScene.aiPose.stop();
      } catch (e) {}
    }
    if (typeof document !== 'undefined') {
      document.body.classList.remove('live-ai-active', 'live-ar-active', 'camera-active');
      document.documentElement.classList.remove('live-ai-active', 'live-ar-active', 'camera-active');
      const mc = document.getElementById('main-container');
      if (mc) mc.classList.remove('live-ar-active');
      const sc = document.querySelector('.sim-controls');
      if (sc) sc.classList.remove('live-ar-active');
      const liveTargetEl = document.getElementById('live-target-overlay');
      if (liveTargetEl) liveTargetEl.style.display = 'none';
    }

    // Release camera stream synchronously if held by WebRTC to prevent camera HAL hardware conflict
    if (typeof window !== 'undefined' && typeof window.stopCameraPassThrough === 'function') {
      try {
        window.stopCameraPassThrough();
      } catch (e) {}
    }
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
      this.latestEnvHit = null;

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
      return { success: true, session, scenario: this.scenario };
    } catch (err) {
      console.warn('[WEBXR NOTICE] Misslyckades att initiera WebXR-session, växlar till simulerat AR:', err.message);
      return { success: false, fallback: true, scenario: this.scenario, error: err };
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
    this.latestEnvHit = null;
    this.isPlacing = false;
    this.placeMode = false;

    if (this.taserScene) {
      if (this.taserScene.placementMarker) {
        this.taserScene.placementMarker.visible = false;
      }
      if (this.taserScene.reticle) {
        this.taserScene.reticle.visible = false;
      }
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

    // Begär WebXR hit-test source en gång per session så att både placering och verkliga rumsytor (vägg/golv/möbler) kan träffas
    if (!this.hitTestSourceRequested) {
      this.hitTestSourceRequested = true;
      this.hasHitTestPose = false;
      this.xrSession.requestReferenceSpace('viewer').then((viewerSpace) => {
        return this.xrSession.requestHitTestSource({ space: viewerSpace });
      }).then((source) => {
        this.xrHitTestSource = source;
      }).catch((err) => {
        console.warn('[WEBXR HIT-TEST] Kunde inte begära hit-test source:', err);
        this.hitTestSourceRequested = false;
      });
    }

    let hitPose = null;
    if (this.xrHitTestSource && referenceSpace) {
      const hitTestResults = frame.getHitTestResults(this.xrHitTestSource);
      if (hitTestResults.length > 0) {
        hitPose = hitTestResults[0].getPose(referenceSpace);
        if (hitPose) {
          this.hasHitTestPose = true;
          this._envHitPos.set(
            hitPose.transform.position.x,
            hitPose.transform.position.y,
            hitPose.transform.position.z
          );
          this._envHitQuat.set(
            hitPose.transform.orientation.x,
            hitPose.transform.orientation.y,
            hitPose.transform.orientation.z,
            hitPose.transform.orientation.w
          );
          this._envHitNormal.set(0, 1, 0).applyQuaternion(this._envHitQuat).normalize();
          const hitDist = activeCamera ? activeCamera.position.distanceTo(this._envHitPos) : 3.0;
          this.latestEnvHit = {
            point: this._envHitPos,
            normal: this._envHitNormal,
            distance: hitDist,
            timestamp: typeof performance !== 'undefined' ? performance.now() : Date.now()
          };
        }
      } else if (this.latestEnvHit) {
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (nowMs - this.latestEnvHit.timestamp > 350) {
          this.latestEnvHit = null;
        }
      }
    }

    // Placement reticle visas ENDAST när användaren aktivt placerar/flyttar figuren (isPlacing === true)
    if (this.isPlacing && this.placeMode) {
      if (hitPose && this.taserScene.placementMarker) {
        this.taserScene.placementMarker.visible = true;
        this.taserScene.placementMarker.position.set(
          hitPose.transform.position.x,
          hitPose.transform.position.y + 0.01,
          hitPose.transform.position.z
        );
        this.taserScene.placementMarker.rotation.set(0, 0, 0);
        this.taserScene.placementMarker.quaternion.identity();
        this.taserScene.placementMarker.updateMatrix();
        this.taserScene.placementMarker.updateMatrixWorld(true);
      } else if (this.taserScene.placementMarker && (!this.xrHitTestSource || !this.hasHitTestPose) && activeCamera) {
        // Visa preliminär markör på golvnivå framför kameran tills golvplan detekterats
        const fwd = this.taserScene._v1.set(0, 0, -1).applyQuaternion(activeCamera.quaternion);
        fwd.y = 0;
        if (fwd.lengthSq() < 0.001) fwd.set(0, 0, -1);
        fwd.normalize().multiplyScalar(2.5);
        this.taserScene.placementMarker.visible = true;
        this.taserScene.placementMarker.position.set(
          activeCamera.position.x + fwd.x,
          0.01,
          activeCamera.position.z + fwd.z
        );
        this.taserScene.placementMarker.rotation.set(0, 0, 0);
        this.taserScene.placementMarker.quaternion.identity();
        this.taserScene.placementMarker.updateMatrix();
        this.taserScene.placementMarker.updateMatrixWorld(true);
      }
    } else {
      // Dölj alltid placement reticle helt efter placering
      if (this.taserScene && this.taserScene.placementMarker && this.taserScene.placementMarker.visible) {
        this.taserScene.placementMarker.visible = false;
      }
      if (this.taserScene && this.taserScene.reticle && this.taserScene.reticle.visible) {
        this.taserScene.reticle.visible = false;
      }
    }

    // Live Target Dynamic Scenarios
    const target = this.taserScene.taserGroup;
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const isScenarioHalted = this.targetSurrendered || this.taserScene.isTased || this.taserScene.figureFallen;
    const isScenarioPaused = nowMs < (this.targetPausedUntil || 0);

    if (target && target.visible && !this.taserScene.figureFallen) {
      if (isScenarioHalted || isScenarioPaused) {
        if (this.taserScene.actions && this.taserScene.activeAction === this.taserScene.actions['Walk']) {
          this.taserScene.setAnimation('Idle', 0.35);
        }
      } else if (this.scenario === 'moving') {
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

    // WebXR Physical Phone Tilt/Flick Detection (via camera quaternion roll, helt fri från gimbal-lock)
    if (!this.isPlacing && !this.placeMode && activeCamera && typeof this.onPhysicalTilt === 'function') {
      const rightVec = this._xrRightVec.set(1, 0, 0).applyQuaternion(activeCamera.quaternion);
      const xrRollDeg = THREE.MathUtils.radToDeg(Math.asin(Math.max(-1, Math.min(1, -rightVec.y))));
      const now = Date.now();
      const XR_TILT_THRESHOLD = 40;
      const XR_NEUTRAL_THRESHOLD = 18;
      const XR_COOLDOWN_MS = 600;

      if (Math.abs(xrRollDeg) < XR_NEUTRAL_THRESHOLD) {
        this.tiltState = 'neutral';
      } else if (Math.abs(xrRollDeg) >= XR_TILT_THRESHOLD && (now - this.lastTiltTime > XR_COOLDOWN_MS)) {
        const dir = xrRollDeg > 0 ? 'right' : 'left';
        if (this.tiltState === 'neutral' || this.tiltState !== dir) {
          this.triggerPhysicalTilt(dir, xrRollDeg, now);
        }
      }
    }
  }

  resetScenarioState() {
    this.targetPausedUntil = 0;
    this.targetSurrendered = false;
  }

  pauseScenario(durationMs = 3000) {
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.targetPausedUntil = Math.max(this.targetPausedUntil || 0, nowMs + durationMs);
  }

  surrenderScenario() {
    this.targetSurrendered = true;
    this.targetPausedUntil = 0;
  }

  retreatTarget(meters = 0.75) {
    if (!this.taserScene || !this.taserScene.taserGroup) return false;
    const target = this.taserScene.taserGroup;
    const renderer = this.taserScene.renderer;
    const cam = (renderer && renderer.xr && renderer.xr.isPresenting)
      ? renderer.xr.getCamera(this.taserScene.camera)
      : this.taserScene.camera;
    if (!cam) return false;
    const away = this.taserScene._v1.subVectors(target.position, cam.position);
    away.y = 0;
    if (away.lengthSq() < 0.001) away.set(0, 0, -1);
    away.normalize();
    target.position.addScaledVector(away, meters);
    this.pauseScenario(3200);
    return true;
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
      let stream = (videoElement && videoElement.srcObject && videoElement.srcObject.active)
        ? videoElement.srcObject
        : null;
      this.isSimulatedCamera = false;

      if (!stream) {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          try {
            console.log('[CAMERA] Begär åtkomst till bakre miljö-kamera...');
            stream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: 'environment'
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
      }

      this.videoStream = stream;
      if (stream && videoElement.srcObject !== stream) {
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
        this.videoStream = null;
      }
      viewportElement.style.backgroundColor = 'transparent';
      this.useCamera = false;
      this.isSimulatedCamera = false;
      this.taserScene.set3DVisibility(true);
      console.log('[CAMERA] Live AI avstängd. Återställt 3D-scen.');
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

  triggerPhysicalTilt(dir, angleDeg, now = Date.now()) {
    this.tiltState = dir;
    this.lastTiltTime = now;
    if (typeof this.onPhysicalTilt === 'function') {
      this.onPhysicalTilt(dir, typeof angleDeg === 'number' && !isNaN(angleDeg) ? angleDeg : 0);
    }
  }

  // --- Gyroscope Orientation & Tilt ---
  async initGyro(onOrientationChange, onPhysicalTilt, onContinuousTilt) {
    if (typeof onPhysicalTilt === 'function') {
      this.onPhysicalTilt = onPhysicalTilt;
    }
    if (typeof onContinuousTilt === 'function') {
      this.onContinuousTilt = onContinuousTilt;
    }

    if (this.gyroEnabled) {
      this.recalibrateGyro();
      return { success: true, alreadyEnabled: true };
    }

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permPromises = [DeviceOrientationEvent.requestPermission()];
        if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
          permPromises.push(DeviceMotionEvent.requestPermission().catch(() => 'denied'));
        }
        const [permission] = await Promise.all(permPromises);
        if (permission === 'granted') {
          this.enableGyro(onOrientationChange, onPhysicalTilt, onContinuousTilt);
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
      this.enableGyro(onOrientationChange, onPhysicalTilt, onContinuousTilt);
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

  enableGyro(onOrientationChange, onPhysicalTilt, onContinuousTilt) {
    if (typeof onPhysicalTilt === 'function') {
      this.onPhysicalTilt = onPhysicalTilt;
    }
    if (typeof onContinuousTilt === 'function') {
      this.onContinuousTilt = onContinuousTilt;
    }
    if (this.gyroEnabled) return;
    this.calibAlpha = null;
    this.calibBeta = null;
    this.lastTiltTime = 0;
    this.tiltState = 'neutral';
    this._hasMotionAccel = false;
    this.gyroEnabled = true;

    // Tactical Constants for Snärt / Wrist Tilt (TASER 7 Tilt Select)
    const ACCEL_TILT_THRESHOLD = 42; // Symmetrisk rullvinkel via gravitation (±42°, oberoende av pitch/beta)
    const ACCEL_NEUTRAL_THRESHOLD = 20; // Återställ till neutral när |roll| < 20°
    const ORIENT_TILT_THRESHOLD = 45; // Fallback-vinkel via deviceorientation (±45°)
    const ORIENT_NEUTRAL_THRESHOLD = 22;
    const FLICK_RATE_THRESHOLD = 155; // deg/s vid snabb handledssnärt
    const COOLDOWN_MS = 600; // Debounce som förhindrar dubbeltriggning vid rekyl men tillåter direkt byte tillbaka

    let lastGamma = null;
    let lastGammaTime = 0;

    const handleOrientation = (event) => {
      // 1. NaN and Undefined Sanitizer
      const rawAlpha = typeof event.alpha === 'number' && !isNaN(event.alpha) ? event.alpha : null;
      const rawBeta = typeof event.beta === 'number' && !isNaN(event.beta) ? event.beta : null;
      const rawGamma = typeof event.gamma === 'number' && !isNaN(event.gamma) ? event.gamma : null;

      // Continuous real-time roll fallback if accelerometer isn't supplying gravity roll
      if (!this.xrSession && !this._hasMotionAccel && rawGamma !== null && typeof this.onContinuousTilt === 'function') {
        const absBetaNow = rawBeta !== null ? Math.abs(rawBeta) : 0;
        if (absBetaNow < 88) {
          this.onContinuousTilt(Math.max(-90, Math.min(90, rawGamma)));
        }
      }

      // 2. Physical Tilt Fallback (används endast om WebXR inte är aktivt och devicemotion saknar accelerometer)
      if (!this.xrSession && !this._hasMotionAccel && rawGamma !== null && typeof this.onPhysicalTilt === 'function') {
        const now = Date.now();
        const absGamma = Math.abs(rawGamma);
        const absBeta = rawBeta !== null ? Math.abs(rawBeta) : 0;
        const dt = lastGammaTime > 0 ? (now - lastGammaTime) / 1000 : 0.016;
        const angularVelocity = (lastGamma !== null && dt > 0.005) ? Math.abs(rawGamma - lastGamma) / dt : 0;

        lastGamma = rawGamma;
        lastGammaTime = now;

        if (absGamma < ORIENT_NEUTRAL_THRESHOLD) {
          this.tiltState = 'neutral';
        } else if (absBeta < 87) {
          const isFlick = absGamma >= ORIENT_TILT_THRESHOLD && (angularVelocity > 65 || absGamma >= 55);
          if (isFlick && (now - this.lastTiltTime > COOLDOWN_MS)) {
            const currentDir = rawGamma > 0 ? 'right' : 'left';
            if (this.tiltState === 'neutral' || this.tiltState !== currentDir) {
              this.triggerPhysicalTilt(currentDir, rawGamma, now);
            }
          }
        }
      } else if (rawGamma !== null) {
        lastGamma = rawGamma;
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

    this._orientationHandler = handleOrientation;
    window.addEventListener('deviceorientation', this._orientationHandler);

    // Primär snärt- & lutningsavkänning via devicemotion (gravitationsvektor + pitch-anpassad gyroskop-hastighet)
    if (typeof window !== 'undefined' && ('DeviceMotionEvent' in window || 'ondevicemotion' in window)) {
      this._motionHandler = (e) => {
        if (!this.gyroEnabled || this.xrSession) return;
        const now = Date.now();

        const acc = e.accelerationIncludingGravity;
        let isUpright = false;
        let hasValidGravity = false;

        if (acc && typeof acc.x === 'number' && typeof acc.y === 'number' && typeof acc.z === 'number') {
          const ax = acc.x;
          const ay = acc.y;
          const az = acc.z;
          const gMag = Math.hypot(ax, ay, az);
          if (gMag > 6.0 && gMag < 14.0) {
            this._hasMotionAccel = true;
            hasValidGravity = true;
            isUpright = Math.abs(ay) > Math.abs(az);

            const gravRollDeg = (Math.asin(Math.max(-1, Math.min(1, -ax / gMag))) * 180) / Math.PI;
            if (typeof this.onContinuousTilt === 'function' && isFinite(gravRollDeg)) {
              this.onContinuousTilt(gravRollDeg);
            }

            if (typeof this.onPhysicalTilt === 'function') {
              if (Math.abs(gravRollDeg) < ACCEL_NEUTRAL_THRESHOLD) {
                this.tiltState = 'neutral';
              } else if (Math.abs(gravRollDeg) >= ACCEL_TILT_THRESHOLD && (now - this.lastTiltTime > COOLDOWN_MS)) {
                const dir = gravRollDeg > 0 ? 'right' : 'left';
                if (this.tiltState === 'neutral' || this.tiltState !== dir) {
                  this.triggerPhysicalTilt(dir, gravRollDeg, now);
                  return;
                }
              }
            }
          }
        }

        if (e.rotationRate && typeof this.onPhysicalTilt === 'function') {
          const rotGamma = typeof e.rotationRate.gamma === 'number' && !isNaN(e.rotationRate.gamma) ? e.rotationRate.gamma : 0;
          const rotAlpha = typeof e.rotationRate.alpha === 'number' && !isNaN(e.rotationRate.alpha) ? e.rotationRate.alpha : 0;
          // Vid upprätt grepp sker sidolutning/snärt runt telefonens Z-axel (alpha), vid plant grepp runt Y-axeln (gamma)
          let primaryRate = rotGamma;
          if (hasValidGravity && isUpright) {
            primaryRate = Math.abs(rotAlpha) >= Math.abs(rotGamma) ? -rotAlpha : rotGamma;
          }
          if (Math.abs(primaryRate) >= FLICK_RATE_THRESHOLD && (now - this.lastTiltTime > COOLDOWN_MS)) {
            const dir = primaryRate > 0 ? 'right' : 'left';
            const angleHint = lastGamma !== null ? lastGamma : (dir === 'right' ? 50 : -50);
            this.triggerPhysicalTilt(dir, angleHint, now);
          }
        }
      };
      window.addEventListener('devicemotion', this._motionHandler, { passive: true });
    }
  }
}
