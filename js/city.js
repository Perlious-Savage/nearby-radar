// The 3D city. Real OpenStreetMap footprints extruded to their real heights.
//
// Every building in the neighbourhood is merged into ONE BufferGeometry, so the
// whole skyline costs a single draw call instead of 341. Spot markers are an
// InstancedMesh for the same reason.
//
// Roof triangulation uses THREE.ShapeUtils from core, not the mergeGeometries
// addon, so there is nothing to vendor beyond three itself.

import * as THREE from '../vendor/three.module.min.js';

const UP = new THREE.Vector3(0, 1, 0);
const ease = t => 1 - Math.pow(1 - t, 3);

export class City {
  constructor(canvas, data) {
    this.data = data;
    this.spots = data.spots;
    this.onPick = () => {};

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d11);
    this.scene.fog = new THREE.FogExp2(0x0b0d11, 0.00035);

    this.camera = new THREE.PerspectiveCamera(46, 1, 1, 12000);

    // Orbit state. The camera always looks at `target`, from `orbit` radians
    // around it at `pitch` and `dist`. Everything animates these three numbers.
    this.target = new THREE.Vector3(0, 0, 0);
    this.orbit = 0.6;
    this.pitch = 0.60;
    this.dist = 1900;
    this.drift = true;
    this.tween = null;

    this.buildLights();
    this.buildGround();
    this.buildCity();
    this.buildMarkers();
    this.buildYou();

    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindInput(canvas);

