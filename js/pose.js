/**
 * TASER 7 AI-Based Human Pose & Dynamic Hitbox Engine
 * Powered by Google MediaPipe Pose / BlazePose with real-time 2D-to-3D projection,
 * biometrical depth estimation, and non-blocking asynchronous inference loop.
 */

import * as THREE from 'three';

export class TaserAIPose {
  constructor(scene, camera, options = {}) {
    this.scene = scene; // TaserScene
    this.camera = camera; // THREE.PerspectiveCamera
    this.options = options;

    this.videoElement = options.videoElement || document.getElementById('camera-feed-left') || document.getElementById('camera-feed');
    this.isActive = false;
    this.isSimulated = false;
    this.pose = null;
    this.isDetecting = false;
    this.isReady = false;
    this.lastInferenceTime = 0;
    this.inferenceInterval = 35; // ~28 FPS inference, rendering stays at 60 FPS

    // Live tracking metrics
    this.isPersonDetected = false;
    this.estimatedDistance = 3.0; // meters
    this.lastRawZ = 3.0;
    this.detectionConfidence = 0.0;
    this.onStatusChange = options.onStatusChange || null;

    // Zero-GC calculation buffers
    this._camPos = new THREE.Vector3();
    this._rayDir = new THREE.Vector3();
    this._tempVec = new THREE.Vector3();
    this._p1 = new THREE.Vector3();
    this._p2 = new THREE.Vector3();
    this._mid = new THREE.Vector3();
    this._diff = new THREE.Vector3();

    // 3D Hitbox Target Smoothing Cache
    this.targets = {
      torsoPos: new THREE.Vector3(0, 0, -3),
      torsoScale: new THREE.Vector3(0.45, 0.6, 0.25),
      torsoQuat: new THREE.Quaternion(),
      headPos: new THREE.Vector3(0, 0.6, -3),
      pelvisPos: new THREE.Vector3(0, -0.3, -3),
      leftLegPos: new THREE.Vector3(-0.15, -0.8, -3),
      leftLegScale: new THREE.Vector3(0.18, 0.8, 0.18),
      leftLegQuat: new THREE.Quaternion(),
      rightLegPos: new THREE.Vector3(0.15, -0.8, -3),
      rightLegScale: new THREE.Vector3(0.18, 0.8, 0.18),
      rightLegQuat: new THREE.Quaternion()
    };

    // Landmark anti-jitter smoothing cache
    this._smoothedLandmarks = null;
    this._lastLandmarkTime = 0;

    // Master 3D Hitbox Container (registered for ballistics raycasting)
    this.hitboxGroup = new THREE.Group();
    this.hitboxGroup.name = 'AI_Live_Human_Hitboxes';
    this.hitboxGroup.visible = false;
    this.scene.scene.add(this.hitboxGroup);

    this.initHitboxMeshes();
    this.initSkeletonLines();
    this.initPoseModel();
  }

