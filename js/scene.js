/**
 * TASER 7 Tactical 3D Viewport & Simulation Scene
 * Three.js r160+ rendering engine with PBR lighting, procedural fallback, and wire dynamics.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class TaserScene {
  constructor(containerEl, options = {}) {
    this.container = containerEl;
    this.options = options;

    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.pmremGenerator = null;

    this.taserGroup = null;
    this.dummyBody = null;
    this.knifeMesh = null;
    this.placementGround = null;
    this.placementMarker = null;

    this.activeWires = [];
    this.activeDarts = [];
    this.figureFallen = false;
    this.show3DModel = true;
    this.fallInterval = null;

    // Skeletal Animation System (Mixamo / UE Mannequin Pipeline)
    this.clock = new THREE.Clock();
    this.mixer = null;
    this.actions = {};
    this.activeAction = null;
    this.walkSpeed = 0.72; // Calibrated forward velocity (m/s) matching 0.65 timeScale gait cycle to eliminate foot skating
    this.aiPose = null; // AI-Based Person Pose & Dynamic Hitbox Engine

    this.isSoftwareGl = false;
    this.raycaster = new THREE.Raycaster();
    this.placementRaycaster = new THREE.Raycaster();

    // Reusable math vectors to ensure zero GC in animation loop
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();

    this.init();
  }

  detectSoftwareGl() {
    try {
      const probeCanvas = document.createElement('canvas');
      const gl = probeCanvas.getContext('webgl2') || probeCanvas.getContext('webgl');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch (e) {
      return false;
    }
  }

  init() {
    this.isSoftwareGl = this.detectSoftwareGl();

    this.scene = new THREE.Scene();
    this.defaultBackground = new THREE.Color(0x0a0a0a);
    this.scene.background = this.defaultBackground;

    const width = this.container.clientWidth || 320;
    const height = this.container.clientHeight || 320;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    this.camera.position.set(0, 1.35, 3.0);
    this.camera.lookAt(0, 1.35, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.xr.enabled = true;

    if (!this.isSoftwareGl) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    this.container.appendChild(this.renderer.domElement);

    // Studio Environment Lighting
    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;

    // Ambient and Key lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.25);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
    dirLight.position.set(5, 10, 7);
    if (!this.isSoftwareGl) {
      dirLight.castShadow = true;
      dirLight.shadow.camera.top = 2.5;
      dirLight.shadow.camera.bottom = -2.5;
      dirLight.shadow.camera.left = -2.5;
      dirLight.shadow.camera.right = 2.5;
      dirLight.shadow.camera.near = 0.1;
      dirLight.shadow.camera.far = 40;
      dirLight.shadow.bias = -0.0005;
      dirLight.shadow.normalBias = 0.02;
    }
    this.scene.add(dirLight);

    // Tactical Target Group
    this.taserGroup = new THREE.Group();
    this.taserGroup.userData.startPos = new THREE.Vector3(0, 0, 0);
    this.scene.add(this.taserGroup);

    // First-Person TASER Weapon Model Group (Camera-synced local space)
    this.taserModel = new THREE.Group();
    this.taserModel.name = 'Taser7_FirstPersonModel';
    this.scene.add(this.taserModel);

    // Composite Procedural Dummy Mannequin (Fallback + Zones)
    this.setupFallbackMannequin();

    // Setup Knife for threat escalation
    this.setupKnife();

    // Floor and Placement Marker
    this.setupGroundAndMarker();

    // High-Voltage Warning Arc (Three.js 3D Dynamic Arc)
    this.setupWarningArc();

    // Load Retopologized UE Mannequin if available
    this.loadGLBMannequin();

    // Window & container resize observer
    window.addEventListener('resize', this.onResize.bind(this));
    if (typeof ResizeObserver !== 'undefined' && this.container) {
      new ResizeObserver(() => this.onResize()).observe(this.container);
    }
  }

  setupFallbackMannequin() {
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x219653, roughness: 0.5 });
    const dummyBody = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.3), greenMat);
    dummyBody.position.set(0, 0.7, 0);
    dummyBody.castShadow = true;
    dummyBody.receiveShadow = true;
    dummyBody.name = 'Godkand_Zon';
    this.taserGroup.add(dummyBody);
    this.dummyBody = dummyBody;

    // High danger forbidden zones
    const yellowMat = new THREE.MeshStandardMaterial({
      color: 0xf1c40f,
      transparent: true,
      opacity: 0.85,
      emissive: 0xf1c40f,
      emissiveIntensity: 0.4,
      roughness: 0.3,
      metalness: 0.8
    });

    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 16), yellowMat);
    headMesh.position.set(0, 1.65, 0.0);
    headMesh.name = 'Huvud/Hals';
    headMesh.castShadow = true;
    this.taserGroup.add(headMesh);

    const chestMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.25, 0.2), yellowMat);
    chestMesh.position.set(0, 1.35, 0.08);
    chestMesh.name = 'Hjärttrakten';
    chestMesh.castShadow = true;
    this.taserGroup.add(chestMesh);

    const groinMesh = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.15), yellowMat);
    groinMesh.position.set(0, 0.85, 0.08);
    groinMesh.name = 'Genitalier';
    groinMesh.castShadow = true;
    this.taserGroup.add(groinMesh);
  }

  setupKnife() {
    const knifeGroup = new THREE.Group();
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.12, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 })
    );
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.01, 0.25, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1.0, roughness: 0.1 })
    );
    blade.position.y = 0.18;
    knifeGroup.add(handle);
    knifeGroup.add(blade);

    knifeGroup.position.set(0.35, 1.1, 0.3);
    knifeGroup.rotation.x = Math.PI / 2;
    knifeGroup.rotation.z = -Math.PI / 8;
    knifeGroup.visible = false;

    this.knifeMesh = knifeGroup;
    this.taserGroup.add(knifeGroup);
  }

  setupGroundAndMarker() {
    this.placementGround = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.ShadowMaterial({ opacity: 0.5 })
    );
    this.placementGround.rotation.x = -Math.PI / 2;
    this.placementGround.receiveShadow = true;
    this.placementGround.name = 'Environment';
    this.scene.add(this.placementGround);

    this.placementMarker = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.25, 0.4, 48),
      new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
    );
    const circle = new THREE.Mesh(
      new THREE.CircleGeometry(0.12, 32),
      new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    circle.rotation.x = -Math.PI / 2;

    this.placementMarker.add(ring);
    this.placementMarker.add(circle);
    this.placementMarker.position.y = 0.01;
    this.placementMarker.visible = false;
    this.scene.add(this.placementMarker);
  }

  setPlacementFromScreen(x, y) {
    if (!this._ndc) this._ndc = new THREE.Vector2();
    this._ndc.set(x, y);
    this.placementRaycaster.setFromCamera(this._ndc, this.camera);
    return this.placementRaycaster.intersectObject(this.placementGround, true);
  }

  loadGLBMannequin() {
    const loader = new GLTFLoader();
    loader.load(
      './ue_mannequin_retopology.glb',
      (gltf) => {
        const dummy = gltf.scene;
        dummy.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(dummy);
        const modelHeight = box.max.y - box.min.y;
        const scale = 1.8 / (modelHeight || 1.8);
        dummy.scale.set(scale, scale, scale);
        dummy.updateMatrixWorld(true);

        const scaledBox = new THREE.Box3().setFromObject(dummy);
        dummy.position.y = -scaledBox.min.y;

        // Sanitize bone names so PropertyBinding reliably matches without space discrepancies
        dummy.traverse((child) => {
          if (child.name) {
            child.name = child.name.replace(/\s+/g, '_');
          }
          if (child.isMesh) {
            child.material = new THREE.MeshStandardMaterial({
              color: 0x219653,
              roughness: 0.5,
              metalness: 0.3
            });
            child.name = 'Godkand_Zon';
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });

        // Re-parent knife to right hand bone if available
        const handBone = dummy.getObjectByName('Bip001_R_Hand_034');
        if (handBone && this.knifeMesh) {
          this.taserGroup.remove(this.knifeMesh);
          this.knifeMesh.position.set(0.02, 0.04, 0.01);
          this.knifeMesh.rotation.set(Math.PI / 2, 0, -Math.PI / 4);
          handBone.add(this.knifeMesh);
        }

        this.glbDummy = dummy;
        this.hasGLBMannequin = true;
        this.taserGroup.add(dummy);
        if (this.dummyBody) this.dummyBody.visible = false;

        // Setup Skeletal Animations (Mixamo/UE Pipeline)
        this.setupAnimations(dummy, gltf.animations || []);
        console.log('[TaserScene] UE Mannequin retopology 3D model with skeletal animations loaded.');
      },
      undefined,
      (err) => {
        console.warn('[TaserScene] GLB model not found or failed, using composite procedural mannequin:', err);
        if (this.dummyBody) this.dummyBody.visible = true;
        if (this.taserGroup) this.taserGroup.visible = true;
      }
    );
  }

  setupAnimations(root, animations = []) {
    // 1. Check for existing 'Idle' and 'Walk' clips in GLTF or generate them
    let idleClip = THREE.AnimationClip.findByName(animations, 'Idle');
    let walkClip = THREE.AnimationClip.findByName(animations, 'Walk');

    if (!idleClip || !walkClip) {
      const generated = this.generateSkeletalClips(root);
      if (!idleClip) idleClip = generated.idleClip;
      if (!walkClip) walkClip = generated.walkClip;
      animations.push(idleClip, walkClip);
    }

    // 2. Initialize AnimationMixer on root model
    this.mixer = new THREE.AnimationMixer(root);

    // 3. Register clips and configure looping actions
    this.actions = {};
    if (idleClip) {
      const action = this.mixer.clipAction(idleClip);
      action.loop = THREE.LoopRepeat;
      this.actions['Idle'] = action;
    }

    if (walkClip) {
      const action = this.mixer.clipAction(walkClip);
      action.loop = THREE.LoopRepeat;
      action.timeScale = 0.65; // Calibrated for realistic menacing human stride
      this.actions['Walk'] = action;
    }

    // 4. Play 'Idle' as default stance
    if (this.actions['Idle']) {
      this.actions['Idle'].play();
      this.activeAction = this.actions['Idle'];
    }
  }

  generateSkeletalClips(root) {
    const bones = {};
    root.traverse((c) => {
      if (c.name) bones[c.name] = c;
    });

    const yAxis = new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3(1, 0, 0);

    // ==========================================
    // 1. IDLE CLIP (2.4s loop: natural breathing, subtle postural shift)
    // ==========================================
    const timesIdle = [0, 0.6, 1.2, 1.8, 2.4];
    const idleTracks = [];

    // Spine breathing expansion
    const spine = bones['Bip001_Spine_04'];
    if (spine) {
      const q = spine.quaternion.clone();
      const qBreathIn = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(xAxis, 0.035));
      const qBreathSway = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.015));
      idleTracks.push(new THREE.QuaternionKeyframeTrack(spine.name + '.quaternion', timesIdle, [
        q.x, q.y, q.z, q.w,
        qBreathIn.x, qBreathIn.y, qBreathIn.z, qBreathIn.w,
        qBreathSway.x, qBreathSway.y, qBreathSway.z, qBreathSway.w,
        qBreathIn.x, qBreathIn.y, qBreathIn.z, qBreathIn.w,
        q.x, q.y, q.z, q.w
      ]));
    }

    // Head subtle alertness
    const head = bones['Bip001_Head_055'];
    if (head) {
      const qH = head.quaternion.clone();
      const qH1 = qH.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.04));
      const qH2 = qH.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.04));
      idleTracks.push(new THREE.QuaternionKeyframeTrack(head.name + '.quaternion', timesIdle, [
        qH.x, qH.y, qH.z, qH.w,
        qH1.x, qH1.y, qH1.z, qH1.w,
        qH.x, qH.y, qH.z, qH.w,
        qH2.x, qH2.y, qH2.z, qH2.w,
        qH.x, qH.y, qH.z, qH.w
      ]));
    }

    // Left Upper Arm
    const lArm = bones['Bip001_L_UpperArm_08'];
    if (lArm) {
      const qA = lArm.quaternion.clone();
      const qA1 = qA.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.03));
      idleTracks.push(new THREE.QuaternionKeyframeTrack(lArm.name + '.quaternion', timesIdle, [
        qA.x, qA.y, qA.z, qA.w,
        qA1.x, qA1.y, qA1.z, qA1.w,
        qA.x, qA.y, qA.z, qA.w,
        qA1.x, qA1.y, qA1.z, qA1.w,
        qA.x, qA.y, qA.z, qA.w
      ]));
    }

    // Right Upper Arm
    const rArm = bones['Bip001_R_UpperArm_032'];
    if (rArm) {
      const qRA = rArm.quaternion.clone();
      const qRA1 = qRA.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.03));
      idleTracks.push(new THREE.QuaternionKeyframeTrack(rArm.name + '.quaternion', timesIdle, [
        qRA.x, qRA.y, qRA.z, qRA.w,
        qRA1.x, qRA1.y, qRA1.z, qRA1.w,
        qRA.x, qRA.y, qRA.z, qRA.w,
        qRA1.x, qRA1.y, qRA1.z, qRA1.w,
        qRA.x, qRA.y, qRA.z, qRA.w
      ]));
    }

    const idleClip = new THREE.AnimationClip('Idle', 2.4, idleTracks);

    // ==========================================
    // 2. WALK CLIP (1.0s loop: full biped gait cycle)
    // ==========================================
    const timesWalk = [0, 0.25, 0.5, 0.75, 1.0];
    const walkTracks = [];

    // Left Thigh
    const lThigh = bones['Bip001_L_Thigh_057'];
    if (lThigh) {
      const qRest = lThigh.quaternion.clone();
      const q0 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.38));
      const q1 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.05));
      const q2 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.32));
      const q3 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.12));
      const q4 = q0.clone();
      walkTracks.push(new THREE.QuaternionKeyframeTrack(lThigh.name + '.quaternion', timesWalk, [
        q0.x, q0.y, q0.z, q0.w,
        q1.x, q1.y, q1.z, q1.w,
        q2.x, q2.y, q2.z, q2.w,
        q3.x, q3.y, q3.z, q3.w,
        q4.x, q4.y, q4.z, q4.w
      ]));
    }

    // Right Thigh (Opposite phase)
    const rThigh = bones['Bip001_R_Thigh_061'];
    if (rThigh) {
      const qRest = rThigh.quaternion.clone();
      const q0 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.32));
      const q1 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.12));
      const q2 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.38));
      const q3 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.05));
      const q4 = q0.clone();
      walkTracks.push(new THREE.QuaternionKeyframeTrack(rThigh.name + '.quaternion', timesWalk, [
        q0.x, q0.y, q0.z, q0.w,
        q1.x, q1.y, q1.z, q1.w,
        q2.x, q2.y, q2.z, q2.w,
        q3.x, q3.y, q3.z, q3.w,
        q4.x, q4.y, q4.z, q4.w
      ]));
    }

    // Left Calf (Knee Flexion during recovery swing t=0.75)
    const lCalf = bones['Bip001_L_Calf_058'];
    if (lCalf) {
      const qRest = lCalf.quaternion.clone();
      const q0 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.05));
      const q1 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.0));
      const q2 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.05));
      const q3 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.45));
      const q4 = q0.clone();
      walkTracks.push(new THREE.QuaternionKeyframeTrack(lCalf.name + '.quaternion', timesWalk, [
        q0.x, q0.y, q0.z, q0.w,
        q1.x, q1.y, q1.z, q1.w,
        q2.x, q2.y, q2.z, q2.w,
        q3.x, q3.y, q3.z, q3.w,
        q4.x, q4.y, q4.z, q4.w
      ]));
    }

    // Right Calf (Knee Flexion during recovery swing t=0.25)
    const rCalf = bones['Bip001_R_Calf_062'];
    if (rCalf) {
      const qRest = rCalf.quaternion.clone();
      const q0 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.05));
      const q1 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.45));
      const q2 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.05));
      const q3 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.0));
      const q4 = q0.clone();
      walkTracks.push(new THREE.QuaternionKeyframeTrack(rCalf.name + '.quaternion', timesWalk, [
        q0.x, q0.y, q0.z, q0.w,
        q1.x, q1.y, q1.z, q1.w,
        q2.x, q2.y, q2.z, q2.w,
        q3.x, q3.y, q3.z, q3.w,
        q4.x, q4.y, q4.z, q4.w
      ]));
    }

    // Left Upper Arm (Swings forward when right thigh swings forward at t=0.5)
    if (lArm) {
      const qRest = lArm.quaternion.clone();
      const q0 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.28));
      const q1 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.0));
      const q2 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.32));
      const q3 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.0));
      const q4 = q0.clone();
      walkTracks.push(new THREE.QuaternionKeyframeTrack(lArm.name + '.quaternion', timesWalk, [
        q0.x, q0.y, q0.z, q0.w,
        q1.x, q1.y, q1.z, q1.w,
        q2.x, q2.y, q2.z, q2.w,
        q3.x, q3.y, q3.z, q3.w,
        q4.x, q4.y, q4.z, q4.w
      ]));
    }

    // Right Upper Arm (Swings forward when left thigh swings forward at t=0.0)
    if (rArm) {
      const qRest = rArm.quaternion.clone();
      const q0 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.32));
      const q1 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.0));
      const q2 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.28));
      const q3 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.0));
      const q4 = q0.clone();
      walkTracks.push(new THREE.QuaternionKeyframeTrack(rArm.name + '.quaternion', timesWalk, [
        q0.x, q0.y, q0.z, q0.w,
        q1.x, q1.y, q1.z, q1.w,
        q2.x, q2.y, q2.z, q2.w,
        q3.x, q3.y, q3.z, q3.w,
        q4.x, q4.y, q4.z, q4.w
      ]));
    }

    // Spine counter-rotation
    if (spine) {
      const qRest = spine.quaternion.clone();
      const q0 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, 0.04));
      const q1 = qRest.clone();
      const q2 = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(yAxis, -0.04));
      const q3 = qRest.clone();
      const q4 = q0.clone();
      walkTracks.push(new THREE.QuaternionKeyframeTrack(spine.name + '.quaternion', timesWalk, [
        q0.x, q0.y, q0.z, q0.w,
        q1.x, q1.y, q1.z, q1.w,
        q2.x, q2.y, q2.z, q2.w,
        q3.x, q3.y, q3.z, q3.w,
        q4.x, q4.y, q4.z, q4.w
      ]));
    }

    const walkClip = new THREE.AnimationClip('Walk', 1.0, walkTracks);

    return { idleClip, walkClip };
  }

  setAnimation(name, duration = 0.5) {
    if (!this.actions || !this.actions[name]) return;
    const nextAction = this.actions[name];
    const prevAction = this.activeAction;
    if (prevAction === nextAction) return;

    // Reset and enable incoming action
    nextAction.reset();
    nextAction.enabled = true;
    nextAction.setEffectiveTimeScale(name === 'Walk' ? 0.65 : 1.0);
    nextAction.setEffectiveWeight(1.0);

    // Smoothly blend from previous action with warp: true for realistic weight transfer and synchronized phase
    if (prevAction) {
      nextAction.crossFadeFrom(prevAction, duration, true);
    }

    nextAction.play();
    this.activeAction = nextAction;
  }

  update(delta) {
    if (this.mixer && !this.figureFallen && this.show3DModel) {
      this.mixer.update(delta);
    }
    if (this.aiPose) {
      this.aiPose.update(delta);
    }
  }

  spawnSparks(point, isHit = true) {
    const sparkGroup = new THREE.Group();
    this.scene.add(sparkGroup);

    // Tactical micro-flash confirmation (bright electric cyan on hit, amber on miss)
    const flashColor = isHit ? 0x70d6ff : 0xffaa00;
    const flashLight = new THREE.PointLight(flashColor, isHit ? 3.0 : 1.2, 1.2);
    flashLight.position.copy(point);
    this.scene.add(flashLight);

    const colors = isHit ? [0xffffff, 0x70d6ff, 0x00f0ff, 0xffea00] : [0xffaa00, 0xff5500, 0xdddddd];
    const particleCount = isHit ? 16 : 8;
    const sparkGeo = new THREE.SphereGeometry(0.004, 4, 4);

    for (let i = 0; i < particleCount; i++) {
      const color = colors[Math.floor(Math.random() * colors.length)];
      const sparkMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 });
      const spark = new THREE.Mesh(sparkGeo, sparkMat);
      spark.position.copy(point);
      spark.userData.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.14,
        (Math.random() - 0.3) * 0.12,
        (Math.random() - 0.5) * 0.14
      );
      sparkGroup.add(spark);
    }

    let lifetime = 0;
    const sparkInt = setInterval(() => {
      lifetime++;
      sparkGroup.children.forEach((spark) => {
        spark.position.add(spark.userData.velocity);
        spark.userData.velocity.y -= 0.006;
        spark.scale.multiplyScalar(0.92);
        if (spark.material) spark.material.opacity = Math.max(0, 1.0 - (lifetime / 18));
      });

      if (flashLight.intensity > 0) {
        flashLight.intensity = Math.max(0, flashLight.intensity - 0.35);
      }

      if (lifetime > 20) {
        clearInterval(sparkInt);
        this.scene.remove(sparkGroup);
        this.scene.remove(flashLight);
        sparkGroup.traverse((c) => {
          if (c.geometry) c.geometry.dispose();
          if (c.material) c.material.dispose();
        });
      }
    }, 20);
  }

  spawnElectricArc(p1, p2, bothHitTarget = true) {
    if (!bothHitTarget) return;

    // Tactical high-voltage electric arc between probes confirming NMI circuit
    const segments = 10;
    const positions = new Float32Array((segments + 1) * 3);
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const arcMat = new THREE.LineBasicMaterial({
      color: 0x00f7ff,
      linewidth: 2,
      transparent: true,
      opacity: 0.95
    });

    const arcLine = new THREE.Line(arcGeo, arcMat);
    this.scene.add(arcLine);

    // Subtle tactile haptic confirmation
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([35, 25, 45]); } catch (_) {}
    }

    let tick = 0;
    const maxTicks = 12; // ~240ms duration
    const arcInt = setInterval(() => {
      tick++;
      const posArr = arcGeo.attributes.position.array;
      for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const x = p1.x + (p2.x - p1.x) * t + (i > 0 && i < segments ? (Math.random() - 0.5) * 0.045 : 0);
        const y = p1.y + (p2.y - p1.y) * t + (i > 0 && i < segments ? (Math.random() - 0.5) * 0.045 : 0);
        const z = p1.z + (p2.z - p1.z) * t + (i > 0 && i < segments ? (Math.random() - 0.5) * 0.045 : 0);
        posArr[i * 3] = x;
        posArr[i * 3 + 1] = y;
        posArr[i * 3 + 2] = z;
      }
      arcGeo.attributes.position.needsUpdate = true;
      arcMat.opacity = Math.random() * 0.5 + 0.5;

      if (tick >= maxTicks) {
        clearInterval(arcInt);
        this.scene.remove(arcLine);
        arcGeo.dispose();
        arcMat.dispose();
      }
    }, 20);
  }

  fireDarts({ ndc1, ndc2, chamber }) {
    const activeCamera = this.renderer.xr.isPresenting
      ? this.renderer.xr.getCamera(this.camera)
      : this.camera;

    // Determine active target group: Live AI Human Hitboxes (Camera AR) or 3D Target
    const activeTargetGroup = (this.aiPose && this.aiPose.isActive && this.aiPose.isPersonDetected)
      ? this.aiPose.hitboxGroup
      : this.taserGroup;

    // Raycast top dart
    this.raycaster.setFromCamera(new THREE.Vector2(ndc1.x, ndc1.y), activeCamera);
    this.raycaster.ray.direction.x += (Math.random() - 0.5) * 0.005;
    this.raycaster.ray.direction.y += (Math.random() - 0.5) * 0.005;
    let hits1 = this.raycaster.intersectObject(activeTargetGroup, true);
    let hitWall1 = false;
    if (hits1.length === 0) {
      hits1 = this.raycaster.intersectObject(this.placementGround, true);
      hitWall1 = true;
    }

    // Raycast bottom dart
    this.raycaster.setFromCamera(new THREE.Vector2(ndc2.x, ndc2.y), activeCamera);
    this.raycaster.ray.direction.x += (Math.random() - 0.5) * 0.005;
    this.raycaster.ray.direction.y += (Math.random() - 0.5) * 0.005;
    let hits2 = this.raycaster.intersectObject(activeTargetGroup, true);
    let hitWall2 = false;
    if (hits2.length === 0) {
      hits2 = this.raycaster.intersectObject(this.placementGround, true);
      hitWall2 = true;
    }

    if (hits1.length > 0 && hits2.length > 0) {
      const hit1 = hits1[0];
      const hit2 = hits2[0];

      // Physical dart meshes
      const dartGeo = new THREE.CylinderGeometry(0.005, 0.001, 0.08, 6);
      const dartMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.8, roughness: 0.2 });

      // Attach dart firmly to the exact hit anatomical mesh (e.g. torso, leg) so it moves with the person in 3D
      const attachGroup1 = (!hitWall1 && hit1.object) ? hit1.object : (hitWall1 ? this.scene : activeTargetGroup);
      const d1 = new THREE.Mesh(dartGeo, dartMat);
      d1.position.copy(attachGroup1.worldToLocal(hit1.point.clone()));
      d1.lookAt(attachGroup1.worldToLocal(activeCamera.position.clone()));
      attachGroup1.add(d1);
      this.activeDarts.push(d1);

      const attachGroup2 = (!hitWall2 && hit2.object) ? hit2.object : (hitWall2 ? this.scene : activeTargetGroup);
      const d2 = new THREE.Mesh(dartGeo, dartMat);
      d2.position.copy(attachGroup2.worldToLocal(hit2.point.clone()));
      d2.lookAt(attachGroup2.worldToLocal(activeCamera.position.clone()));
      attachGroup2.add(d2);
      this.activeDarts.push(d2);

      // Instant visual feedback: subtle spark burst + micro-flash + electric arc confirmation
      this.spawnSparks(hit1.point, !hitWall1);
      this.spawnSparks(hit2.point, !hitWall2);
      this.spawnElectricArc(hit1.point, hit2.point, !hitWall1 && !hitWall2);

      // Deploy insulated high-tensile copper-clad wire lines
      const wireMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });

      const geo1 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), hit1.point.clone()]);
      const wire1 = new THREE.Line(geo1, wireMat);
      this.scene.add(wire1);
      this.activeWires.push({ line: wire1, chamber, dart: d1 });

      const geo2 = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), hit2.point.clone()]);
      const wire2 = new THREE.Line(geo2, wireMat);
      this.scene.add(wire2);
      this.activeWires.push({ line: wire2, chamber, dart: d2 });

      return { hit1, hit2, hitWall1, hitWall2 };
    }

    return { hit1: null, hit2: null, hitWall1: true, hitWall2: true };
  }

  collapseTarget() {
    if (this.figureFallen || !this.taserGroup) return;
    this.figureFallen = true;

    // Fade out active animation action when collapsing
    if (this.activeAction) {
      this.activeAction.fadeOut(0.2);
    }

    if (this.fallInterval) clearInterval(this.fallInterval);
    let fallAngle = 0;
    this.fallInterval = setInterval(() => {
      fallAngle -= 0.08;
      this.taserGroup.rotation.x = fallAngle;
      if (fallAngle <= -Math.PI / 2 + 0.2) {
        clearInterval(this.fallInterval);
        this.fallInterval = null;
      }
    }, 20);
  }

  resetTarget() {
    if (this.fallInterval) {
      clearInterval(this.fallInterval);
      this.fallInterval = null;
    }
    this.figureFallen = false;
    if (this.taserGroup) {
      this.taserGroup.rotation.x = 0;
      if (this.taserGroup.userData.startPos) {
        this.taserGroup.position.copy(this.taserGroup.userData.startPos);
      }
    }
    this.clearWiresAndDarts();

    // Reset skeletal animation back to 'Idle'
    this.setAnimation('Idle', 0.2);
    if (this.actions['Idle']) {
      this.actions['Idle'].reset().play();
      this.activeAction = this.actions['Idle'];
    }
  }

  clearWiresAndDarts() {
    this.activeWires.forEach((w) => {
      this.scene.remove(w.line);
      if (w.line.geometry) w.line.geometry.dispose();
      if (w.line.material) w.line.material.dispose();
    });
    this.activeWires = [];

    this.activeDarts.forEach((d) => {
      if (d.parent) d.parent.remove(d);
      if (d.geometry) d.geometry.dispose();
      if (d.material) d.material.dispose();
    });
    this.activeDarts = [];
  }

  updateWireDynamics(activeCamera) {
    if (this.activeWires.length === 0) return;

    for (let i = 0; i < this.activeWires.length; i++) {
      const wire = this.activeWires[i];
      const offset = this._v1.set(wire.chamber === 1 ? -0.05 : 0.05, -0.15, -0.3);
      offset.applyQuaternion(activeCamera.quaternion);
      const origin = this._v2.copy(activeCamera.position).add(offset);

      wire.dart.getWorldPosition(this._v3);

      const positions = wire.line.geometry.attributes.position.array;
      positions[0] = origin.x;
      positions[1] = origin.y;
      positions[2] = origin.z;
      positions[3] = this._v3.x;
      positions[4] = this._v3.y;
      positions[5] = this._v3.z;
      wire.line.geometry.attributes.position.needsUpdate = true;
    }
  }

  enableARMode() {
    this.scene.background = null;
    if (this.renderer) {
      this.renderer.setClearColor(0x000000, 0);
    }
    setTimeout(() => this.onResize(), 50);
  }

  disableARMode() {
    this.scene.background = this.defaultBackground;
    if (this.renderer) {
      this.renderer.setClearColor(0x0a0a0a, 1.0);
    }
    setTimeout(() => this.onResize(), 50);
  }

  set3DVisibility(isVisible) {
    this.show3DModel = isVisible;
    if (this.taserGroup) {
      this.taserGroup.visible = isVisible;
      this.taserGroup.traverse((child) => {
        if (child.isMesh) {
          // If GLTF mannequin is loaded, keep the procedural box dummyBody hidden
          if (this.hasGLBMannequin && child === this.dummyBody) {
            child.visible = false;
            return;
          }
          // Knife visibility is controlled separately by threat escalation
          if (child === this.knifeMesh || (child.parent && child.parent === this.knifeMesh)) {
            return;
          }
          child.visible = isVisible;
          if (child.material) {
            child.material.colorWrite = true;
            if (child.material.opacity === 0) {
              child.material.opacity = 1.0;
            }
          }
        }
      });
    }
  }

  createArcGlowTexture() {
    if (this._arcGlowTexture) return this._arcGlowTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
    grad.addColorStop(0.2, 'rgba(180, 245, 255, 0.95)');
    grad.addColorStop(0.45, 'rgba(0, 220, 255, 0.6)');
    grad.addColorStop(0.8, 'rgba(0, 160, 255, 0.15)');
    grad.addColorStop(1.0, 'rgba(0, 120, 255, 0.0)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    this._arcGlowTexture = new THREE.CanvasTexture(canvas);
    this._arcGlowTexture.colorSpace = THREE.SRGBColorSpace;
    return this._arcGlowTexture;
  }

  setupWarningArc() {
    this.warningArcActive = false;
    this.warningArcSegments = 14;

    // Pre-allocated Vector3 curve points for zero heap allocation in render loop
    this.curvePoints = Array.from({ length: this.warningArcSegments + 1 }, () => new THREE.Vector3());

    // 1. Procedural TASER 7 Muzzle Housing & Physical Electrode Pins
    // Local coordinates: positioned at x = ±0.045, y = -0.038, z = -0.22 in front of camera
    this.muzzleModel = new THREE.Group();
    this.muzzleModel.name = 'Taser7_MuzzleAssembly';
    this.muzzleModel.frustumCulled = false;

    const pinGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.016, 8);
    const pinMat = new THREE.MeshStandardMaterial({
      color: 0xeeeeee,
      metalness: 0.95,
      roughness: 0.15,
      depthTest: false,
      depthWrite: false
    });

    const leftPin = new THREE.Mesh(pinGeo, pinMat);
    leftPin.position.set(-0.045, -0.038, -0.22);
    leftPin.rotation.x = Math.PI / 2;
    leftPin.frustumCulled = false;
    leftPin.renderOrder = 998;
    this.muzzleModel.add(leftPin);

    const rightPin = new THREE.Mesh(pinGeo, pinMat);
    rightPin.position.set(0.045, -0.038, -0.22);
    rightPin.rotation.x = Math.PI / 2;
    rightPin.frustumCulled = false;
    rightPin.renderOrder = 998;
    this.muzzleModel.add(rightPin);

    // Yellow cartridge bay hoods
    const hoodMat = new THREE.MeshStandardMaterial({
      color: 0xf1c40f,
      roughness: 0.35,
      metalness: 0.25,
      depthTest: false,
      depthWrite: false
    });
    const leftHood = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.018, 0.022), hoodMat);
    leftHood.position.set(-0.045, -0.048, -0.224);
    leftHood.frustumCulled = false;
    leftHood.renderOrder = 998;
    this.muzzleModel.add(leftHood);

    const rightHood = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.018, 0.022), hoodMat);
    rightHood.position.set(0.045, -0.048, -0.224);
    rightHood.frustumCulled = false;
    rightHood.renderOrder = 998;
    this.muzzleModel.add(rightHood);

    // Matte black composite frame bridge
    const bridgeMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      roughness: 0.8,
      metalness: 0.2,
      depthTest: false,
      depthWrite: false
    });
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.014, 0.02), bridgeMat);
    bridge.position.set(0, -0.048, -0.226);
    bridge.frustumCulled = false;
    bridge.renderOrder = 998;
    this.muzzleModel.add(bridge);

    this.muzzleModel.visible = false;
    this.taserModel.add(this.muzzleModel);

    // 2. Initial Straight Baseline Curve Points
    const xL = -0.045, yL = -0.038, zL = -0.22;
    const xR = 0.045, yR = -0.038, zR = -0.22;
    for (let i = 0; i <= this.warningArcSegments; i++) {
      const t = i / this.warningArcSegments;
      this.curvePoints[i].set(xL + (xR - xL) * t, yL, zL);
    }
    const initialCurve = new THREE.CatmullRomCurve3(this.curvePoints);

    // 3. Volumetric Outer Cyan Glow Tube (THREE.Mesh + THREE.TubeGeometry)
    // Physical 3D volume (8.4mm diameter) completely bypasses WebGL 1-pixel line restriction!
    this.warningArcTubeGeo = new THREE.TubeGeometry(initialCurve, 14, 0.0042, 8, false);
    this.warningArcTubeMat = new THREE.MeshBasicMaterial({
      color: 0x00f7ff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });
    this.warningArcTubeMesh = new THREE.Mesh(this.warningArcTubeGeo, this.warningArcTubeMat);
    this.warningArcTubeMesh.visible = false;
    this.warningArcTubeMesh.renderOrder = 999;
    this.warningArcTubeMesh.frustumCulled = false;
    this.taserModel.add(this.warningArcTubeMesh);

    // 4. Volumetric Inner Pure White Plasma Core Tube (4.4mm diameter)
    // Uses NormalBlending with opacity 1.0 to guarantee solid 1.0 alpha write for WebXR alpha compositing
    this.warningArcCoreTubeGeo = new THREE.TubeGeometry(initialCurve, 14, 0.0022, 8, false);
    this.warningArcCoreTubeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.NormalBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });
    this.warningArcCoreTubeMesh = new THREE.Mesh(this.warningArcCoreTubeGeo, this.warningArcCoreTubeMat);
    this.warningArcCoreTubeMesh.visible = false;
    this.warningArcCoreTubeMesh.renderOrder = 1000;
    this.warningArcCoreTubeMesh.frustumCulled = false;
    this.taserModel.add(this.warningArcCoreTubeMesh);

    // 5. High-Voltage Corona Sprite Cluster (Lysande THREE.Sprite orbs)
    this.arcSpriteGroup = new THREE.Group();
    this.arcSpriteGroup.name = 'ArcGlowSpriteCluster';
    this.arcSpriteGroup.frustumCulled = false;
    this.arcSpriteGroup.visible = false;

    const glowTex = this.createArcGlowTexture();
    this.arcSpriteMat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xaaffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });

    this.arcSprites = [];
    const spriteCount = 5;
    for (let s = 0; s < spriteCount; s++) {
      const sprite = new THREE.Sprite(this.arcSpriteMat);
      sprite.scale.set(0.035, 0.035, 1.0);
      sprite.renderOrder = 1001;
      sprite.frustumCulled = false;
      this.arcSpriteGroup.add(sprite);
      this.arcSprites.push(sprite);
    }
    this.taserModel.add(this.arcSpriteGroup);

    // 6. Dynamic flickering PointLight at muzzle
    this.warningArcLight = new THREE.PointLight(0x70d6ff, 0, 3.5, 2.0);
    this.warningArcLight.position.set(0, yL, zL + 0.01);
    this.taserModel.add(this.warningArcLight);
  }

  startWarningArc() {
    this.warningArcActive = true;
    if (this.warningArcTubeMesh) this.warningArcTubeMesh.visible = true;
    if (this.warningArcCoreTubeMesh) this.warningArcCoreTubeMesh.visible = true;
    if (this.muzzleModel) this.muzzleModel.visible = true;
    if (this.arcSpriteGroup) this.arcSpriteGroup.visible = true;
  }

  stopWarningArc() {
    this.warningArcActive = false;
    if (this.warningArcTubeMesh) this.warningArcTubeMesh.visible = false;
    if (this.warningArcCoreTubeMesh) this.warningArcCoreTubeMesh.visible = false;
    if (this.muzzleModel) this.muzzleModel.visible = false;
    if (this.arcSpriteGroup) this.arcSpriteGroup.visible = false;
    if (this.warningArcLight) this.warningArcLight.intensity = 0;
  }

  updateWarningArc(activeCamera) {
    if (activeCamera && this.taserModel) {
      this.taserModel.position.copy(activeCamera.position);
      this.taserModel.quaternion.copy(activeCamera.quaternion);
      this.taserModel.updateMatrixWorld(true);
    }

    if (!this.warningArcActive) return;

    // Local electrode coordinates on the Taser 7 muzzle
    const xL = -0.045;
    const yL = -0.038;
    const zL = -0.22;

    const xR = 0.045;
    const yR = -0.038;
    const zR = -0.22;

    const dx = xR - xL;
    const segs = this.warningArcSegments;

    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      let x = xL + dx * t;
      let y = yL;
      let z = zL;

      // Jitter intermediate discharge vertices with electrical convection rise
      if (i > 0 && i < segs) {
        const envelope = Math.sin(t * Math.PI); // 0 at electrodes, peak at midpoint
        const jitterMag = 0.016 * envelope;
        const jx = (Math.random() - 0.5) * (jitterMag * 0.45);
        const jy = (Math.random() - 0.5) * jitterMag + (Math.random() * 0.007 * envelope);
        const jz = (Math.random() - 0.5) * (jitterMag * 0.5);

        x += jx;
        y += jy;
        z += jz;
      }

      this.curvePoints[i].set(x, y, z);
    }

    const curve = new THREE.CatmullRomCurve3(this.curvePoints);

    // Dispose old tube geometries to prevent WebGL GPU memory leaks
    if (this.warningArcTubeMesh.geometry) {
      this.warningArcTubeMesh.geometry.dispose();
    }
    if (this.warningArcCoreTubeMesh.geometry) {
      this.warningArcCoreTubeMesh.geometry.dispose();
    }

    // Recreate volumetric 3D tubes with new jagged spline curve
    const tubeGeo = new THREE.TubeGeometry(curve, 14, 0.0042, 8, false);
    tubeGeo.computeBoundingSphere();
    this.warningArcTubeMesh.geometry = tubeGeo;
    this.warningArcTubeMesh.frustumCulled = false;

    const coreGeo = new THREE.TubeGeometry(curve, 14, 0.0022, 8, false);
    coreGeo.computeBoundingSphere();
    this.warningArcCoreTubeMesh.geometry = coreGeo;
    this.warningArcCoreTubeMesh.frustumCulled = false;

    // Position corona billboard sprites at discharge nodes
    if (this.arcSprites && this.arcSprites.length > 0) {
      const nodeIndices = [0, 3, 7, 11, 14];
      for (let s = 0; s < this.arcSprites.length; s++) {
        const pIdx = nodeIndices[s];
        if (this.curvePoints[pIdx]) {
          this.arcSprites[s].position.copy(this.curvePoints[pIdx]);
          const scale = (s === 0 || s === this.arcSprites.length - 1)
            ? (Math.random() * 0.01 + 0.035) // intense electrode contact flare
            : (Math.random() * 0.015 + 0.028); // high-voltage spark orb
          this.arcSprites[s].scale.set(scale, scale, 1.0);
          this.arcSprites[s].material.opacity = Math.random() * 0.3 + 0.7;
          this.arcSprites[s].frustumCulled = false;
        }
      }
    }

    // High-voltage flicker: intensity fluctuates dynamically between 4.0 and 8.0
    this.warningArcLight.position.set(0, yL, zL + 0.01);
    this.warningArcLight.intensity = Math.random() * 4.0 + 4.0;
    this.warningArcLight.color.setHex(Math.random() > 0.2 ? 0x70d6ff : 0xffffff);

    // Modulate opacity slightly for authentic strobe feel
    this.warningArcTubeMat.opacity = Math.random() * 0.25 + 0.75;
  }

  onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
