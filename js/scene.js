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

    // Composite Procedural Dummy Mannequin (Fallback + Zones)
    this.setupFallbackMannequin();

    // Setup Knife for threat escalation
    this.setupKnife();

    // Floor and Placement Marker
    this.setupGroundAndMarker();

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

  spawnSparks(point) {
    const sparkGroup = new THREE.Group();
    this.scene.add(sparkGroup);
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const sparkGeo = new THREE.SphereGeometry(0.005, 4, 4);

    for (let i = 0; i < 15; i++) {
      const spark = new THREE.Mesh(sparkGeo, sparkMat);
      spark.position.copy(point);
      spark.userData.velocity = new THREE.Vector3(
        (Math.random() - 0.5) * 0.1,
        (Math.random() - 0.5) * 0.1,
        (Math.random() - 0.5) * 0.1
      );
      sparkGroup.add(spark);
    }

    let lifetime = 0;
    const sparkInt = setInterval(() => {
      lifetime++;
      sparkGroup.children.forEach((spark) => {
        spark.position.add(spark.userData.velocity);
        spark.userData.velocity.y -= 0.005;
        spark.scale.multiplyScalar(0.95);
      });
      if (lifetime > 30) {
        clearInterval(sparkInt);
        this.scene.remove(sparkGroup);
      }
    }, 30);
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

      const attachGroup1 = hitWall1 ? this.scene : activeTargetGroup;
      const d1 = new THREE.Mesh(dartGeo, dartMat);
      d1.position.copy(attachGroup1.worldToLocal(hit1.point.clone()));
      d1.lookAt(attachGroup1.worldToLocal(activeCamera.position.clone()));
      attachGroup1.add(d1);
      this.activeDarts.push(d1);

      const attachGroup2 = hitWall2 ? this.scene : activeTargetGroup;
      const d2 = new THREE.Mesh(dartGeo, dartMat);
      d2.position.copy(attachGroup2.worldToLocal(hit2.point.clone()));
      d2.lookAt(attachGroup2.worldToLocal(activeCamera.position.clone()));
      attachGroup2.add(d2);
      this.activeDarts.push(d2);

      this.spawnSparks(hit1.point);
      this.spawnSparks(hit2.point);

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

  set3DVisibility(isVisible) {
    this.show3DModel = isVisible;
    if (this.taserGroup) this.taserGroup.visible = isVisible;
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