  initHitboxMeshes() {
    // 100% physically raycastable, 0% rendered pixel visibility (invisible collision hulls)
    // Raycaster can intersect triangles normally because visible === true,
    // but the WebGL engine skips writing color/depth (transparent: true, opacity: 0, colorWrite: false).
    const createInvisibleHitboxMat = () => new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      colorWrite: false
    });

    // 1. Torso / Bröstkorg (Approved NMI Zone - Godkand_Zon)
    this.torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), createInvisibleHitboxMat());
    this.torsoMesh.name = 'Godkand_Zon';
    this.torsoMesh.userData.zoneType = 'Torso';
    this.torsoMesh.userData.isAI = true;
    this.hitboxGroup.add(this.torsoMesh);

    // 2. Head / Huvud (Forbidden Danger Zone - Snävt beräknad runt skalle/ansikte)
    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 10), createInvisibleHitboxMat());
    this.headMesh.name = 'Huvud / Hals';
    this.headMesh.userData.zoneType = 'Head';
    this.headMesh.userData.isAI = true;
    this.hitboxGroup.add(this.headMesh);

    // 3. Pelvis / Ljumskar (Forbidden Zone - Farlig_Zon)
    this.pelvisMesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, 0.22), createInvisibleHitboxMat());
    this.pelvisMesh.name = 'Ljumskar / Genitalier';
    this.pelvisMesh.userData.zoneType = 'Groin';
    this.pelvisMesh.userData.isAI = true;
    this.hitboxGroup.add(this.pelvisMesh);

    // 4. Left Leg / Vänster ben (Approved NMI Zone - Godkand_Zon)
    this.leftLegMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 1, 12), createInvisibleHitboxMat());
    this.leftLegMesh.name = 'Godkand_Zon';
    this.leftLegMesh.userData.zoneType = 'Ben';
    this.leftLegMesh.userData.isAI = true;
    this.hitboxGroup.add(this.leftLegMesh);

    // 5. Right Leg / Höger ben (Approved NMI Zone - Godkand_Zon)
    this.rightLegMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 1, 12), createInvisibleHitboxMat());
    this.rightLegMesh.name = 'Godkand_Zon';
    this.rightLegMesh.userData.zoneType = 'Ben';
    this.rightLegMesh.userData.isAI = true;
    this.hitboxGroup.add(this.rightLegMesh);
  }

  initSkeletonLines() {
    // Tactical HUD Skeleton line connections (hidden to maintain full AR immersion)
    this.skeletonBones = [
      [11, 12], // Shoulders
      [11, 23], // Left torso side
      [12, 24], // Right torso side
      [23, 24], // Hips
      [11, 13], [13, 15], // Left arm
      [12, 14], [14, 16], // Right arm
      [23, 25], [25, 27], // Left leg
      [24, 26], [26, 28]  // Right leg
    ];

    const maxPoints = this.skeletonBones.length * 2;
    const positions = new Float32Array(maxPoints * 3);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const lineMat = new THREE.LineBasicMaterial({
      color: 0x00ff88,
      linewidth: 2,
      transparent: true,
      opacity: 0.0
    });

    this.skeletonMesh = new THREE.LineSegments(lineGeo, lineMat);
    this.skeletonMesh.frustumCulled = false;
    this.skeletonMesh.visible = false;
    this.hitboxGroup.add(this.skeletonMesh);

    // Joint tracking dots (hidden)
    const jointGeo = new THREE.BufferGeometry();
    const jointPos = new Float32Array(33 * 3);
    jointGeo.setAttribute('position', new THREE.BufferAttribute(jointPos, 3));
    const jointMat = new THREE.PointsMaterial({
      color: 0x00ffff,
      size: 0.04,
      transparent: true,
      opacity: 0.0
    });
    this.jointPoints = new THREE.Points(jointGeo, jointMat);
    this.jointPoints.frustumCulled = false;
    this.jointPoints.visible = false;
    this.hitboxGroup.add(this.jointPoints);
  }

  async initPoseModel() {
    this.initPromise = new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 30; // 9 seconds max wait for script tag

      const trySetup = async () => {
        attempts++;
        const PoseClass = typeof window !== 'undefined' ? window.Pose : null;

        if (!PoseClass) {
          if (attempts >= maxAttempts) {
            const err = new Error('MediaPipe Pose skriptet (window.Pose) kunde inte laddas.');
            console.error('[ML MODEL ERROR]', err);
            this.modelLoadingError = err;
            reject(err);
            return;
          }
          setTimeout(trySetup, 300);
          return;
        }

        try {
          this.pose = new PoseClass({
            locateFile: (file) => {
              // Direct CDN locator for guaranteed cross-origin and GitHub Pages subpath compatibility
              return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`;
            }
          });

          this.pose.setOptions({
            modelComplexity: 0, // 0 = BlazePose Lite (High-FPS mobile real-time), 1 = Full
            smoothLandmarks: true,
            enableSegmentation: false,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
          });

          this.pose.onResults(this.onPoseResults.bind(this));

          // Explicitly initialize WASM and assets
          await this.pose.initialize();

          this.isReady = true;
          this.modelLoadingError = null;
          console.log('[ML MODEL] MediaPipe BlazePose model initialized and compiled successfully.');
          resolve(true);
        } catch (err) {
          console.error('[ML MODEL ERROR] Kunde inte initiera MediaPipe Pose:', err);
          this.modelLoadingError = err;
          // Even if local initialize fails, keep pose object in case first send succeeds or retries with CDN
          this.isReady = !!this.pose;
          reject(err);
        }
      };

      trySetup();
    });

    return this.initPromise;
  }

  async ensureReady(timeoutMs = 8000) {
    if (this.isReady && this.pose) return true;
    if (!this.initPromise) {
      this.initPoseModel();
    }

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Tidsgräns överskreds vid laddning av AI-modellen (MediaPipe).')), timeoutMs)
    );

    try {
      await Promise.race([this.initPromise, timeoutPromise]);
      return true;
    } catch (err) {
      console.error('[ML MODEL ERROR] ensureReady misslyckades:', err);
      throw err;
    }
  }

  start(videoElement) {
    if (videoElement) this.videoElement = videoElement;
    this.isActive = true;
    this.isPersonDetected = false;
    this.hitboxGroup.visible = true;

    // Hide static 3D target mannequin while live camera AI is active
    this.scene.set3DVisibility(false);

    if (this.onStatusChange) {
      this.onStatusChange(true, 'AI SÖKER PERSON...');
    }
  }

  stop() {
    this.isActive = false;
    this.isPersonDetected = false;
    this.hitboxGroup.visible = false;
    this._smoothedLandmarks = null;

    const el = document.getElementById('live-target-overlay');
    if (el) el.style.display = 'none';

    // Restore static 3D target when exiting live camera AR
    this.scene.set3DVisibility(true);

    if (this.onStatusChange) {
      this.onStatusChange(false, 'AI VILOLÄGE');
    }
  }

  isLiveARModeActive() {
    if (!this.isActive) return false;
    if (typeof document !== 'undefined') {
      if (
        document.body.classList.contains('webxr-mode') ||
        document.body.classList.contains('ar-combat-mode') ||
        document.body.classList.contains('xr-placing')
      ) {
        return false;
      }
      const inLiveAR =
        document.body.classList.contains('live-ar-active') ||
        document.body.classList.contains('live-ai-active');
      if (!inLiveAR) return false;
    }
    if (this.scene && this.scene.renderer && this.scene.renderer.xr && this.scene.renderer.xr.isPresenting) {
      return false;
    }
    if (this.scene && this.scene.show3DModel) {
      return false;
    }
    return true;
  }

  generateSyntheticLandmarks() {
    this._syntheticTime = (this._syntheticTime || 0) + 0.04;
    const t = this._syntheticTime;
    const sway = Math.sin(t * 1.5) * 0.04;
    const breath = Math.sin(t * 3.0) * 0.01;
    const cx = 0.5 + sway;
    const cy = 0.5 + breath;

    const lm = new Array(33);
    for (let i = 0; i < 33; i++) {
      lm[i] = { x: cx, y: cy, z: 0, visibility: 0.95 };
    }

    // Head / Face landmarks (0: nose, 1-6: eyes, 7-8: ears, 9-10: mouth)
    lm[0] = { x: cx, y: cy - 0.22, z: 0, visibility: 0.99 };
    lm[1] = { x: cx - 0.008, y: cy - 0.232, z: 0, visibility: 0.96 };
    lm[2] = { x: cx - 0.015, y: cy - 0.232, z: 0, visibility: 0.96 };
    lm[3] = { x: cx - 0.022, y: cy - 0.232, z: 0, visibility: 0.95 };
    lm[4] = { x: cx + 0.008, y: cy - 0.232, z: 0, visibility: 0.96 };
    lm[5] = { x: cx + 0.015, y: cy - 0.232, z: 0, visibility: 0.96 };
    lm[6] = { x: cx + 0.022, y: cy - 0.232, z: 0, visibility: 0.95 };
    lm[7] = { x: cx - 0.030, y: cy - 0.224, z: 0, visibility: 0.92 };
    lm[8] = { x: cx + 0.030, y: cy - 0.224, z: 0, visibility: 0.92 };
    lm[9] = { x: cx - 0.012, y: cy - 0.204, z: 0, visibility: 0.95 };
    lm[10] = { x: cx + 0.012, y: cy - 0.204, z: 0, visibility: 0.95 };

    // Shoulders
    lm[11] = { x: cx - 0.09, y: cy - 0.15, z: 0, visibility: 0.98 };
    lm[12] = { x: cx + 0.09, y: cy - 0.15, z: 0, visibility: 0.98 };

    // Elbows
    lm[13] = { x: cx - 0.13, y: cy - 0.03, z: 0, visibility: 0.95 };
    lm[14] = { x: cx + 0.13, y: cy - 0.03, z: 0, visibility: 0.95 };

    // Wrists
    lm[15] = { x: cx - 0.12, y: cy + 0.08, z: 0, visibility: 0.92 };
    lm[16] = { x: cx + 0.12, y: cy + 0.08, z: 0, visibility: 0.92 };

    // Hips
    lm[23] = { x: cx - 0.07, y: cy + 0.06, z: 0, visibility: 0.98 };
    lm[24] = { x: cx + 0.07, y: cy + 0.06, z: 0, visibility: 0.98 };

    // Knees
    lm[25] = { x: cx - 0.08, y: cy + 0.22, z: 0, visibility: 0.95 };
    lm[26] = { x: cx + 0.08, y: cy + 0.22, z: 0, visibility: 0.95 };

    // Ankles
    lm[27] = { x: cx - 0.09, y: cy + 0.38, z: 0, visibility: 0.95 };
    lm[28] = { x: cx + 0.09, y: cy + 0.38, z: 0, visibility: 0.95 };

    return lm;
  }

  /**
   * Decoupled asynchronous AI detection loop.
   * Runs independently of Three.js 60 FPS requestAnimationFrame loop
   * to guarantee zero frame-drops or main-thread freezing.
   */
  async processVideoFrame() {
    if (!this.isActive) return;

    const now = performance.now();
    if (now - this.lastInferenceTime < this.inferenceInterval) return;
    this.lastInferenceTime = now;

    // Simulated camera / Virtual demo person
    if (this.isSimulated) {
      this.onPoseResults({ poseLandmarks: this.generateSyntheticLandmarks() });
      return;
    }

    if (!this.isReady || !this.pose || this.isDetecting) return;
    if (!this.videoElement || this.videoElement.readyState < 2) return;
    if (!this.videoElement.videoWidth || !this.videoElement.videoHeight) return;

    this.isDetecting = true;
    try {
      await this.pose.send({ image: this.videoElement });
      this._consecutiveInferenceErrors = 0;
    } catch (err) {
      this._consecutiveInferenceErrors = (this._consecutiveInferenceErrors || 0) + 1;
      if (this._consecutiveInferenceErrors <= 2) {
        console.warn('[ML INFERENCE NOTICE] MediaPipe frame inference misslyckades:', err);
      }
    } finally {
      this.isDetecting = false;
    }
  }

  /**
   * Translates MediaPipe 2D normalized screen landmarks [0, 1]
   * to full 3D world space coordinates [X, Y, Z] using camera unprojection.
   */
  projectLandmarkTo3D(lm, depth, outVec) {
    // Normalization to NDC [-1, 1]
    const ndcX = (lm.x * 2.0) - 1.0;
    const ndcY = -(lm.y * 2.0) + 1.0;

    outVec.set(ndcX, ndcY, 0.5);
    outVec.unproject(this.camera);

    this._camPos.setFromMatrixPosition(this.camera.matrixWorld);
    this._rayDir.subVectors(outVec, this._camPos).normalize();
    outVec.copy(this._camPos).addScaledVector(this._rayDir, depth);
    return outVec;
  }

  /**
   * Adaptive Velocity-Based Landmark Smoothing Filter
   * Eliminates camera jitter, hand tremor, and sensor noise while maintaining instant response to movement.
   */
  smoothLandmarks(rawLm, timestamp) {
    if (!this._smoothedLandmarks || this._smoothedLandmarks.length !== rawLm.length) {
      this._smoothedLandmarks = rawLm.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z || 0,
        visibility: p.visibility || 0
      }));
      this._lastLandmarkTime = timestamp;
      return this._smoothedLandmarks;
    }

    const dt = Math.max(0.015, Math.min(0.1, (timestamp - this._lastLandmarkTime) / 1000));
    this._lastLandmarkTime = timestamp;

    for (let i = 0; i < rawLm.length; i++) {
      const raw = rawLm[i];
      const prev = this._smoothedLandmarks[i];

      const dx = raw.x - prev.x;
      const dy = raw.y - prev.y;
      const dist = Math.hypot(dx, dy);
      const speed = dist / dt; // normalized screen units per second

      // Speed-dependent adaptive alpha:
      // When still (speed < 0.1 screen/s), alpha is ~0.18 for maximum jitter suppression.
      // When moving quickly (speed > 0.6 screen/s), alpha ramps up to ~0.82 for zero lag.
      const speedFactor = Math.min(1.0, Math.max(0.0, (speed - 0.10) / 0.50));
      const alpha = 0.18 + 0.64 * speedFactor;

      prev.x += dx * alpha;
      prev.y += dy * alpha;
      if (raw.z !== undefined && prev.z !== undefined) {
        prev.z += ((raw.z || 0) - prev.z) * alpha;
      }
      prev.visibility = raw.visibility;
    }

    return this._smoothedLandmarks;
  }

  /**
   * Callback fired by MediaPipe Pose when inference finishes.
   */
  onPoseResults(results) {
    if (!this.isLiveARModeActive()) {
      this.isPersonDetected = false;
      const el = document.getElementById('live-target-overlay');
      if (el) el.style.display = 'none';
      return;
    }

    if (!results || !results.poseLandmarks || results.poseLandmarks.length < 33) {
      if (this.isPersonDetected) {
        this.isPersonDetected = false;
        if (this.onStatusChange) this.onStatusChange(false, 'SÖKER PERSON...');
      }
      return;
    }

    // Apply velocity-adaptive landmark smoothing to eliminate sensor jitter
    const lm = this.smoothLandmarks(results.poseLandmarks, performance.now());

    // Key anatomical landmarks
    const nose = lm[0];
    const lShoulder = lm[11];
    const rShoulder = lm[12];
    const lHip = lm[23];
    const rHip = lm[24];
    const lKnee = lm[25];
    const rKnee = lm[26];
    const lAnkle = lm[27];
    const rAnkle = lm[28];

    // Visibility score check (prioritize visible shoulders/head so seated persons with occluded hips still track)
    const shoulderVis = ((lShoulder.visibility || 0) + (rShoulder.visibility || 0)) * 0.5;
    const hipVis = ((lHip.visibility || 0) + (rHip.visibility || 0)) * 0.5;
    const upperBodyVis = Math.max(shoulderVis * 0.85, (shoulderVis + hipVis) * 0.5);
    if (upperBodyVis < 0.40 || shoulderVis < 0.35) {
      if (this.isPersonDetected) {
        this.isPersonDetected = false;
        if (this.onStatusChange) this.onStatusChange(false, 'SVAG SIGNAL');
      }
      return;
    }

    // ============================================================
    // 1. BIOMETRIC DEPTH ESTIMATION (PIXEL-CALIBRATED FOR SITTING & CLOSE RANGE)
    // ============================================================
    const vp = document.getElementById('viewport');
    const vpW = (vp && vp.clientWidth) ? vp.clientWidth : (window.innerWidth || 390);
    const vpH = (vp && vp.clientHeight) ? vp.clientHeight : (window.innerHeight || 844);
    const refDimPx = Math.max(240, Math.min(vpW, vpH));

    // Shoulder width in pixels (independent of cropped/bent legs while sitting)
    const shoulderPxRaw = Math.hypot((rShoulder.x - lShoulder.x) * vpW, (rShoulder.y - lShoulder.y) * vpH);
    const shoulderZ = (0.36 * refDimPx) / Math.max(12, shoulderPxRaw);

    // Head width / height in pixels (ears & eye-to-mouth span) to keep close/angled poses accurate
    const headDepthEstimates = [];
    const lEar = lm[7];
    const rEar = lm[8];
    if (
      lEar && rEar &&
      (lEar.visibility === undefined || lEar.visibility > 0.35) &&
      (rEar.visibility === undefined || rEar.visibility > 0.35)
    ) {
      const earSpanPx = Math.hypot((rEar.x - lEar.x) * vpW, (rEar.y - lEar.y) * vpH);
      if (earSpanPx > 6) {
        headDepthEstimates.push((0.145 * refDimPx) / earSpanPx);
      }
    }

    const eyeL = lm[2] || lm[1];
    const eyeR = lm[5] || lm[4];
    const mouthL = lm[9];
    const mouthR = lm[10];
    if (
      eyeL && eyeR && mouthL && mouthR &&
      (eyeL.visibility === undefined || eyeL.visibility > 0.35) &&
      (mouthL.visibility === undefined || mouthL.visibility > 0.35)
    ) {
      const eyeMidX = ((eyeL.x + eyeR.x) * 0.5) * vpW;
      const eyeMidY = ((eyeL.y + eyeR.y) * 0.5) * vpH;
      const mouthMidX = ((mouthL.x + mouthR.x) * 0.5) * vpW;
      const mouthMidY = ((mouthL.y + mouthR.y) * 0.5) * vpH;
      const faceHeightPx = Math.hypot(mouthMidX - eyeMidX, mouthMidY - eyeMidY);
      if (faceHeightPx > 4) {
        headDepthEstimates.push((0.068 * refDimPx) / faceHeightPx);
      }
    }

    let rawZ = shoulderZ;
    if (headDepthEstimates.length > 0) {
      const headZ = headDepthEstimates.reduce((acc, v) => acc + v, 0) / headDepthEstimates.length;
      if (shoulderZ > headZ * 1.35) {
        rawZ = shoulderZ * 0.30 + headZ * 0.70;
      } else {
        rawZ = shoulderZ * 0.60 + headZ * 0.40;
      }
    }
    rawZ = Math.min(Math.max(rawZ, 0.7), 7.5);

    // Outlier-clamped Adaptive EMA filter on Z depth (snap immediately on first lock)
    if (!this.isPersonDetected) {
      this.estimatedDistance = rawZ;
    } else {
      const zDiff = rawZ - this.estimatedDistance;
      const maxZDelta = 0.45;
      const clampedRawZ = this.estimatedDistance + Math.sign(zDiff) * Math.min(Math.abs(zDiff), maxZDelta);
      const zAlpha = Math.abs(zDiff) > 0.2 ? 0.35 : 0.20;
      this.estimatedDistance += (clampedRawZ - this.estimatedDistance) * zAlpha;
    }
    const currentZ = this.estimatedDistance;

    this.isPersonDetected = true;
    this.detectionConfidence = upperBodyVis;

    if (this.onStatusChange) {
      this.onStatusChange(true, `PERSON LÅST (${currentZ.toFixed(1)} M)`);
    }

    // ============================================================
    // 2. COMPUTE 3D POSITIONS FOR ANATOMICAL JOINTS
    // ============================================================
    const pNose = this.projectLandmarkTo3D(nose, currentZ, new THREE.Vector3());
    const pLShoulder = this.projectLandmarkTo3D(lShoulder, currentZ, new THREE.Vector3());
    const pRShoulder = this.projectLandmarkTo3D(rShoulder, currentZ, new THREE.Vector3());
    const pLHip = this.projectLandmarkTo3D(lHip, currentZ, new THREE.Vector3());
    const pRHip = this.projectLandmarkTo3D(rHip, currentZ, new THREE.Vector3());
    const pLKnee = this.projectLandmarkTo3D(lKnee, currentZ, new THREE.Vector3());
    const pRKnee = this.projectLandmarkTo3D(rKnee, currentZ, new THREE.Vector3());
    const pLAnkle = this.projectLandmarkTo3D(lAnkle, currentZ, new THREE.Vector3());
    const pRAnkle = this.projectLandmarkTo3D(rAnkle, currentZ, new THREE.Vector3());

    // Midpoints
    const shoulderMid = this._p1.copy(pLShoulder).add(pRShoulder).multiplyScalar(0.5);
    const hipMid = this._p2.copy(pLHip).add(pRHip).multiplyScalar(0.5);
    const torsoMid = this._mid.copy(shoulderMid).add(hipMid).multiplyScalar(0.5);

    // Sizes
    const shoulderBreadth3D = Math.max(0.32, pLShoulder.distanceTo(pRShoulder));
    const torsoHeight3D = Math.max(0.40, shoulderMid.distanceTo(hipMid));

    // Update Targets & Orientations (generös 3D-bål upp mot nyckelben och ut åt sidorna)
    this.targets.torsoPos.copy(torsoMid).lerp(shoulderMid, 0.09);
    this.targets.torsoScale.set(shoulderBreadth3D * 1.40, torsoHeight3D * 1.24, 0.30);

    // Anatomical orientation for Torso
    const chestDirX = this._diff.copy(pRShoulder).sub(pLShoulder).normalize();
    const chestDirY = this._p1.copy(shoulderMid).sub(hipMid).normalize();
    const chestDirZ = new THREE.Vector3().crossVectors(chestDirX, chestDirY).normalize();
    const mChest = new THREE.Matrix4().makeBasis(chestDirX, chestDirY, chestDirZ);
    this.targets.torsoQuat.setFromRotationMatrix(mChest);

    this.targets.headPos.copy(pNose);
    this.targets.pelvisPos.copy(hipMid);

    // Left Leg orientation & scale
    const lLegMid = this._p1.copy(pLHip).add(pLKnee).multiplyScalar(0.5);
    this.targets.leftLegPos.copy(lLegMid);
    const lLegLen = Math.max(0.35, pLHip.distanceTo(pLKnee));
    this.targets.leftLegScale.set(1.0, lLegLen, 1.0);
    this._diff.copy(pLKnee).sub(pLHip).normalize();
    this.targets.leftLegQuat.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this._diff);

    // Right Leg orientation & scale
    const rLegMid = this._p2.copy(pRHip).add(pRKnee).multiplyScalar(0.5);
    this.targets.rightLegPos.copy(rLegMid);
    const rLegLen = Math.max(0.35, pRHip.distanceTo(pRKnee));
    this.targets.rightLegScale.set(1.0, rLegLen, 1.0);
    this._diff.copy(pRKnee).sub(pRHip).normalize();
    this.targets.rightLegQuat.setFromUnitVectors(new THREE.Vector3(0, -1, 0), this._diff);

    // ============================================================
    // 3. COMPUTE 2D SCREEN TARGET OVERLAY & HIT ZONES (PIXEL-EXAKT)
    // ============================================================
    const lShPx = { x: lShoulder.x * vpW, y: lShoulder.y * vpH };
    const rShPx = { x: rShoulder.x * vpW, y: rShoulder.y * vpH };
    const lHipPx = { x: lHip.x * vpW, y: lHip.y * vpH };
    const rHipPx = { x: rHip.x * vpW, y: rHip.y * vpH };
    const nosePx = { x: nose.x * vpW, y: nose.y * vpH };

    const shoulderPx = Math.max(28, Math.hypot(rShPx.x - lShPx.x, rShPx.y - lShPx.y));
    const shMidX = (lShPx.x + rShPx.x) * 0.5;
    const shTopY = Math.min(lShPx.y, rShPx.y);
    const rawHipBotY = Math.max(lHipPx.y, rHipPx.y);
    const hipBotY = (hipVis < 0.35 || rawHipBotY <= shTopY + shoulderPx * 0.45)
      ? Math.min(vpH, shTopY + shoulderPx * 1.35)
      : rawHipBotY;

    // 3A. Snäv Röd Huvudbox: endast ansikte/skalle (landmarks 0..10 med tajt marginal)
    const faceIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const validFacePts = [];
    for (let i = 0; i < faceIndices.length; i++) {
      const p = lm[faceIndices[i]];
      if (!p) continue;
      const visOk = (p.visibility === undefined || p.visibility > 0.35);
      if (!visOk) continue;
      const px = p.x * vpW;
      const py = p.y * vpH;
      if (Math.hypot(px - nosePx.x, py - nosePx.y) <= shoulderPx * 0.85) {
        validFacePts.push({ x: px, y: py });
      }
    }
    if (validFacePts.length === 0) {
      validFacePts.push({ x: nosePx.x, y: nosePx.y });
    }

    let fMinX = Infinity, fMaxX = -Infinity, fMinY = Infinity, fMaxY = -Infinity;
    for (let i = 0; i < validFacePts.length; i++) {
      const pt = validFacePts[i];
      if (pt.x < fMinX) fMinX = pt.x;
      if (pt.x > fMaxX) fMaxX = pt.x;
      if (pt.y < fMinY) fMinY = pt.y;
      if (pt.y > fMaxY) fMaxY = pt.y;
    }

    const rawFaceW = Math.max(0, fMaxX - fMinX);
    const rawFaceH = Math.max(0, fMaxY - fMinY);
    const faceCenterX = (fMinX + fMaxX) * 0.5;

    // Tajt skalle/ansikte utan halsmarginal
    const padHeadX = Math.max(shoulderPx * 0.035, rawFaceW * 0.08);
    const headW = Math.max(shoulderPx * 0.28, Math.min(shoulderPx * 0.46, rawFaceW + padHeadX * 2));
    const headLeft = Math.max(0, Math.min(vpW - headW, faceCenterX - headW * 0.5));

    const padHeadTop = Math.max(shoulderPx * 0.13, rawFaceH * 0.38);
    const padHeadBottom = Math.max(shoulderPx * 0.04, rawFaceH * 0.14);
    const headBottom = fMaxY + padHeadBottom;
    const rawHeadH = headBottom - (fMinY - padHeadTop);
    const headH = Math.max(shoulderPx * 0.34, Math.min(shoulderPx * 0.52, rawHeadH));
    const headTop = Math.max(0, headBottom - headH);

    // 3B. Generös Grön KMI-zon (Kropp/Bål): bredare axel-till-höft & sträcker sig ända upp mot hakans underkant (inkl. nyckelben)
    const shMinX = Math.min(lShPx.x, rShPx.x);
    const shMaxX = Math.max(lShPx.x, rShPx.x);
    const hipMinX = Math.min(lHipPx.x, rHipPx.x);
    const hipMaxX = Math.max(lHipPx.x, rHipPx.x);
    const bodyBaseLeft = Math.min(shMinX, hipMinX);
    const bodyBaseRight = Math.max(shMaxX, hipMaxX);
    const bodySpanW = Math.max(shoulderPx * 0.85, bodyBaseRight - bodyBaseLeft);
    const torsoHeightPx = Math.max(shoulderPx * 0.85, hipBotY - shTopY);

    // Extra bredd på båda sidor så ytterkant bål/axlar alltid räknas som godkänd grön träff
    const torsoPadX = Math.max(shoulderPx * 0.24, bodySpanW * 0.24);
    const torsoLeft = Math.max(0, bodyBaseLeft - torsoPadX);
    const torsoRight = Math.min(vpW, bodyBaseRight + torsoPadX);
    const torsoW = Math.max(56, torsoRight - torsoLeft);

    // Sträck bålboxen högt upp till strax under hakan (täcker nyckelben & övre bröstkorg)
    const neckGapPx = Math.max(2, shTopY - headBottom);
    const torsoTop = Math.max(
      headTop + headH + 2,
      Math.min(shTopY - shoulderPx * 0.10, headBottom + Math.min(5, neckGapPx * 0.15))
    );
    const torsoBottom = Math.min(vpH, hipBotY + torsoHeightPx * 0.08);
    const torsoH = Math.max(60, torsoBottom - torsoTop);

    // 3C. Yttre person-omfång (inkludera ben om synliga utan att låta brusiga anklar blåsa upp X)
    let legMaxY = torsoBottom + torsoHeightPx * 0.55;
    const legLandmarks = [lKnee, rKnee, lAnkle, rAnkle];
    for (let i = 0; i < legLandmarks.length; i++) {
      const lp = legLandmarks[i];
      if (lp && (lp.visibility === undefined || lp.visibility > 0.35)) {
        const ly = lp.y * vpH;
        if (ly > torsoBottom && ly <= vpH * 1.05) {
          legMaxY = Math.max(legMaxY, ly);
        }
      }
    }

    const boxLeft = Math.max(0, Math.min(headLeft, torsoLeft));
    const boxRight = Math.min(vpW, Math.max(headLeft + headW, torsoLeft + torsoW, shMidX + torsoW * 0.5));
    const boxTop = Math.max(0, headTop - 3);
    const boxBottom = Math.min(vpH, Math.max(torsoBottom + 24, legMaxY));

    this.targetBox = {
      left: boxLeft,
      top: boxTop,
      width: Math.max(64, boxRight - boxLeft),
      height: Math.max(120, boxBottom - boxTop),
      distance: currentZ,
      headBox: {
        left: headLeft,
        top: headTop,
        width: headW,
        height: headH
      },
      torsoBox: {
        left: torsoLeft,
        top: torsoTop,
        width: torsoW,
        height: torsoH
      }
    };
  }

  /**
   * Per-frame Three.js update loop (60 FPS).
   * Frame-rate independent exponential smoothing: alpha = 1 - exp(-lambda * delta).
   */
  update(delta) {
    if (!this.isLiveARModeActive()) {
      this.isPersonDetected = false;
      if (this.hitboxGroup) this.hitboxGroup.visible = false;
      const el = document.getElementById('live-target-overlay');
      if (el) el.style.display = 'none';
      return;
    }

    // Process asynchronous detection frame if due
    this.processVideoFrame();

    if (!this.isPersonDetected) {
      this.hitboxGroup.visible = false;
      const el = document.getElementById('live-target-overlay');
      if (el) el.style.display = 'none';
      return;
    }

    this.hitboxGroup.visible = true;

    // Frame-rate independent exponential smoothing factor: 1 - exp(-lambda * delta)
    // lambda = 14.0 s^-1 gives a half-life of ~50ms: ultra-responsive without any jitter
    const decayLambda = 14.0;
    const lerpAlpha = 1.0 - Math.exp(-decayLambda * Math.min(delta, 0.1));

    // 1. Torso
    this.torsoMesh.position.lerp(this.targets.torsoPos, lerpAlpha);
    this.torsoMesh.scale.lerp(this.targets.torsoScale, lerpAlpha);
    if (this.targets.torsoQuat) {
      this.torsoMesh.quaternion.slerp(this.targets.torsoQuat, lerpAlpha);
    }

    // 2. Head
    this.headMesh.position.lerp(this.targets.headPos, lerpAlpha);

    // 3. Pelvis
    this.pelvisMesh.position.lerp(this.targets.pelvisPos, lerpAlpha);

    // 4. Left Leg
    this.leftLegMesh.position.lerp(this.targets.leftLegPos, lerpAlpha);
    this.leftLegMesh.scale.lerp(this.targets.leftLegScale, lerpAlpha);
    if (this.targets.leftLegQuat) {
      this.leftLegMesh.quaternion.slerp(this.targets.leftLegQuat, lerpAlpha);
    }

    // 5. Right Leg
    this.rightLegMesh.position.lerp(this.targets.rightLegPos, lerpAlpha);
    this.rightLegMesh.scale.lerp(this.targets.rightLegScale, lerpAlpha);
    if (this.targets.rightLegQuat) {
      this.rightLegMesh.quaternion.slerp(this.targets.rightLegQuat, lerpAlpha);
    }

    // 6. Smooth DOMOverlay Live Target Position
    this.updateTargetOverlay();
  }

  getCurrentScreenBox() {
    if (!this.isLiveARModeActive() || !this.isPersonDetected) return null;
    return this._currBox || this.targetBox || null;
  }

  /**
   * Updates the 2D tactical target overlay to dynamically follow the detected person on screen.
   */
  updateTargetOverlay() {
    const el = document.getElementById('live-target-overlay');
    if (!el) return;

    if (!this.isLiveARModeActive() || !this.isPersonDetected || !this.targetBox) {
      el.style.display = 'none';
      return;
    }

    el.style.display = 'block';

    const lerpBox = (curr, target, alpha) => {
      curr.left += (target.left - curr.left) * alpha;
      curr.top += (target.top - curr.top) * alpha;
      curr.width += (target.width - curr.width) * alpha;
      curr.height += (target.height - curr.height) * alpha;
    };

    if (!this._currBox) {
      this._currBox = {
        ...this.targetBox,
        headBox: this.targetBox.headBox ? { ...this.targetBox.headBox } : null,
        torsoBox: this.targetBox.torsoBox ? { ...this.targetBox.torsoBox } : null
      };
    } else {
      const alpha = 0.28;
      lerpBox(this._currBox, this.targetBox, alpha);
      this._currBox.distance = this.estimatedDistance;
      if (this.targetBox.headBox) {
        if (!this._currBox.headBox) this._currBox.headBox = { ...this.targetBox.headBox };
        else lerpBox(this._currBox.headBox, this.targetBox.headBox, alpha);
      }
      if (this.targetBox.torsoBox) {
        if (!this._currBox.torsoBox) this._currBox.torsoBox = { ...this.targetBox.torsoBox };
        else lerpBox(this._currBox.torsoBox, this.targetBox.torsoBox, alpha);
      }
    }

    el.style.transform = `translate3d(${this._currBox.left.toFixed(1)}px, ${this._currBox.top.toFixed(1)}px, 0)`;
    el.style.width = `${this._currBox.width.toFixed(1)}px`;
    el.style.height = `${this._currBox.height.toFixed(1)}px`;

    const headEl = el.querySelector('.hud-zone-head');
    if (headEl && this._currBox.headBox) {
      const hb = this._currBox.headBox;
      headEl.style.left = `${(hb.left - this._currBox.left).toFixed(1)}px`;
      headEl.style.top = `${(hb.top - this._currBox.top).toFixed(1)}px`;
      headEl.style.width = `${hb.width.toFixed(1)}px`;
      headEl.style.height = `${hb.height.toFixed(1)}px`;
    }

    const torsoEl = el.querySelector('.hud-zone-torso');
    if (torsoEl && this._currBox.torsoBox) {
      const tb = this._currBox.torsoBox;
      torsoEl.style.left = `${(tb.left - this._currBox.left).toFixed(1)}px`;
      torsoEl.style.top = `${(tb.top - this._currBox.top).toFixed(1)}px`;
      torsoEl.style.width = `${tb.width.toFixed(1)}px`;
      torsoEl.style.height = `${tb.height.toFixed(1)}px`;
    }

    const distEl = document.getElementById('target-live-dist');
    if (distEl) distEl.textContent = `${this.estimatedDistance.toFixed(1)} M`;
  }

  /**
   * Screen-space 2D raycasting against the Live Target bounding box and anatomical zones.
   */
  checkScreenHit(aimXPct, aimYPct, dropPx, tiltDeg = 0) {
    if (!this.isLiveARModeActive() || !this.isPersonDetected || !this.targetBox) return null;

    const vp = document.getElementById('viewport');
    const vpW = vp ? vp.clientWidth : window.innerWidth;
    const vpH = vp ? vp.clientHeight : window.innerHeight;

    // Pixel position of upper aim laser (Top Dart)
    const d1X = (aimXPct / 100) * vpW;
    const d1Y = (aimYPct / 100) * vpH;

    // Pixel position of lower laser (Bottom Dart with ballistic spread drop & weapon tilt)
    const tiltRad = ((Number(tiltDeg) || 0) * Math.PI) / 180;
    const d2X = d1X - Math.sin(tiltRad) * dropPx;
    const d2Y = d1Y + Math.cos(tiltRad) * dropPx;

    const b = this._currBox || this.targetBox;
    const hb = b.headBox || {
      left: b.left + b.width * 0.37,
      top: b.top + b.height * 0.02,
      width: b.width * 0.26,
      height: b.height * 0.115
    };
    const tb = b.torsoBox || {
      left: b.left + b.width * 0.06,
      top: b.top + b.height * 0.145,
      width: b.width * 0.88,
      height: b.height * 0.47
    };

    const fovYRad = ((this.camera ? this.camera.fov : 60) * Math.PI) / 180;
    const camMetersPerPx = (2 * Math.tan(fovYRad / 2) * this.estimatedDistance) / Math.max(1, vpH);
    const torsoMetersPerPx = 0.65 / Math.max(40, tb.height);
    const metersPerPx = Math.max(camMetersPerPx, torsoMetersPerPx);

    const toHitPoint = (px, py) => new THREE.Vector3(
      (px - vpW * 0.5) * metersPerPx,
      -(py - vpH * 0.5) * metersPerPx,
      -this.estimatedDistance
    );

    const insideRect = (px, py, r) => (
      px >= r.left && px <= r.left + r.width &&
      py >= r.top && py <= r.top + r.height
    );

    const testDart = (px, py) => {
      // 1. Generös grön målzon först (inkl. nyckelben, bröst, övre & breda bålen)
      if (insideRect(px, py, tb)) {
        return {
          point: toHitPoint(px, py),
          object: this.torsoMesh,
          zoneType: 'Torso',
          name: 'Godkand_Zon',
          isApproved: true
        };
      }

      // 2. Snäv röd förbjuden zon (endast tätt runt ansikte/skalle)
      if (insideRect(px, py, hb)) {
        return {
          point: toHitPoint(px, py),
          object: this.headMesh,
          zoneType: 'Head',
          name: 'Huvud / Hals',
          isApproved: false
        };
      }

      // 3. Nedre delen av personen (under bålen)
      if (insideRect(px, py, b) && py > tb.top + tb.height) {
        const groinBottom = tb.top + tb.height + Math.max(12, b.height * 0.06);
        const hipCenterX = tb.left + tb.width * 0.5;
        if (py <= groinBottom && Math.abs(px - hipCenterX) <= tb.width * 0.22) {
          return {
            point: toHitPoint(px, py),
            object: this.pelvisMesh,
            zoneType: 'Groin',
            name: 'Ljumskar / Genitalier',
            isApproved: false
          };
        }
        return {
          point: toHitPoint(px, py),
          object: this.leftLegMesh,
          zoneType: 'Ben',
          name: 'Godkand_Zon',
          isApproved: true
        };
      }

      return null; // Miss
    };

    const hit1 = testDart(d1X, d1Y);
    const hit2 = testDart(d2X, d2Y);

    return {
      hit1,
      hit2,
      hitWall1: !hit1,
      hitWall2: !hit2,
      screenCoords: {
        d1X,
        d1Y,
        d2X,
        d2Y,
        box: b ? { ...b } : null
      }
    };
  }
}