    this.clock = new THREE.Clock();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x8fa6c4, 0x090b0f, 1.15));
    const key = new THREE.DirectionalLight(0xdfe8ff, 1.5);
    key.position.set(-600, 900, 420);
    this.scene.add(key);
    // Warm rim from the opposite side stops the towers reading as flat slabs.
    const rim = new THREE.DirectionalLight(0xff9d5c, 0.7);
    rim.position.set(700, 260, -560);
    this.scene.add(rim);
  }

  buildGround() {
    const g = new THREE.Mesh(
      new THREE.PlaneGeometry(9000, 9000),
      new THREE.MeshStandardMaterial({ color: 0x11141a, roughness: 1, metalness: 0 })
    );
    g.rotation.x = -Math.PI / 2;
    g.position.y = -0.5;
    this.scene.add(g);

    // Range rings at 250 m intervals, centred on the user. Keeps the radar
    // reading from v1 and gives the eye a distance scale.
    this.rings = new THREE.Group();
    for (let r = 250; r <= 1000; r += 250) {
      const pts = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0.6, Math.sin(a) * r));
      }
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x2b3442, transparent: true, opacity: 0.55 })
      );
      this.rings.add(line);
    }
    this.scene.add(this.rings);
  }

  // Flat [height, x0,z0, x1,z1, ...] arrays into one merged mesh.
  buildCity() {
    const pos = [];
    const norm = [];
    const col = [];
    const base = new THREE.Color();

    for (const b of this.data.buildings) {
      const h = b[0];
      const n = (b.length - 1) / 2;
      if (n < 3) continue;

      const ring = [];
      for (let i = 0; i < n; i++) ring.push(new THREE.Vector2(b[1 + i * 2], b[2 + i * 2]));

      // Normalise winding to counter-clockwise so wall normals face outward.
      let area = 0;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        area += p.x * q.y - q.x * p.y;
      }
      if (area < 0) ring.reverse();

      // Taller towers sit slightly cooler and lighter, which reads as haze and
      // separates the skyline from the podium blocks without any post-process.
      const t = Math.min(h / 260, 1);
      base.setHSL(0.60 - t * 0.03, 0.10 + t * 0.05, 0.13 + t * 0.16);

      // Walls.
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const dx = q.x - p.x, dz = q.y - p.y;
        const len = Math.hypot(dx, dz) || 1;
        const nx = dz / len, nz = -dx / len;
        const quad = [
          [p.x, 0, p.y], [q.x, 0, q.y], [q.x, h, q.y],
          [p.x, 0, p.y], [q.x, h, q.y], [p.x, h, p.y],
        ];
        for (const [x, y, z] of quad) {
          pos.push(x, y, z);
          norm.push(nx, 0, nz);
          // Vertical shade: darker at the base, so towers have grounding.
          const k = 0.55 + 0.45 * (y / Math.max(h, 1));
          col.push(base.r * k, base.g * k, base.b * k);
        }
      }

      // Roof, triangulated with core ShapeUtils.
      const tris = THREE.ShapeUtils.triangulateShape(ring, []);
      for (const [a, bi, c] of tris) {
        for (const idx of [a, bi, c]) {
          pos.push(ring[idx].x, h, ring[idx].y);
          norm.push(0, 1, 0);
          col.push(base.r * 1.18, base.g * 1.18, base.b * 1.18);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.cityMesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.04 })
    );
    this.scene.add(this.cityMesh);
    this.triangles = pos.length / 9;
  }

  buildMarkers() {
    const geo = new THREE.CylinderGeometry(5, 5, 1, 10, 1, true);
    geo.translate(0, 0.5, 0); // pivot at the base so scale.y grows upward
    const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.92 });
    this.markers = new THREE.InstancedMesh(geo, mat, this.spots.length);
    this.markers.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.spots.length * 3), 3
    );
    this.scene.add(this.markers);

    // Caps sit on top of each pillar so a marker still reads at a distance.
    const capGeo = new THREE.SphereGeometry(9, 12, 8);
    this.caps = new THREE.InstancedMesh(
      capGeo,
      new THREE.MeshBasicMaterial({}),
      this.spots.length
    );
    this.caps.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.spots.length * 3), 3
    );
    this.scene.add(this.caps);

    this.pulse = new Map(); // spot id -> seconds remaining
    this.heights = new Float32Array(this.spots.length).fill(40);
    this.updateMarkers({}, null);
  }

  buildYou() {
    this.you = new THREE.Mesh(
      new THREE.ConeGeometry(13, 34, 4),
      new THREE.MeshBasicMaterial({ color: 0x6ee7b7 })
    );
    this.you.rotation.x = Math.PI;
    this.you.position.y = 60;
    this.scene.add(this.you);
  }

  // heat: {spotId: pinCount}. saved: Set of ids. Called whenever state changes.
  updateMarkers(heat, savedSet) {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const KIND = { food: 0xffb257, cafe: 0x8ad4ff, bar: 0xd08bff, event: 0x6ee7b7, shop: 0xffe066 };

    this.spots.forEach((s, i) => {
      const pins = heat[s.id] || 0;
      const h = 40 + pins * 26;
      this.heights[i] = h;

      m.makeScale(1, h, 1);
      m.setPosition(s.x, 0, s.z);
      this.markers.setMatrixAt(i, m);

      const cap = new THREE.Matrix4().makeTranslation(s.x, h, s.z);
      this.caps.setMatrixAt(i, cap);

      c.set(KIND[s.kind] ?? 0x9aa6b8);
      if (savedSet?.has(s.id)) c.offsetHSL(0, 0.15, 0.12);
      const boost = this.pulse.has(s.id) ? 1.9 : pins ? 1.25 : 0.75;
      this.markers.setColorAt(i, c.clone().multiplyScalar(boost));
      this.caps.setColorAt(i, c.clone().multiplyScalar(boost * 1.1));
    });

    this.markers.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    if (this.caps.instanceColor) this.caps.instanceColor.needsUpdate = true;
  }

  ping(spotId) {
    this.pulse.set(spotId, 1.6);
  }

  setYou(x, z) {
    this.you.position.set(x, 60, z);
    this.rings.position.set(x, 0, z);
  }

  flyTo(spot) {
    this.drift = false;
    this.tween = {
      t: 0,
      dur: 1.25,
      from: { target: this.target.clone(), orbit: this.orbit, pitch: this.pitch, dist: this.dist },
      to: {
        target: new THREE.Vector3(spot.x, 45, spot.z),
        orbit: this.orbit + 0.85,
        pitch: 0.28,
        dist: 320,
      },
    };
  }

  pullBack() {
    this.tween = {
      t: 0,
      dur: 1.1,
      from: { target: this.target.clone(), orbit: this.orbit, pitch: this.pitch, dist: this.dist },
      to: {
        target: new THREE.Vector3(this.you.position.x, 0, this.you.position.z),
        orbit: this.orbit + 0.4,
        pitch: 0.60,
        dist: 1900,
      },
    };
    setTimeout(() => { this.drift = true; }, 1200);
  }

  bindInput(canvas) {
    let dragging = false, lastX = 0, lastY = 0, moved = 0;

    const down = e => {
      dragging = true; moved = 0;
      lastX = e.clientX; lastY = e.clientY;
      this.drift = false;
      this.tween = null;
    };
    const move = e => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      this.orbit -= dx * 0.005;
      this.pitch = Math.max(0.08, Math.min(1.25, this.pitch + dy * 0.004));
      lastX = e.clientX; lastY = e.clientY;
    };
    const up = e => {
      if (dragging && moved < 6) this.pick(e, canvas);
      dragging = false;
    };

    canvas.addEventListener('pointerdown', down);
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.drift = false;
      this.dist = Math.max(180, Math.min(2600, this.dist * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });
  }

  pick(e, canvas) {
    const r = canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.pointer, this.camera);

    for (const mesh of [this.caps, this.markers]) {
      const hit = this.ray.intersectObject(mesh)[0];
      if (hit && hit.instanceId != null) {
        this.onPick(this.spots[hit.instanceId], null);
        return;
      }
    }
    // Nothing hit: report the ground point so the app can move the user there.
    const plane = new THREE.Plane(UP, 0);
    const at = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(plane, at)) this.onPick(null, at);
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 1, h = c.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.tween) {
      this.tween.t += dt;
      const k = ease(Math.min(this.tween.t / this.tween.dur, 1));
      const { from, to } = this.tween;
      this.target.lerpVectors(from.target, to.target, k);
      this.orbit = from.orbit + (to.orbit - from.orbit) * k;
      this.pitch = from.pitch + (to.pitch - from.pitch) * k;
      this.dist = from.dist + (to.dist - from.dist) * k;
      if (this.tween.t >= this.tween.dur) this.tween = null;
    } else if (this.drift) {
      this.orbit += dt * 0.028;
    }

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.orbit) * this.dist * cp,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.orbit) * this.dist * cp
    );
    this.camera.lookAt(this.target);

    // Pings decay; markers repaint only while something is actually pulsing.
    if (this.pulse.size) {
      let dirty = false;
      for (const [id, left] of this.pulse) {
        const next = left - dt;
        if (next <= 0) { this.pulse.delete(id); dirty = true; } else this.pulse.set(id, next);
      }
      const t = performance.now() / 1000;
      this.markers.material.opacity = 0.92;
      this.caps.material.opacity = 1;
      this.you.position.y = 60 + Math.sin(t * 3) * 5;
      if (dirty) this.repaint?.();
    }

    this.renderer.render(this.scene, this.camera);
  }
}
