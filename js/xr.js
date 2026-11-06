/**
 * TASER 7 WebXR, Gyroscope & AR Manager
 * Handles immersive-ar sessions, floor hit-tests, scenario behavior, and mobile sensors.
 */

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
  }

  isWebXRSupported() {
    return typeof navigator !== 'undefined' && 'xr' in navigator;
  }

  async checkXRSupport() {
    if (!this.isWebXRSupported()) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-ar');
    } catch (e) {
      return false;
    }
  }

  async startXR(scenario = 'static') {
    this.scenario = scenario;
    if (!this.isWebXRSupported()) {
      throw new Error('WebXR stöds inte i denna webbläsare.');
    }

    const isSupported = await this.checkXRSupport();
    if (!isSupported) {
      throw new Error('WebXR Immersive-AR stöds inte på denna enhet.');
    }

    if (this.xrSession) {
      await this.endXRSession();
    }

    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: document.body }
    });

    this.xrSession = session;
    this.hitTestSourceRequested = false;

    const renderer = this.taserScene.renderer;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);

    session.addEventListener('end', this.onSessionEnded.bind(this));

    if (typeof this.callbacks.onSessionStart === 'function') {
      this.callbacks.onSessionStart(session, this.scenario);
    }

    return session;
  }

  async endXRSession() {
    if (this.xrSession) {
      await this.xrSession.end();
    }
  }

  onSessionEnded() {
    this.xrSession = null;
    this.hitTestSourceRequested = false;
    this.xrHitTestSource = null;
    this.xrRefSpace = null;

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
      } else if (this.scenario === 'charging') {
        const dir = new THREE.Vector3().subVectors(activeCamera.position, target.position);
        dir.y = 0;
        if (dir.length() > 1.5) {
          dir.normalize();
          target.position.addScaledVector(dir, 0.015);
        }
      }
    }
  }

  // --- Fallback Camera AR (WebRTC) ---
  async toggleCameraAR(videoElement, viewportElement) {
    if (this.xrSession) {
      await this.endXRSession();
    }

    if (!this.useCamera) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Kamera stöds ej (Kräver säker HTTPS-anslutning).');
      }

      let stream = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' }
        });
      } catch (err) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }

      this.videoStream = stream;
      videoElement.srcObject = stream;
      videoElement.style.display = 'block';
      videoElement.play().catch(() => {});

      viewportElement.style.backgroundColor = 'transparent';
      this.useCamera = true;
      this.taserScene.set3DVisibility(false);
      return true;
    } else {
      if (this.videoStream) {
        this.videoStream.getTracks().forEach((track) => track.stop());
        this.videoStream = null;
      }
      videoElement.style.display = 'none';
      viewportElement.style.backgroundColor = '#0a0a0a';
      this.useCamera = false;
      this.taserScene.set3DVisibility(true);
      return false;
    }
  }

  // --- Gyroscope Orientation & Tilt ---
  async initGyro(onOrientationChange, onPhysicalTilt) {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission === 'granted') {
          this.enableGyro(onOrientationChange, onPhysicalTilt);
          return true;
        }
      } catch (e) {
        console.warn('Gyro permission request error:', e);
      }
      return false;
    } else {
      this.enableGyro(onOrientationChange, onPhysicalTilt);
      return true;
    }
  }

  enableGyro(onOrientationChange, onPhysicalTilt) {
    if (this.gyroEnabled) return;
    this.calibAlpha = null;
    this.calibBeta = null;
    this.gyroEnabled = true;

    window.addEventListener('deviceorientation', (event) => {
      // Physical tilt detection (>50 deg or <-50 deg gamma)
      if (event.gamma && typeof onPhysicalTilt === 'function') {
        const now = Date.now();
        if (now - this.lastTiltTime > 1000) {
          if (event.gamma > 50 || event.gamma < -50) {
            this.lastTiltTime = now;
            onPhysicalTilt(event.gamma);
          }
        }
      }

      if (this.xrSession || !event.alpha) return;

      const alpha = event.alpha;
      const beta = event.beta;
      if (this.calibAlpha === null || this.calibBeta === null) {
        this.calibAlpha = alpha;
        this.calibBeta = beta;
      }

      let deltaX = alpha - this.calibAlpha;
      if (deltaX > 180) deltaX -= 360;
      if (deltaX < -180) deltaX += 360;
      const deltaY = beta - this.calibBeta;

      let aimX = 50 + deltaX * -1.0;
      let aimY = 50 + deltaY * -1.5;

      if (isNaN(aimX)) aimX = 50;
      if (isNaN(aimY)) aimY = 50;

      aimX = Math.max(10, Math.min(90, aimX));
      aimY = Math.max(10, Math.min(90, aimY));

      if (typeof onOrientationChange === 'function') {
        onOrientationChange(aimX, aimY);
      }
    });
  }
}
