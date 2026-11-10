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
    this.batonMesh = null;
    this.placementGround = null;
    this.placementMarker = null;

    this.activeWires = [];
    this.activeDarts = [];
    this.figureFallen = false;
    this.isTased = false;
    this.fallVelocity = 0.0;
    this.groundImpactDone = false;
    this.onGroundImpactCallback = null;
    this.show3DModel = true;
    this.fallInterval = null;

    // Skeletal Animation System (Mixamo / UE Mannequin Pipeline)
    this.clock = new THREE.Clock();
    this.mixer = null;
    this.actions = {};
    this.activeAction = null;
    this.walkSpeed = 0.80; // Mathematically synchronized forward velocity (0.80 m/s = 1.20m stride / (1.2s clip / 0.80 timeScale)) to eliminate foot sliding
    this.aiPose = null; // AI-Based Person Pose & Dynamic Hitbox Engine

    // Procedural Bone Manipulation (Late Update arm override & threat posing)
    this.activeThreatWeapon = 'KNIFE'; // 'KNIFE' | 'BATON' | 'FISTS'
    this.armOverrideWeight = 0.0; // 0.0 = pure walk/idle animation, 1.0 = full attack posture
    this.proceduralTime = 0.0;
    this.cachedBones = {
      rUpperArm: null,
      rForearm: null,
      rHand: null,
      lUpperArm: null,
      lForearm: null,
      lHand: null
    };

    this.isSoftwareGl = false;
    this.raycaster = new THREE.Raycaster();
    this.placementRaycaster = new THREE.Raycaster();

    // Reusable math vectors and quaternions to ensure zero GC in animation loop
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._qBase = new THREE.Quaternion();
    this._qTarget = new THREE.Quaternion();
    this._qDelta = new THREE.Quaternion();
    this._euler = new THREE.Euler();

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

    // Setup Knife and Baton for threat escalation
    this.setupKnife();
    this.setupBaton();

    // Floor and Placement Marker
    this.setupGroundAndMarker();

    // High-Voltage Warning Arc (Three.js 3D Dynamic Arc)
    this.setupWarningArc();

    // 3D Laser Raycast Sights (Dynamic dual green dots in WebXR AR space)
    this.setup3DLaserSights();

    // Load Retopologized UE Mannequin if available
    this.loadGLBMannequin();

    // Window & container resize observer
    window.addEventListener('resize', this.onResize.bind(this));
    window.addEventListener('orientationchange', () => setTimeout(() => this.onResize(), 100));
    if (typeof ResizeObserver !== 'undefined' && this.container) {
      const ro = new ResizeObserver(() => this.onResize());
      ro.observe(this.container);
      if (this.container.parentElement) ro.observe(this.container.parentElement);
    }
    // Mobile layout calibration
    requestAnimationFrame(() => this.onResize());
    setTimeout(() => this.onResize(), 120);
  }

  setupFallbackMannequin() {
    const greenMat = new THREE.MeshStandardMaterial({
      color: 0x219653,
      roughness: 0.88,
      metalness: 0.05
    });
    const dummyBody = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.3), greenMat);
    dummyBody.position.set(0, 0.7, 0);
    dummyBody.castShadow = true;
    dummyBody.receiveShadow = true;
    dummyBody.name = 'Godkand_Zon';
    this.taserGroup.add(dummyBody);
    this.dummyBody = dummyBody;

    // Invisible Hitbox Material for Raycasting ballistics:
    // visible = true so Three.js Raycaster still traverses the geometry and detects hits on
    // 'Huvud/Hals', 'Hjärttrakten', and 'Genitalier', but transparent: true with opacity: 0 and colorWrite: false
    // ensures ABSOLUTELY ZERO pixels are rendered to the screen (no floating balloons or boxes).
    const createInvisibleHitboxMat = () => new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      colorWrite: false
    });

    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 16), createInvisibleHitboxMat());
    headMesh.position.set(0, 1.63, 0.0);
    headMesh.name = 'Huvud/Hals';
    headMesh.userData.isHitbox = true;
    headMesh.castShadow = false;
    this.taserGroup.add(headMesh);
    this.headHitbox = headMesh;

    // Upper Chest / Cardiac Danger Zone (strictly heart/sternum, completely clear of shoulders and abdomen)
    // Width 0.13m (X: -0.065 to +0.065m), Height 0.17m (Y: 1.275 to 1.445m), Depth 0.14m (Z: 0.00 to 0.14m)
    const chestMesh = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.17, 0.14), createInvisibleHitboxMat());
    chestMesh.position.set(0, 1.36, 0.07);
    chestMesh.name = 'Hjärttrakten';
    chestMesh.userData.isHitbox = true;
    chestMesh.castShadow = false;
    this.taserGroup.add(chestMesh);
    this.chestHitbox = chestMesh;

    // Groin / Genitalier Danger Zone (compact pubic triangle cup, completely clear of hips, thighs, and abdomen)
    // Width 0.07m (X: -0.035 to +0.035m), Height 0.08m (Y: 0.80 to 0.88m), Depth 0.08m (Z: 0.01 to 0.09m)
    const groinMesh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.08), createInvisibleHitboxMat());
    groinMesh.position.set(0, 0.84, 0.05);
    groinMesh.name = 'Genitalier';
    groinMesh.userData.isHitbox = true;
    groinMesh.castShadow = false;
    this.taserGroup.add(groinMesh);
    this.groinHitbox = groinMesh;
  }

  setupKnife() {
    const knifeGroup = new THREE.Group();
    knifeGroup.name = 'TacticalKnife';

    // Bright high-visibility neon red MeshBasicMaterial as explicitly instructed
    const neonRedMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });

    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.04, 0.16, 0.05),
      neonRedMat
    );
    handle.position.y = -0.05;
    knifeGroup.add(handle);

    const guard = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.02, 0.10),
      neonRedMat
    );
    guard.position.y = 0.035;
    knifeGroup.add(guard);

    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.02, 0.35, 0.08),
      neonRedMat
    );
    blade.position.y = 0.22;
    knifeGroup.add(blade);

    // Explicit high-visibility scale and position offset
    knifeGroup.scale.set(10, 10, 10);
    knifeGroup.position.set(0.5, 0.5, 0.5);
    knifeGroup.visible = true;

    this.knifeMesh = knifeGroup;
    this.taserGroup.add(knifeGroup);
  }

  setupBaton() {
    const batonGroup = new THREE.Group();
    batonGroup.name = 'TacticalBaton';

    const neonRedMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.60, 16),
      neonRedMat
    );
    shaft.position.y = 0.22;
    batonGroup.add(shaft);

    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 16, 16),
      neonRedMat
    );
    tip.position.y = 0.52;
    batonGroup.add(tip);

    // Explicit high-visibility scale and position offset
    batonGroup.scale.set(10, 10, 10);
    batonGroup.position.set(0.5, 0.5, 0.5);
    batonGroup.visible = false;

    this.batonMesh = batonGroup;
    this.taserGroup.add(batonGroup);
  }

  setThreatWeapon(type = 'KNIFE') {
    this.activeThreatWeapon = (type || 'KNIFE').toUpperCase();
    this.updateWeaponVisibility();
  }

  updateWeaponVisibility() {
    const isKniv = this.activeThreatWeapon === 'KNIFE';
    const isBaton = this.activeThreatWeapon === 'BATON';

    // Guaranteed visibility: active weapon is always visible when selected
    if (this.knifeMesh) {
      this.knifeMesh.visible = isKniv;
    }
    if (this.batonMesh) {
      this.batonMesh.visible = isBaton;
    }
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

        // Check if the GLTF contains multiple distinct sub-meshes or a monolithic SkinnedMesh
        let meshCount = 0;
        dummy.traverse((c) => {
          if (c.isMesh) meshCount++;
        });

        // Matte materials (high roughness so it looks like matte rubber/plastic police training dummy)
        const greenTrainingMat = new THREE.MeshStandardMaterial({
          color: 0x219653, // Tactical Training Green
          roughness: 0.88,
          metalness: 0.05
        });

        const yellowDangerMat = new THREE.MeshStandardMaterial({
          color: 0xf1c40f, // Safety Yellow
          roughness: 0.85,
          metalness: 0.05
        });

        // Sanitize bone names and configure mesh materials directly on the 3D model
        dummy.traverse((child) => {
          if (child.name) {
            child.name = child.name.replace(/\s+/g, '_');
          }

          if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;

            if (meshCount > 1) {
              // CASE A: Model with separate sub-meshes for limbs/head/torso/pelvis
              const nameLower = (child.name || '').toLowerCase();
              const isDangerZone = /head|huvud|neck|hals|chest|torso|spine|bröst|hjärta|heart|pelvis|hip|groin|ljumske|skrev/i.test(nameLower);

              if (isDangerZone) {
                child.material = yellowDangerMat.clone();
                child.name = 'Farlig_Zon';
              } else {
                child.material = greenTrainingMat.clone();
                child.name = 'Godkand_Zon';
              }
            } else {
              // CASE B: Monolithic SkinnedMesh (e.g. Unreal Engine Retopology Mannequin)
              // Paint anatomical target zones directly into the mesh geometry via vertex colors,
              // precisely matching the Taser 7 training target (image_9ab5cc6f.png):
              // 1. Head & Neck: Crown down to the neck base.
              // 2. Upper Chest / Cardiac Triangle: Strictly the upper chest between nipples and below collar,
              //    completely leaving shoulders, deltoids, and entire abdomen/belly GREEN.
              // 3. Groin: Compact pubic triangle cup, leaving hips, flanks, and thighs GREEN.
              const geometry = child.geometry;
              if (geometry && geometry.attributes && geometry.attributes.position) {
                const pos = geometry.attributes.position;
                const count = pos.count;
                const colors = new Float32Array(count * 3);

                const greenR = 0.129, greenG = 0.588, greenB = 0.325; // #219653 (Tactical Training Green)
                const yellowR = 0.945, yellowG = 0.768, yellowB = 0.059; // #f1c40f (Safety Yellow)

                for (let i = 0; i < count; i++) {
                  const x = pos.getX(i);
                  const y = pos.getY(i);
                  const z = pos.getZ(i);

                  // 1. Head & Neck:
                  // Head crown down to neck. Neck tapers into clavicle notch (|x| < 8.5cm, |z| < 9cm).
                  const isHead = (y > 156) || (y >= 147 && y <= 156 && Math.abs(x) < 8.5 && Math.abs(z) < 9.0);

                  // 2. Upper Chest / Cardiac Triangle (Taser 7 target bib):
                  // Strictly upper chest: y between 127 and 147 cm.
                  // Width stays medial to the shoulder deltoids (half-width <= 11.0cm).
                  // Front chest only: z > 4.0cm.
                  // Shoulders (|x| > 11.5cm) and entire abdomen (y < 127cm) are 100% GREEN!
                  const chestHalfWidth = (y > 143) ? 8.5 : ((y > 132) ? 11.0 : 8.5);
                  const isChest = (y >= 127 && y < 147 && Math.abs(x) < chestHalfWidth && z > 4.0);

                  // 3. Groin / Pubic cup:
                  // Small compact patch centered strictly at the groin (y between 80 and 89 cm, |x| < 4.2 cm, z > 3.5 cm).
                  // Hips, pelvis flanks, and thighs are 100% GREEN!
                  const isGroin = (y >= 80 && y <= 89 && Math.abs(x) < 4.2 && z > 3.5);

                  if (isHead || isChest || isGroin) {
                    colors[i * 3] = yellowR;
                    colors[i * 3 + 1] = yellowG;
                    colors[i * 3 + 2] = yellowB;
                  } else {
                    colors[i * 3] = greenR;
                    colors[i * 3 + 1] = greenG;
                    colors[i * 3 + 2] = greenB;
                  }
                }

                geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
              }

              child.material = new THREE.MeshStandardMaterial({
                vertexColors: true,
                roughness: 0.88, // Matt plast/gummi
                metalness: 0.05
              });
              child.name = 'Godkand_Zon';
            }
          }
        });

        // Cache bones for Procedural Bone Manipulation (Late Update)
        this.cacheBones(dummy);

        // 1. SÄKER TRAVERSERING AV HÄNDER
        let handBone = null;
        dummy.traverse((c) => {
          if (!handBone && c.name) {
            const raw = c.name;
            const normalized = raw.replace(/\s+/g, '_').toLowerCase();
            if (
              normalized.includes('mixamorigrighthand') ||
              normalized.includes('r_hand') ||
              normalized.includes('rhand') ||
              normalized.includes('right_hand') ||
              normalized.includes('righthand') ||
              normalized.includes('hand_r') ||
              normalized.includes('handr')
            ) {
              handBone = c;
              console.log('[TaserScene] Confirmed right hand bone via traverse:', raw);
            }
          }
        });

        if (handBone) {
          // Explicit large scale and offset from hand bone to guarantee visibility
          if (this.knifeMesh) {
            if (this.knifeMesh.parent) this.knifeMesh.parent.remove(this.knifeMesh);
            this.knifeMesh.scale.set(10, 10, 10);
            this.knifeMesh.position.set(0.5, 0.5, 0.5);
            handBone.add(this.knifeMesh);
          }
          if (this.batonMesh) {
            if (this.batonMesh.parent) this.batonMesh.parent.remove(this.batonMesh);
            this.batonMesh.scale.set(10, 10, 10);
            this.batonMesh.position.set(0.5, 0.5, 0.5);
            handBone.add(this.batonMesh);
          }
        } else {
          // Fallback: If right hand bone cannot be confirmed, leave weapons safely in the root group (taserGroup)
          console.warn('[TaserScene] Right hand bone NOT confirmed! Keeping weapons in figure root group.');
          if (this.knifeMesh) {
            if (this.knifeMesh.parent) this.knifeMesh.parent.remove(this.knifeMesh);
            this.knifeMesh.scale.set(10, 10, 10);
            this.knifeMesh.position.set(0.5, 1.2, 0.5);
            this.taserGroup.add(this.knifeMesh);
          }
          if (this.batonMesh) {
            if (this.batonMesh.parent) this.batonMesh.parent.remove(this.batonMesh);
            this.batonMesh.scale.set(10, 10, 10);
            this.batonMesh.position.set(0.5, 1.2, 0.5);
            this.taserGroup.add(this.batonMesh);
          }
        }

        this.glbDummy = dummy;
        this.hasGLBMannequin = true;
        this.taserGroup.add(dummy);
        if (this.dummyBody) this.dummyBody.visible = false;

        // Setup Skeletal Animations (Mixamo/UE Pipeline)
        this.setupAnimations(dummy, gltf.animations || []);
        console.log('[TaserScene] UE Mannequin retopology 3D model with skeletal animations and procedural bone rigging loaded.');
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
      action.timeScale = 0.80; // Calibrated with 1.20m stride to eliminate foot sliding (0.80 m/s)
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

    const zAxis = new THREE.Vector3(0, 0, 1);
    const xAxis = new THREE.Vector3(1, 0, 0);
    const yAxis = new THREE.Vector3(0, 1, 0);

    const makeRotTrack = (boneName, times, angles, axis = zAxis) => {
      const bone = bones[boneName];
      if (!bone) return null;
      const values = [];
      const qRest = bone.quaternion;
      for (let i = 0; i < angles.length; i++) {
        const q = qRest.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, angles[i]));
        values.push(q.x, q.y, q.z, q.w);
      }
      return new THREE.QuaternionKeyframeTrack(bone.name + '.quaternion', times, values);
    };

    const makePosTrack = (boneName, times, offsets) => {
      const bone = bones[boneName];
      if (!bone) return null;
      const values = [];
      const pRest = bone.position;
      for (let i = 0; i < offsets.length; i++) {
        values.push(pRest.x + offsets[i][0], pRest.y + offsets[i][1], pRest.z + offsets[i][2]);
      }
      return new THREE.VectorKeyframeTrack(bone.name + '.position', times, values);
    };

    // ==========================================
    // 1. IDLE CLIP (2.4s loop: grounded stance, natural breathing, knife at ready)
    // ==========================================
    const timesIdle = [0.0, 0.6, 1.2, 1.8, 2.4];
    const idleTracks = [];

    // Pelvis breathing & micro-sway
    const pIdlePos = makePosTrack('Bip001_Pelvis_03', timesIdle, [
      [0, 0, 0], [0, 0.005, 0], [0, 0, 0], [0, -0.003, 0], [0, 0, 0]
    ]);
    if (pIdlePos) idleTracks.push(pIdlePos);

    // Spine breathing expansion
    const sIdleRot = makeRotTrack('Bip001_Spine_04', timesIdle, [0, 0.035, 0, 0.02, 0], xAxis);
    if (sIdleRot) idleTracks.push(sIdleRot);

    // Head alert scanning
    const hIdleRot = makeRotTrack('Bip001_Head_055', timesIdle, [0, 0.03, 0, -0.03, 0], yAxis);
    if (hIdleRot) idleTracks.push(hIdleRot);

    // Right arm holding knife at ready
    const rArmIdle = makeRotTrack('Bip001_R_UpperArm_032', timesIdle, [0.42, 0.44, 0.42, 0.43, 0.42], zAxis);
    if (rArmIdle) idleTracks.push(rArmIdle);
    const rForearmIdle = makeRotTrack('Bip001_R_Forearm_033', timesIdle, [1.25, 1.28, 1.25, 1.27, 1.25], zAxis);
    if (rForearmIdle) idleTracks.push(rForearmIdle);

    // Left arm raised defensive guard
    const lArmIdle = makeRotTrack('Bip001_L_UpperArm_08', timesIdle, [-0.20, -0.22, -0.20, -0.21, -0.20], zAxis);
    if (lArmIdle) idleTracks.push(lArmIdle);
    const lForearmIdle = makeRotTrack('Bip001_L_Forearm_09', timesIdle, [0.60, 0.63, 0.60, 0.62, 0.60], zAxis);
    if (lForearmIdle) idleTracks.push(lForearmIdle);

    // Grounded stance legs (soft knees, wide stable base)
    const lThighIdle = makeRotTrack('Bip001_L_Thigh_057', timesIdle, [0.04, 0.04, 0.04, 0.04, 0.04], zAxis);
    if (lThighIdle) idleTracks.push(lThighIdle);
    const rThighIdle = makeRotTrack('Bip001_R_Thigh_061', timesIdle, [-0.04, -0.04, -0.04, -0.04, -0.04], zAxis);
    if (rThighIdle) idleTracks.push(rThighIdle);
    const lCalfIdle = makeRotTrack('Bip001_L_Calf_058', timesIdle, [-0.08, -0.08, -0.08, -0.08, -0.08], zAxis);
    if (lCalfIdle) idleTracks.push(lCalfIdle);
    const rCalfIdle = makeRotTrack('Bip001_R_Calf_062', timesIdle, [-0.08, -0.08, -0.08, -0.08, -0.08], zAxis);
    if (rCalfIdle) idleTracks.push(rCalfIdle);

    const idleClip = new THREE.AnimationClip('Idle', 2.4, idleTracks.filter(Boolean));

    // ==========================================
    // 2. WALK CLIP (1.2s loop: 2-step bipedal gait cycle, 1.20m stride)
    // Synchronized at 0.80 timeScale (1.50s effective duration -> v = 0.80 m/s)
    // ==========================================
    const timesWalk = [0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.05, 1.2];
    const walkTracks = [];

    // Pelvis vertical bounce (dip at double support, rise at midstance)
    const pelvisPos = makePosTrack('Bip001_Pelvis_03', timesWalk, [
      [0, -0.02, 0], [0, 0.01, 0], [0, 0.022, 0], [0, 0.0, 0],
      [0, -0.02, 0], [0, 0.01, 0], [0, 0.022, 0], [0, 0.0, 0], [0, -0.02, 0]
    ]);
    if (pelvisPos) walkTracks.push(pelvisPos);

    // Pelvis yaw swivel (hip forward with swinging leg)
    const pelvisYaw = makeRotTrack('Bip001_Pelvis_03', timesWalk, [
      0.07, 0.03, 0.0, -0.04, -0.07, -0.03, 0.0, 0.04, 0.07
    ], yAxis);
    if (pelvisYaw) walkTracks.push(pelvisYaw);

    // Left Thigh (Sagittal pitch on Z: heel strike -> stance -> toe off -> swing)
    const lThighWalk = makeRotTrack('Bip001_L_Thigh_057', timesWalk, [
      0.38, 0.20, 0.0, -0.22, -0.30, -0.15, 0.12, 0.36, 0.38
    ], zAxis);
    if (lThighWalk) walkTracks.push(lThighWalk);

    // Right Thigh (Phase shifted by 0.6s)
    const rThighWalk = makeRotTrack('Bip001_R_Thigh_061', timesWalk, [
      -0.30, -0.15, 0.12, 0.36, 0.38, 0.20, 0.0, -0.22, -0.30
    ], zAxis);
    if (rThighWalk) walkTracks.push(rThighWalk);

    // Left Calf (Knee flexion on Z during swing for ground clearance)
    const lCalfWalk = makeRotTrack('Bip001_L_Calf_058', timesWalk, [
      0.05, 0.12, 0.0, -0.10, -0.35, -0.85, -0.95, -0.18, 0.05
    ], zAxis);
    if (lCalfWalk) walkTracks.push(lCalfWalk);

    // Right Calf (Knee flexion on Z during swing, phase shifted)
    const rCalfWalk = makeRotTrack('Bip001_R_Calf_062', timesWalk, [
      -0.35, -0.85, -0.95, -0.18, 0.05, 0.12, 0.0, -0.10, -0.35
    ], zAxis);
    if (rCalfWalk) walkTracks.push(rCalfWalk);

    // Left Foot (Ankle pitch on Z: heel strike dorsiflexion -> flat -> push-off)
    const lFootWalk = makeRotTrack('Bip001_L_Foot_059', timesWalk, [
      0.16, 0.0, 0.0, -0.15, -0.32, 0.05, 0.0, 0.14, 0.16
    ], zAxis);
    if (lFootWalk) walkTracks.push(lFootWalk);

    // Right Foot (Phase shifted)
    const rFootWalk = makeRotTrack('Bip001_R_Foot_063', timesWalk, [
      -0.32, 0.05, 0.0, 0.14, 0.16, 0.0, 0.0, -0.15, -0.32
    ], zAxis);
    if (rFootWalk) walkTracks.push(rFootWalk);

    // Spine aggressive forward threat lean
    const spineLean = makeRotTrack('Bip001_Spine_04', timesWalk, [
      0.08, 0.07, 0.06, 0.07, 0.08, 0.07, 0.06, 0.07, 0.08
    ], zAxis);
    if (spineLean) walkTracks.push(spineLean);

    // Spine counter-swivel yaw (balances pelvis rotation)
    const spineYaw = makeRotTrack('Bip001_Spine_04', timesWalk, [
      -0.05, -0.02, 0.0, 0.03, 0.05, 0.02, 0.0, -0.03, -0.05
    ], yAxis);
    if (spineYaw) walkTracks.push(spineYaw);

    // Head stabilized towards target
    const headWalk = makeRotTrack('Bip001_Head_055', timesWalk, [
      0.02, 0.0, -0.02, 0.0, 0.02, 0.0, -0.02, 0.0, 0.02
    ], yAxis);
    if (headWalk) walkTracks.push(headWalk);

    // Right Arm: Knife held poised at ready with rhythmic muscular step tension
    const rArmWalk = makeRotTrack('Bip001_R_UpperArm_032', timesWalk, [
      0.45, 0.43, 0.41, 0.43, 0.45, 0.47, 0.49, 0.47, 0.45
    ], zAxis);
    if (rArmWalk) walkTracks.push(rArmWalk);
    const rForearmWalk = makeRotTrack('Bip001_R_Forearm_033', timesWalk, [
      1.25, 1.23, 1.20, 1.23, 1.25, 1.28, 1.30, 1.28, 1.25
    ], zAxis);
    if (rForearmWalk) walkTracks.push(rForearmWalk);

    // Left Arm: Counter-swing balancing opposite leg
    const lArmWalk = makeRotTrack('Bip001_L_UpperArm_08', timesWalk, [
      -0.24, -0.10, 0.10, 0.26, 0.32, 0.20, 0.0, -0.18, -0.24
    ], zAxis);
    if (lArmWalk) walkTracks.push(lArmWalk);
    const lForearmWalk = makeRotTrack('Bip001_L_Forearm_09', timesWalk, [
      0.35, 0.45, 0.55, 0.50, 0.40, 0.45, 0.55, 0.45, 0.35
    ], zAxis);
    if (lForearmWalk) walkTracks.push(lForearmWalk);

    const walkClip = new THREE.AnimationClip('Walk', 1.2, walkTracks.filter(Boolean));

    return { idleClip, walkClip };
  }

  setAnimation(name, duration = 0.8) {
    if (!this.actions || !this.actions[name]) return;
    const nextAction = this.actions[name];
    const prevAction = this.activeAction;
    if (prevAction === nextAction) return;

    // Reset and enable incoming action
    nextAction.reset();
    nextAction.enabled = true;
    nextAction.setEffectiveTimeScale(name === 'Walk' ? 0.80 : 1.0);
    nextAction.setEffectiveWeight(1.0);

    // Smoothly blend from previous action with warp: true for realistic weight transfer and synchronized phase
    if (prevAction) {
      prevAction.crossFadeTo(nextAction, duration, true);
    } else {
      nextAction.fadeIn(duration);
    }

    nextAction.play();
    this.activeAction = nextAction;
  }

  cacheBones(root) {
    this.cachedBones = {
      rUpperArm: null,
      rForearm: null,
      rHand: null,
      lUpperArm: null,
      lForearm: null,
      lHand: null,
      fingers: []
    };

    root.traverse((c) => {
      const rawName = c.name || '';
      const name = rawName.replace(/\s+/g, '_');

      // Right arm chain (supports Mixamo, UE Biped, and Generic rigs)
      if (!this.cachedBones.rUpperArm && (name === 'mixamorigRightArm' || name.includes('R_UpperArm') || name === 'RightArm')) {
        this.cachedBones.rUpperArm = c;
        c.userData.restQuaternion = c.quaternion.clone();
      }
      if (!this.cachedBones.rForearm && (name === 'mixamorigRightForeArm' || name.includes('R_Forearm') || name === 'RightForeArm')) {
        this.cachedBones.rForearm = c;
        c.userData.restQuaternion = c.quaternion.clone();
      }
      if (!this.cachedBones.rHand && (name === 'mixamorigRightHand' || name.includes('R_Hand') || name === 'RightHand')) {
        this.cachedBones.rHand = c;
        c.userData.restQuaternion = c.quaternion.clone();
      }

      // Left arm chain
      if (!this.cachedBones.lUpperArm && (name === 'mixamorigLeftArm' || name.includes('L_UpperArm') || name === 'LeftArm')) {
        this.cachedBones.lUpperArm = c;
        c.userData.restQuaternion = c.quaternion.clone();
      }
      if (!this.cachedBones.lForearm && (name === 'mixamorigLeftForeArm' || name.includes('L_Forearm') || name === 'LeftForeArm')) {
        this.cachedBones.lForearm = c;
        c.userData.restQuaternion = c.quaternion.clone();
      }
      if (!this.cachedBones.lHand && (name === 'mixamorigLeftHand' || name.includes('L_Hand') || name === 'LeftHand')) {
        this.cachedBones.lHand = c;
        c.userData.restQuaternion = c.quaternion.clone();
      }

      // Finger bones for tight clenched fists
      if (rawName && /Finger[0-9]/i.test(rawName) && !/Nub/i.test(rawName)) {
        this.cachedBones.fingers.push(c);
        c.userData.restQuaternion = c.quaternion.clone();
      }
    });

    console.log('[TaserScene] Cached arm bones for procedural manipulation:', {
      rUpperArm: this.cachedBones.rUpperArm?.name,
      rForearm: this.cachedBones.rForearm?.name,
      lUpperArm: this.cachedBones.lUpperArm?.name,
      lForearm: this.cachedBones.lForearm?.name,
      fingersCount: this.cachedBones.fingers.length
    });
  }

  applyProceduralArmPoses(delta, scenarioState = {}) {
    if (!this.cachedBones.rUpperArm) return;

    const rUpper = this.cachedBones.rUpperArm;
    const rFore = this.cachedBones.rForearm;
    const lUpper = this.cachedBones.lUpperArm;
    const lFore = this.cachedBones.lForearm;

    const restRU = rUpper.userData.restQuaternion || rUpper.quaternion;
    const restRF = rFore ? (rFore.userData.restQuaternion || rFore.quaternion) : null;
    const restLU = lUpper ? (lUpper.userData.restQuaternion || lUpper.quaternion) : null;
    const restLF = lFore ? (lFore.userData.restQuaternion || lFore.quaternion) : null;

    const isTasedOrFallen = this.isTased || this.figureFallen;

    // 1. NMI / VILA / FALLET: Släpp attacken omedelbart och slerpa alla ben tillbaka till vilopose
    if (isTasedOrFallen) {
      this.armOverrideWeight = THREE.MathUtils.damp(this.armOverrideWeight, 0.0, 10.0, delta);
      this.updateWeaponVisibility();

      const returnSpeed = Math.min(1.0, 8.5 * delta);
      rUpper.quaternion.slerp(restRU, returnSpeed);
      if (rFore && restRF) rFore.quaternion.slerp(restRF, returnSpeed);
      if (lUpper && restLU) lUpper.quaternion.slerp(restLU, returnSpeed);
      if (lFore && restLF) lFore.quaternion.slerp(restLF, returnSpeed);

      if (this.cachedBones.fingers && this.cachedBones.fingers.length > 0) {
        for (let i = 0; i < this.cachedBones.fingers.length; i++) {
          const f = this.cachedBones.fingers[i];
          if (f.userData.restQuaternion) {
            f.quaternion.slerp(f.userData.restQuaternion, returnSpeed);
          }
        }
      }
      return;
    }

    if (!this.show3DModel) {
      this.armOverrideWeight = 0;
      this.updateWeaponVisibility();
      return;
    }

    const isScenarioActive = !!scenarioState.isScenarioActive;
    const threatLevel = typeof scenarioState.threatLevel === 'number' ? scenarioState.threatLevel : 0;
    const isAttackActive = isScenarioActive && threatLevel >= 2;
    const targetWeight = isAttackActive ? 1.0 : 0.0;

    this.armOverrideWeight = THREE.MathUtils.damp(this.armOverrideWeight, targetWeight, 6.0, delta);
    this.updateWeaponVisibility();

    if (this.armOverrideWeight < 0.001) {
      const restSpeed = Math.min(1.0, 6.0 * delta);
      rUpper.quaternion.slerp(restRU, restSpeed);
      if (rFore && restRF) rFore.quaternion.slerp(restRF, restSpeed);
      if (lUpper && restLU) lUpper.quaternion.slerp(restLU, restSpeed);
      if (lFore && restLF) lFore.quaternion.slerp(restLF, restSpeed);

      if (this.cachedBones.fingers && this.cachedBones.fingers.length > 0) {
        for (let i = 0; i < this.cachedBones.fingers.length; i++) {
          const f = this.cachedBones.fingers[i];
          if (f.userData.restQuaternion) {
            f.quaternion.slerp(f.userData.restQuaternion, restSpeed);
          }
        }
      }
      return;
    }

    const isMixamo = (rUpper.name || '').toLowerCase().includes('mixamo');
    const weapon = (scenarioState.threatWeapon || this.activeThreatWeapon || 'KNIFE').toUpperCase();

    // =========================================================================
    // 1. KNYTNÄVAR / OBEVÄPNAD (SYMMETRISK BOXARGARD PÅ BÅDA SIDOR)
    // =========================================================================
    if (weapon === 'FISTS') {
      if (isMixamo) {
        // Mixamo Standard Rig:
        // Höger och vänster axel lyfts uppåt/framåt
        this._qDelta.setFromEuler(new THREE.Euler(0.85, -0.35, -0.20, 'XYZ'));
        this._qTarget.copy(restRU).multiply(this._qDelta);
        rUpper.quaternion.copy(rUpper.quaternion).slerp(this._qTarget, this.armOverrideWeight);

        if (rFore && restRF) {
          // Höger underarm: kraftig flexion (~95°) inåt/uppåt
          this._qDelta.setFromEuler(new THREE.Euler(0.0, 1.65, 0.0, 'XYZ'));
          this._qTarget.copy(restRF).multiply(this._qDelta);
          rFore.quaternion.copy(rFore.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }

        if (lUpper && restLU) {
          // Vänster axel: spegling
          this._qDelta.setFromEuler(new THREE.Euler(0.85, 0.35, 0.20, 'XYZ'));
          this._qTarget.copy(restLU).multiply(this._qDelta);
          lUpper.quaternion.copy(lUpper.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }

        if (lFore && restLF) {
          // Vänster underarm: speglad flexion
          this._qDelta.setFromEuler(new THREE.Euler(0.0, -1.65, 0.0, 'XYZ'));
          this._qTarget.copy(restLF).multiply(this._qDelta);
          lFore.quaternion.copy(lFore.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }
      } else {
        // UE Mannequin Biped Rig:
        // Transversell rotation runt lokal Z-axel:
        // Överarmar lyfts framåt/uppåt (-0.40 rad):
        this._qDelta.setFromAxisAngle(this._v1.set(0, 0, 1), -0.40);
        this._qTarget.copy(restRU).multiply(this._qDelta);
        rUpper.quaternion.copy(rUpper.quaternion).slerp(this._qTarget, this.armOverrideWeight);

        if (rFore && restRF) {
          // Höger armbåge böjs kraftigt inåt/uppåt (-1.45 rad / ~85 grader) framför hakan/bröstet
          this._qDelta.setFromAxisAngle(this._v1.set(0, 0, 1), -1.45);
          this._qTarget.copy(restRF).multiply(this._qDelta);
          rFore.quaternion.copy(rFore.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }

        if (lUpper && restLU) {
          // Vänster överarm lyfts symmetriskt (-0.40 rad)
          this._qDelta.setFromAxisAngle(this._v1.set(0, 0, 1), -0.40);
          this._qTarget.copy(restLU).multiply(this._qDelta);
          lUpper.quaternion.copy(lUpper.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }

        if (lFore && restLF) {
          // Vänster armbåge böjs symmetriskt inåt/uppåt (-1.45 rad)
          this._qDelta.setFromAxisAngle(this._v1.set(0, 0, 1), -1.45);
          this._qTarget.copy(restLF).multiply(this._qDelta);
          lFore.quaternion.copy(lFore.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }
      }

      // Knytnävar (Stängda fingrar):
      if (this.cachedBones.fingers && this.cachedBones.fingers.length > 0) {
        for (let i = 0; i < this.cachedBones.fingers.length; i++) {
          const f = this.cachedBones.fingers[i];
          const restF = f.userData.restQuaternion || f.quaternion;
          this._qDelta.setFromAxisAngle(this._v1.set(0, 0, 1), -0.65);
          this._qTarget.copy(restF).multiply(this._qDelta);
          f.quaternion.copy(f.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }
      }

    } else {
      // =========================================================================
      // 2. BEVÄPNAD (KNIV ELLER BATONG)
      // Höger arm pekar framåt med vapnet riktat mot målet
      // Vänster arm intar defensiv gard
      // =========================================================================
      if (isMixamo) {
        this._qDelta.setFromAxisAngle(this._v1.set(1, 0, 0), 0.45);
        this._qTarget.copy(restRU).multiply(this._qDelta);
        rUpper.quaternion.copy(rUpper.quaternion).slerp(this._qTarget, this.armOverrideWeight);

        if (rFore && restRF) {
          this._qDelta.setFromAxisAngle(this._v1.set(1, 0, 0), 0.30);
          this._qTarget.copy(restRF).multiply(this._qDelta);
          rFore.quaternion.copy(rFore.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }
      } else {
        // UE Biped:
        this._qDelta.setFromAxisAngle(this._v1.set(0, 0, 1), -0.35);
        this._qTarget.copy(restRU).multiply(this._qDelta);
        rUpper.quaternion.copy(rUpper.quaternion).slerp(this._qTarget, this.armOverrideWeight);

        if (rFore && restRF) {
          this._qDelta.setFromAxisAngle(this._v1.set(0, 0, 1), -0.30);
          this._qTarget.copy(restRF).multiply(this._qDelta);
          rFore.quaternion.copy(rFore.quaternion).slerp(this._qTarget, this.armOverrideWeight);
        }
      }

      // Släpp knutna fingrar tillbaka till neutralt grepp runt vapnet
      if (this.cachedBones.fingers && this.cachedBones.fingers.length > 0) {
        for (let i = 0; i < this.cachedBones.fingers.length; i++) {
          const f = this.cachedBones.fingers[i];
          if (f.userData.restQuaternion) {
            f.quaternion.slerp(f.userData.restQuaternion, Math.min(1.0, 6.0 * delta));
          }
        }
      }
    }
  }

  update(delta, scenarioState = {}) {
    if (this.isTased && this.taserGroup) {
      // PROCEDURAL STIFF FALL (TRÄDFALLET)
      // When NMI is triggered, mixer is frozen (timeScale = 0).
      // Rotate whole taserGroup backwards around heels smoothly with gravitational acceleration:
      this.updateStiffFall(delta);

      // Smoothly relax arms to neutral resting pose flat along torso sides so they don't point up in the air
      this.applyProceduralArmPoses(delta, scenarioState);
    } else if (this.mixer && !this.figureFallen && this.show3DModel) {
      // 1. Advance base keyframe skeletal animation
      this.mixer.update(delta);

      // 2. PROCEDURAL BONE MANIPULATION (LATE UPDATE)
      // Runs EXPLICITLY after mixer.update(delta) has evaluated animation clips,
      // but BEFORE scene rendering, safely blending the arms into attack poses
      // while lower body walking/stride continues uninterrupted!
      this.applyProceduralArmPoses(delta, scenarioState);
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
      const wireMat = new THREE.LineBasicMaterial({
        color: 0xB87333, // Realistisk kopparfärg
        transparent: true,
        opacity: 0.95
      });

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

  triggerNMI(onImpact) {
    if (this.isTased) return;
    this.isTased = true;
    this.figureFallen = true;
    this.groundImpactDone = false;
    this.fallVelocity = 0.0;
    this.onGroundImpactCallback = onImpact;

    // 1. FREEZE ANIMATION MIXER IMMEDIATELY (Muskellåsning)
    // Tetanic muscle lock: freeze animation in the exact current frame (boxer guard, knife thrust, running)
    if (this.mixer) {
      this.mixer.timeScale = 0.0;
    }

    // 2. Cache starting position before fall
    if (this.taserGroup) {
      if (!this.taserGroup.userData.preFallPos) {
        this.taserGroup.userData.preFallPos = this.taserGroup.position.clone();
      } else {
        this.taserGroup.userData.preFallPos.copy(this.taserGroup.position);
      }
    }
  }

  updateStiffFall(delta) {
    if (!this.isTased || !this.taserGroup) return;

    const targetAngle = -Math.PI / 2; // Flat on back (-90 degrees)
    const currentAngle = this.taserGroup.rotation.x;

    if (currentAngle > targetAngle + 0.005) {
      // Gravitational acceleration: angular velocity increases as center of mass shifts backwards
      const progress = Math.abs(currentAngle) / (Math.PI / 2); // 0 to 1
      const gravAccel = 4.2 + Math.sin(progress * Math.PI * 0.5) * 11.5; // rad/s^2
      this.fallVelocity += gravAccel * delta;

      let nextAngle = currentAngle - this.fallVelocity * delta;
      if (nextAngle <= targetAngle) {
        nextAngle = targetAngle;
        if (!this.groundImpactDone) {
          this.groundImpactDone = true;
          this.onGroundImpact();
        }
      }
      this.taserGroup.rotation.x = nextAngle;

      // WebXR AR Pivot & Floor Offset compensation:
      // När figuren faller runt sin mittpunkt roteras den så att kroppen annars skär genom golvet.
      // Genom att applicera en dynamisk Y-offset (-fallProgress * 0.5) landar figuren plant OVANPÅ golvet.
      const fallProgress = Math.min(1.0, Math.abs(nextAngle) / (Math.PI / 2));
      const basePos = this.taserGroup.userData.preFallPos || this.taserGroup.userData.startPos || this._v1.set(0, 0, 0);

      // Dynamisk Y-offset i lerp-loopen:
      this.taserGroup.position.y = basePos.y - fallProgress * 0.5;

      // Håll hälarna fixerade vid marken som rotationsaxel längs Z:
      const zOffset = -fallProgress * 0.35;
      this.taserGroup.position.z = basePos.z + zOffset;
    } else {
      // Fully settled flat on the floor
      this.taserGroup.rotation.x = targetAngle;
      const basePos = this.taserGroup.userData.preFallPos || this.taserGroup.userData.startPos || this._v1.set(0, 0, 0);
      this.taserGroup.position.y = basePos.y - 0.5;
      this.taserGroup.position.z = basePos.z - 0.35;
    }
  }

  onGroundImpact() {
    // Tactile haptic floor impact
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate([60, 30, 80]); } catch (_) {}
    }
    if (this.onGroundImpactCallback) {
      this.onGroundImpactCallback();
    }
  }

  collapseTarget(onImpact) {
    this.triggerNMI(onImpact);
  }

  resetTarget() {
    if (this.fallInterval) {
      clearInterval(this.fallInterval);
      this.fallInterval = null;
    }
    this.isTased = false;
    this.figureFallen = false;
    this.groundImpactDone = false;
    this.fallVelocity = 0.0;
    this.armOverrideWeight = 0;
    this.updateWeaponVisibility();

    if (this.taserGroup) {
      this.taserGroup.rotation.x = 0;
      this.taserGroup.rotation.y = 0;
      this.taserGroup.rotation.z = 0;
      const startPos = this.taserGroup.userData.startPos || new THREE.Vector3(0, 0, 0);
      this.taserGroup.position.copy(startPos);
      if (this.taserGroup.userData.preFallPos) {
        this.taserGroup.userData.preFallPos.copy(startPos);
      }
    }
    this.clearWiresAndDarts();
    if (this.laserDotTop) this.laserDotTop.visible = false;
    if (this.laserDotBottom) this.laserDotBottom.visible = false;

    // 5. Återställning: Dra ur pilar, nollställ fall och sätt igång AnimationMixer igen (timeScale = 1.0)
    if (this.mixer) {
      this.mixer.timeScale = 1.0;
    }

    // Reset arm bones explicitly to cached rest quaternions
    if (this.cachedBones) {
      if (this.cachedBones.rUpperArm && this.cachedBones.rUpperArm.userData.restQuaternion) {
        this.cachedBones.rUpperArm.quaternion.copy(this.cachedBones.rUpperArm.userData.restQuaternion);
      }
      if (this.cachedBones.rForearm && this.cachedBones.rForearm.userData.restQuaternion) {
        this.cachedBones.rForearm.quaternion.copy(this.cachedBones.rForearm.userData.restQuaternion);
      }
      if (this.cachedBones.lUpperArm && this.cachedBones.lUpperArm.userData.restQuaternion) {
        this.cachedBones.lUpperArm.quaternion.copy(this.cachedBones.lUpperArm.userData.restQuaternion);
      }
      if (this.cachedBones.lForearm && this.cachedBones.lForearm.userData.restQuaternion) {
        this.cachedBones.lForearm.quaternion.copy(this.cachedBones.lForearm.userData.restQuaternion);
      }
    }

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
          // Keep Raycasting hitboxes 100% invisible to the user at all times
          if (child.userData && child.userData.isHitbox) {
            if (child.material) {
              child.material.transparent = true;
              child.material.opacity = 0.0;
              child.material.colorWrite = false;
              child.material.depthWrite = false;
            }
            return;
          }
          // If GLTF mannequin is loaded, keep the procedural box dummyBody hidden
          if (this.hasGLBMannequin && child === this.dummyBody) {
            child.visible = false;
            return;
          }
          // Knife and Baton visibility is controlled separately by threat escalation
          if (
            child === this.knifeMesh || (child.parent && child.parent === this.knifeMesh) ||
            child === this.batonMesh || (child.parent && child.parent === this.batonMesh)
          ) {
            return;
          }
          child.visible = isVisible;
          if (child.material) {
            child.material.colorWrite = true;
            child.material.opacity = 1.0;
          }
        }
      });
      this.updateWeaponVisibility();
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

  setup3DLaserSights() {
    // 3D Laser Mesh: Bright luminous green dots projected onto 3D mannequin surfaces in WebXR/3D space
    const dotGeo = new THREE.SphereGeometry(0.016, 16, 16);

    const topMat = new THREE.MeshBasicMaterial({
      color: 0x00ff00, // Grön laser
      depthTest: false,
      transparent: true,
      opacity: 0.95
    });
    this.laserDotTop = new THREE.Mesh(dotGeo, topMat);
    this.laserDotTop.name = '3D_Laser_Dot_Top';
    this.laserDotTop.renderOrder = 9999;
    this.laserDotTop.frustumCulled = false;
    this.laserDotTop.visible = false;
    this.scene.add(this.laserDotTop);

    const bottomMat = new THREE.MeshBasicMaterial({
      color: 0x00ff00, // Grön laser
      depthTest: false,
      transparent: true,
      opacity: 0.95
    });
    this.laserDotBottom = new THREE.Mesh(dotGeo, bottomMat);
    this.laserDotBottom.name = '3D_Laser_Dot_Bottom';
    this.laserDotBottom.renderOrder = 9999;
    this.laserDotBottom.frustumCulled = false;
    this.laserDotBottom.visible = false;
    this.scene.add(this.laserDotBottom);
  }

  updateDynamicLaserRaycast(camera, aimNDC = { x: 0, y: 0 }, activeChamber = 1, calculateSpreadFn = null, shouldShow = true) {
    if (!shouldShow || !this.taserGroup || !this.taserGroup.visible || !this.laserDotTop || !this.laserDotBottom) {
      if (this.laserDotTop) this.laserDotTop.visible = false;
      if (this.laserDotBottom) this.laserDotBottom.visible = false;
      return null;
    }

    // Uppdatera Raycaster från kamerans aktuella position och vinkel i rummet
    this.raycaster.setFromCamera(aimNDC, camera);

    // Kasta stråle mot målfiguren (taserGroup)
    const intersects = this.raycaster.intersectObject(this.taserGroup, true);
    // Filtrera bort icke-synliga objekt och hjälpare
    const validHit = intersects.find((hit) => {
      const obj = hit.object;
      return obj.visible &&
             obj.name !== 'PlacementMarker' &&
             !obj.name.includes('Helper') &&
             !obj.name.includes('Laser') &&
             !obj.name.includes('Arc');
    });

    if (validHit) {
      const hitPoint = validHit.point;
      const hitNormal = validHit.face
        ? validHit.face.normal.clone().transformDirection(validHit.object.matrixWorld).normalize()
        : this._v2.set(0, 0, 1);

      const dist = camera.position.distanceTo(hitPoint);

      // Kalkylera laserns spridning dynamiskt utifrån avståndet mellan camera.position och träffpunkten
      let spreadMeters = 0.34;
      if (typeof calculateSpreadFn === 'function') {
        const spreadData = calculateSpreadFn(dist, activeChamber);
        spreadMeters = spreadData.spreadCm / 100;
      } else {
        const angleRad = (activeChamber === 2 ? 3.5 : 12.0) * (Math.PI / 180);
        spreadMeters = Math.max(0.04, dist * Math.tan(angleRad));
      }

      // Placera övre laserpricken vid träffpunkten (med mikroskopisk offset längs normalen så den inte klipper)
      this.laserDotTop.position.copy(hitPoint).addScaledVector(hitNormal, 0.005);
      this.laserDotTop.visible = true;

      // Placera undre laserpricken: Går användaren närmare kryper prickarna ihop (mindre spreadMeters)
      this.laserDotBottom.position.set(hitPoint.x, hitPoint.y - spreadMeters, hitPoint.z).addScaledVector(hitNormal, 0.005);
      this.laserDotBottom.visible = true;

      // Skala prickarna baserat på avstånd för skarp synlighet
      const dotScale = Math.max(0.6, Math.min(2.0, dist * 0.4));
      this.laserDotTop.scale.set(dotScale, dotScale, dotScale);
      this.laserDotBottom.scale.set(dotScale, dotScale, dotScale);

      return { hit: true, distance: dist, spreadMeters, point: hitPoint };
    } else {
      // Ingen träff på figuren
      this.laserDotTop.visible = false;
      this.laserDotBottom.visible = false;
      return { hit: false };
    }
  }

  onResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const width = this.container.clientWidth || (this.container.parentElement ? this.container.parentElement.clientWidth : 0);
    const height = this.container.clientHeight || (this.container.parentElement ? this.container.parentElement.clientHeight : 0);
    if (width <= 0 || height <= 0) return;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, true);
  }
}
