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

    this.videoElement = options.videoElement || document.getElementById('camera-feed');
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

    // 2. Head / Huvud & Hals (Forbidden Danger Zone - Farlig_Zon)
    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), createInvisibleHitboxMat());
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

    // Head / Nose
    lm[0] = { x: cx, y: cy - 0.22, z: 0, visibility: 0.99 };

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
    if (!this.isActive) return;

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

    // Visibility score check
    const upperBodyVis = (lShoulder.visibility + rShoulder.visibility + lHip.visibility + rHip.visibility) / 4.0;
    if (upperBodyVis < 0.45) {
      if (this.isPersonDetected) {
        this.isPersonDetected = false;
        if (this.onStatusChange) this.onStatusChange(false, 'SVAG SIGNAL');
      }
      return;
    }

    // ============================================================
    // 1. BIOMETRIC DEPTH ESTIMATION (Z-AXIS) WITH OUTLIER-CLAMPED EMA
    // ============================================================
    // Biacromial breadth (inter-shoulder distance) in average adults = 0.40m
    const realShoulderWidth = 0.40;
    const dx = Math.abs(rShoulder.x - lShoulder.x);
    const dy = Math.abs(rShoulder.y - lShoulder.y);
    const screenShoulderDist = Math.hypot(dx, dy);

    const fovYRad = (this.camera.fov * Math.PI) / 180;
    const fy = 1.0 / (2.0 * Math.tan(fovYRad / 2.0));
    const fx = fy / Math.max(0.2, this.camera.aspect);

    // Compute depth via pinhole perspective projection
    let rawZ = (realShoulderWidth * fx) / Math.max(0.06, screenShoulderDist);
    rawZ = Math.min(Math.max(rawZ, 0.9), 7.5);

    // Outlier-clamped Adaptive EMA filter on Z depth
    const zDiff = rawZ - this.estimatedDistance;
    const maxZDelta = 0.35; // prevent unrealistic frame-to-frame depth teleportation
    const clampedRawZ = this.estimatedDistance + Math.sign(zDiff) * Math.min(Math.abs(zDiff), maxZDelta);
    const zAlpha = Math.abs(zDiff) > 0.2 ? 0.32 : 0.18;
    this.estimatedDistance += (clampedRawZ - this.estimatedDistance) * zAlpha;
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

    // Update Targets & Orientations
    this.targets.torsoPos.copy(torsoMid);
    this.targets.torsoScale.set(shoulderBreadth3D * 1.15, torsoHeight3D * 1.05, 0.28);

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
    // 3. COMPUTE 2D SCREEN TARGET OVERLAY BOUNDING BOX (DOMOVERLAY)
    // ============================================================
    const vp = document.getElementById('viewport');
    const vpW = vp ? vp.clientWidth : window.innerWidth;
    const vpH = vp ? vp.clientHeight : window.innerHeight;

    const minX = Math.min(nose.x, lShoulder.x, rShoulder.x, lHip.x, rHip.x, lAnkle.x, rAnkle.x);
    const maxX = Math.max(nose.x, lShoulder.x, rShoulder.x, lHip.x, rHip.x, lAnkle.x, rAnkle.x);
    const minY = Math.min(nose.y - 0.06, lShoulder.y, rShoulder.y);
    const maxY = Math.max(lAnkle.y, rAnkle.y, lHip.y + 0.35);

    const padX = (maxX - minX) * 0.18;
    const padY = (maxY - minY) * 0.05;

    this.targetBox = {
      left: Math.max(0, (minX - padX) * vpW),
      top: Math.max(0, (minY - padY) * vpH),
      width: Math.max(60, Math.min(vpW, (maxX - minX + padX * 2) * vpW)),
      height: Math.max(120, Math.min(vpH, (maxY - minY + padY * 2) * vpH)),
      distance: currentZ
    };
  }

  /**
   * Per-frame Three.js update loop (60 FPS).
   * Frame-rate independent exponential smoothing: alpha = 1 - exp(-lambda * delta).
   */
  update(delta) {
    if (!this.isActive) return;

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

  /**
   * Updates the 2D SVG Taser target overlay to dynamically follow the detected person on screen.
   */
  updateTargetOverlay() {
    const el = document.getElementById('live-target-overlay');
    if (!el) return;

    if (!this.isActive || !this.isPersonDetected || !this.targetBox) {
      el.style.display = 'none';
      return;
    }

    el.style.display = 'block';

    if (!this._currBox) {
      this._currBox = { ...this.targetBox };
    } else {
      const alpha = 0.28;
      this._currBox.left += (this.targetBox.left - this._currBox.left) * alpha;
      this._currBox.top += (this.targetBox.top - this._currBox.top) * alpha;
      this._currBox.width += (this.targetBox.width - this._currBox.width) * alpha;
      this._currBox.height += (this.targetBox.height - this._currBox.height) * alpha;
    }

    el.style.transform = `translate3d(${this._currBox.left.toFixed(1)}px, ${this._currBox.top.toFixed(1)}px, 0)`;
    el.style.width = `${this._currBox.width.toFixed(1)}px`;
    el.style.height = `${this._currBox.height.toFixed(1)}px`;

    const distEl = document.getElementById('target-live-dist');
    if (distEl) distEl.textContent = `${this.estimatedDistance.toFixed(1)} M`;
  }

  /**
   * Screen-space 2D raycasting against the Live Target bounding box and anatomical zones.
   */
  checkScreenHit(aimXPct, aimYPct, dropPx) {
    if (!this.isActive || !this.isPersonDetected || !this.targetBox) return null;

    const vp = document.getElementById('viewport');
    const vpW = vp ? vp.clientWidth : window.innerWidth;
    const vpH = vp ? vp.clientHeight : window.innerHeight;

    // Pixel position of aim crosshair (Top Dart)
    const d1X = (aimXPct / 100) * vpW;
    const d1Y = (aimYPct / 100) * vpH;

    // Pixel position of lower dart (Bottom Dart with ballistic spread drop)
    const d2X = d1X + (Math.random() - 0.5) * 4;
    const d2Y = d1Y + dropPx;

    const b = this._currBox || this.targetBox;

    const testDart = (px, py) => {
      // Check bounding box intersection
      if (px < b.left || px > b.left + b.width || py < b.top || py > b.top + b.height) {
        return null; // Miss
      }

      // Calculate relative vertical coordinate [0 = top of head, 1 = feet]
      const relY = (py - b.top) / b.height;

      if (relY >= 0 && relY < 0.18) {
        return {
          point: new THREE.Vector3(0, 0.5, -this.estimatedDistance),
          object: this.headMesh,
          zoneType: 'Head',
          name: 'Huvud / Hals',
          isApproved: false
        };
      } else if (relY >= 0.18 && relY < 0.58) {
        return {
          point: new THREE.Vector3(0, 0, -this.estimatedDistance),
          object: this.torsoMesh,
          zoneType: 'Torso',
          name: 'Godkand_Zon',
          isApproved: true
        };
      } else if (relY >= 0.58 && relY < 0.68) {
        return {
          point: new THREE.Vector3(0, -0.3, -this.estimatedDistance),
          object: this.pelvisMesh,
          zoneType: 'Groin',
          name: 'Ljumskar / Genitalier',
          isApproved: false
        };
      } else {
        return {
          point: new THREE.Vector3(0, -0.6, -this.estimatedDistance),
          object: this.leftLegMesh,
          zoneType: 'Ben',
          name: 'Godkand_Zon',
          isApproved: true
        };
      }
    };

    const hit1 = testDart(d1X, d1Y);
    const hit2 = testDart(d2X, d2Y);

    return {
      hit1,
      hit2,
      hitWall1: !hit1,
      hitWall2: !hit2
    };
  }
}
