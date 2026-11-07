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
      headPos: new THREE.Vector3(0, 0.6, -3),
      pelvisPos: new THREE.Vector3(0, -0.3, -3),
      leftLegPos: new THREE.Vector3(-0.15, -0.8, -3),
      leftLegScale: new THREE.Vector3(0.16, 0.8, 0.16),
      rightLegPos: new THREE.Vector3(0.15, -0.8, -3),
      rightLegScale: new THREE.Vector3(0.16, 0.8, 0.16)
    };

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
    // 1. Torso / Bröstkorg (Approved NMI Zone - Godkand_Zon)
    const torsoMat = new THREE.MeshStandardMaterial({
      color: 0x2ecc71,
      transparent: true,
      opacity: 0.32,
      roughness: 0.4,
      metalness: 0.2,
      wireframe: false,
      depthWrite: false
    });
    this.torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), torsoMat);
    this.torsoMesh.name = 'Godkand_Zon';
    this.torsoMesh.userData.zoneType = 'Torso';
    this.torsoMesh.userData.isAI = true;

    // Sci-Fi Tactical Edge Outline for Torso
    const torsoEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x2ecc71, transparent: true, opacity: 0.85 })
    );
    this.torsoMesh.add(torsoEdges);
    this.hitboxGroup.add(this.torsoMesh);

    // 2. Head / Huvud & Hals (Forbidden Danger Zone - Farlig_Zon)
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xf1c40f,
      transparent: true,
      opacity: 0.35,
      roughness: 0.5,
      depthWrite: false
    });
    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), headMat);
    this.headMesh.name = 'Huvud / Hals';
    this.headMesh.userData.zoneType = 'Head';
    this.headMesh.userData.isAI = true;
    const headEdges = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(0.14, 8, 6)),
      new THREE.LineBasicMaterial({ color: 0xf1c40f, transparent: true, opacity: 0.7 })
    );
    this.headMesh.add(headEdges);
    this.hitboxGroup.add(this.headMesh);

    // 3. Pelvis / Ljumskar (Forbidden Zone - Farlig_Zon)
    const pelvisMat = new THREE.MeshStandardMaterial({
      color: 0xe67e22,
      transparent: true,
      opacity: 0.35,
      roughness: 0.5,
      depthWrite: false
    });
    this.pelvisMesh = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.22, 0.22), pelvisMat);
    this.pelvisMesh.name = 'Ljumskar / Genitalier';
    this.pelvisMesh.userData.zoneType = 'Groin';
    this.pelvisMesh.userData.isAI = true;
    this.hitboxGroup.add(this.pelvisMesh);

    // 4. Left Leg / Vänster ben (Approved NMI Zone - Godkand_Zon)
    const legMat = new THREE.MeshStandardMaterial({
      color: 0x27ae60,
      transparent: true,
      opacity: 0.3,
      roughness: 0.4,
      depthWrite: false
    });
    this.leftLegMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.4, 1, 10), legMat);
    this.leftLegMesh.name = 'Godkand_Zon';
    this.leftLegMesh.userData.zoneType = 'Ben';
    this.leftLegMesh.userData.isAI = true;
    this.hitboxGroup.add(this.leftLegMesh);

    // 5. Right Leg / Höger ben (Approved NMI Zone - Godkand_Zon)
    this.rightLegMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.4, 1, 10), legMat.clone());
    this.rightLegMesh.name = 'Godkand_Zon';
    this.rightLegMesh.userData.zoneType = 'Ben';
    this.rightLegMesh.userData.isAI = true;
    this.hitboxGroup.add(this.rightLegMesh);
  }

  initSkeletonLines() {
    // Real-time Tactical HUD Skeleton line connections
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
      opacity: 0.95
    });

    this.skeletonMesh = new THREE.LineSegments(lineGeo, lineMat);
    this.skeletonMesh.frustumCulled = false;
    this.hitboxGroup.add(this.skeletonMesh);

    // Joint tracking dots
    const jointGeo = new THREE.BufferGeometry();
    const jointPos = new Float32Array(33 * 3);
    jointGeo.setAttribute('position', new THREE.BufferAttribute(jointPos, 3));
    const jointMat = new THREE.PointsMaterial({
      color: 0x00ffff,
      size: 0.04,
      transparent: true,
      opacity: 0.9
    });
    this.jointPoints = new THREE.Points(jointGeo, jointMat);
    this.jointPoints.frustumCulled = false;
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

    const lm = results.poseLandmarks;

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
    // 1. BIOMETRIC DEPTH ESTIMATION (Z-AXIS) WITHOUT LIDAR
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

    // Exponential Moving Average filter (EMA) to eliminate noise & jitter
    this.estimatedDistance = (0.22 * rawZ) + (0.78 * this.estimatedDistance);
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

    // Update Targets
    this.targets.torsoPos.copy(torsoMid);
    this.targets.torsoScale.set(shoulderBreadth3D * 1.15, torsoHeight3D * 1.05, 0.28);

    this.targets.headPos.copy(pNose);

    this.targets.pelvisPos.copy(hipMid);

    // Left Leg
    const lLegMid = this._p1.copy(pLHip).add(pLKnee).multiplyScalar(0.5);
    this.targets.leftLegPos.copy(lLegMid);
    const lLegLen = Math.max(0.4, pLHip.distanceTo(pLKnee));
    this.targets.leftLegScale.set(0.18, lLegLen, 0.18);

    // Right Leg
    const rLegMid = this._p2.copy(pRHip).add(pRKnee).multiplyScalar(0.5);
    this.targets.rightLegPos.copy(rLegMid);
    const rLegLen = Math.max(0.4, pRHip.distanceTo(pRKnee));
    this.targets.rightLegScale.set(0.18, rLegLen, 0.18);

    // ============================================================
    // 3. UPDATE TACTICAL SKELETON HUD LINES
    // ============================================================
    const lineAttr = this.skeletonMesh.geometry.attributes.position;
    const lineArr = lineAttr.array;
    let lineIdx = 0;

    const jointMap = [
      pNose, null, null, null, null, null, null, null, null, null, null,
      pLShoulder, pRShoulder,
      this.projectLandmarkTo3D(lm[13], currentZ, new THREE.Vector3()), // L Elbow
      this.projectLandmarkTo3D(lm[14], currentZ, new THREE.Vector3()), // R Elbow
      this.projectLandmarkTo3D(lm[15], currentZ, new THREE.Vector3()), // L Wrist
      this.projectLandmarkTo3D(lm[16], currentZ, new THREE.Vector3()), // R Wrist
      null, null, null, null, null, null,
      pLHip, pRHip,
      pLKnee, pRKnee,
      pLAnkle, pRAnkle
    ];

    for (let i = 0; i < this.skeletonBones.length; i++) {
      const [b1, b2] = this.skeletonBones[i];
      const pt1 = jointMap[b1];
      const pt2 = jointMap[b2];
      if (pt1 && pt2) {
        lineArr[lineIdx++] = pt1.x; lineArr[lineIdx++] = pt1.y; lineArr[lineIdx++] = pt1.z;
        lineArr[lineIdx++] = pt2.x; lineArr[lineIdx++] = pt2.y; lineArr[lineIdx++] = pt2.z;
      }
    }
    lineAttr.needsUpdate = true;

    // Joint tracking dots
    const jointAttr = this.jointPoints.geometry.attributes.position;
    const jointArr = jointAttr.array;
    let jIdx = 0;
    for (let k = 0; k < jointMap.length; k++) {
      const pt = jointMap[k];
      if (pt) {
        jointArr[jIdx++] = pt.x; jointArr[jIdx++] = pt.y; jointArr[jIdx++] = pt.z;
      } else {
        jointArr[jIdx++] = 0; jointArr[jIdx++] = -100; jointArr[jIdx++] = 0;
      }
    }
    jointAttr.needsUpdate = true;
  }

  /**
   * Per-frame Three.js update loop (60 FPS).
   * Smoothly interpolates (lerps) the physical hitboxes towards latest AI targets.
   */
  update(delta) {
    if (!this.isActive) return;

    // Process asynchronous detection frame if due
    this.processVideoFrame();

    if (!this.isPersonDetected) {
      this.hitboxGroup.visible = false;
      return;
    }

    this.hitboxGroup.visible = true;

    // Interpolation factor ensuring 60 FPS buttery smoothness
    const lerpFactor = Math.min(1.0, Math.max(0.1, delta * 18.0));

    // 1. Torso
    this.torsoMesh.position.lerp(this.targets.torsoPos, lerpFactor);
    this.torsoMesh.scale.lerp(this.targets.torsoScale, lerpFactor);

    // 2. Head
    this.headMesh.position.lerp(this.targets.headPos, lerpFactor);

    // 3. Pelvis
    this.pelvisMesh.position.lerp(this.targets.pelvisPos, lerpFactor);

    // 4. Legs
    this.leftLegMesh.position.lerp(this.targets.leftLegPos, lerpFactor);
    this.leftLegMesh.scale.lerp(this.targets.leftLegScale, lerpFactor);

    this.rightLegMesh.position.lerp(this.targets.rightLegPos, lerpFactor);
    this.rightLegMesh.scale.lerp(this.targets.rightLegScale, lerpFactor);
  }
}
