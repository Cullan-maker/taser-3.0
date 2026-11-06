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
    this.scene.background = new THREE.Color(0x0a0a0a);

    const width = this.container.clientWidth || 320;
    const height = this.container.clientHeight || 320;

    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);

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

    // Window resize observer
    window.addEventListener('resize', this.onResize.bind(this));
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

  loadGLBMannequin() {
    const loader = new GLTFLoader();
    loader.load(
      '/ue_mannequin_retopology.glb',
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

        dummy.traverse((child) => {
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

        this.taserGroup.add(dummy);
        if (this.dummyBody) this.dummyBody.visible = false;
        console.log('[TaserScene] UE Mannequin retopology 3D model loaded successfully.');
      },
      undefined,
      (err) => {
        console.warn('[TaserScene] GLB model not found or failed, using composite procedural mannequin:', err);
      }
    );
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

    // Raycast top dart
    this.raycaster.setFromCamera(new THREE.Vector2(ndc1.x, ndc1.y), activeCamera);
    this.raycaster.ray.direction.x += (Math.random() - 0.5) * 0.005;
    this.raycaster.ray.direction.y += (Math.random() - 0.5) * 0.005;
    let hits1 = this.raycaster.intersectObject(this.taserGroup, true);
    let hitWall1 = false;
    if (hits1.length === 0) {
      hits1 = this.raycaster.intersectObject(this.placementGround, true);
      hitWall1 = true;
    }

    // Raycast bottom dart
    this.raycaster.setFromCamera(new THREE.Vector2(ndc2.x, ndc2.y), activeCamera);
    this.raycaster.ray.direction.x += (Math.random() - 0.5) * 0.005;
    this.raycaster.ray.direction.y += (Math.random() - 0.5) * 0.005;
    let hits2 = this.raycaster.intersectObject(this.taserGroup, true);
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

      const attachGroup1 = hitWall1 ? this.scene : this.taserGroup;
      const d1 = new THREE.Mesh(dartGeo, dartMat);
      d1.position.copy(attachGroup1.worldToLocal(hit1.point.clone()));
      d1.lookAt(attachGroup1.worldToLocal(activeCamera.position.clone()));
      attachGroup1.add(d1);
      this.activeDarts.push(d1);

      const attachGroup2 = hitWall2 ? this.scene : this.taserGroup;
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
